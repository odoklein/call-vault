// ============================================
// ALLO SYNC QUEUE
// One BullMQ queue, one worker, concurrency 1 + a global rate limiter — enforced by Redis, so it
// holds regardless of how many web/API instances are running. This is the actual fix for the
// 429s: a single process is the only thing ever allowed to call WithAllo.
// ============================================

import { Queue, Worker, type Job } from "bullmq";
import { REDIS_CONFIG, checkRedisOnce, isRedisAvailable } from "./redis";
import { prisma } from "../db";
import { alloProvider } from "../providers/allo/sync";
import { mirrorRecording } from "../audio/mirror-recording";
import { canExecute, recordFailure, recordSuccess } from "../circuit-breaker";

// BullMQ rejects colons in queue names outright — keep this alphanumeric/hyphen only.
const QUEUE_NAME = "vault-allo-sync";
const MAX_PAGES = Math.max(1, parseInt(process.env.ALLO_SYNC_MAX_PAGES ?? "20", 10));

interface AlloSyncJobData {
  lineId: string;
}

let queue: Queue<AlloSyncJobData> | null = null;

export function getAlloSyncQueue(): Queue<AlloSyncJobData> {
  if (!isRedisAvailable()) throw new Error("Queue unavailable: Redis not connected");
  if (!queue) {
    queue = new Queue<AlloSyncJobData>(QUEUE_NAME, {
      connection: REDIS_CONFIG,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return queue;
}

/** One repeatable job per active Allo line — set up once at worker boot. */
export async function scheduleAlloRepeatingSyncs(): Promise<void> {
  await checkRedisOnce();
  if (!isRedisAvailable()) return;

  const provider = await prisma.provider.findUnique({ where: { slug: "allo" } });
  if (!provider || !provider.isActive) {
    console.log("[call-vault][allo] provider inactive/missing — no sync jobs scheduled");
    return;
  }

  const lines = await prisma.line.findMany({ where: { providerId: provider.id, isActive: true } });
  const cronPattern = process.env.ALLO_SYNC_CRON ?? "*/2 * * * *";
  const q = getAlloSyncQueue();

  for (const line of lines) {
    await q.upsertJobScheduler(
      `allo-sync-${line.id}`,
      { pattern: cronPattern },
      { name: "sync-line", data: { lineId: line.id } },
    );
  }

  console.log(`[call-vault][allo] scheduled ${lines.length} line(s) on pattern "${cronPattern}"`);
}

export function createAlloSyncWorker(): Worker<AlloSyncJobData> {
  const worker = new Worker<AlloSyncJobData>(
    QUEUE_NAME,
    async (job: Job<AlloSyncJobData>) => {
      const line = await prisma.line.findUnique({ where: { id: job.data.lineId }, include: { provider: true } });
      if (!line || !line.isActive) return { skipped: true };

      const circuitKey = `${line.providerId}:${line.id}`;
      if (!canExecute(circuitKey)) {
        console.warn(`[call-vault][allo] circuit open for line=${line.externalNumber} — skipping this run`);
        return { skipped: true, reason: "circuit_open" };
      }

      const cursorRow = await prisma.syncCursor.findUnique({
        where: { providerId_lineId: { providerId: line.providerId, lineId: line.id } },
      });

      try {
        const result = await alloProvider.syncLine(
          { lineId: line.id, externalNumber: line.externalNumber, lastSyncedAt: cursorRow?.lastSyncedAt ?? null },
          MAX_PAGES,
        );

        for (const call of result.calls) {
          const savedCall = await prisma.call.upsert({
            where: { providerId_providerCallId: { providerId: line.providerId, providerCallId: call.providerCallId } },
            create: {
              providerId: line.providerId,
              providerCallId: call.providerCallId,
              direction: call.direction,
              fromNumber: call.fromNumber,
              toNumber: call.toNumber,
              status: call.status,
              startedAt: call.startedAt,
              durationSec: call.durationSec,
              transcription: call.transcription,
              aiSummary: call.summary,
              rawPayload: call.raw as object,
              recordingStatus: call.recordingUrl ? "PENDING" : "NONE",
            },
            update: {
              // Allo call content can arrive/settle after the call itself (summary/recording lag) —
              // re-apply on every sighting rather than only on first insert.
              status: call.status,
              transcription: call.transcription,
              aiSummary: call.summary,
              recordingStatus: call.recordingUrl ? "PENDING" : "NONE",
            },
          });

          if (call.recordingUrl && savedCall.recordingStatus !== "STORED") {
            const mirrored = await mirrorRecording({
              recordingUrl: call.recordingUrl,
              providerSlug: "allo",
              callId: savedCall.id,
            });
            await prisma.call.update({
              where: { id: savedCall.id },
              data: mirrored
                ? { recordingKey: mirrored.key, recordingStatus: "STORED" }
                : { recordingStatus: "FAILED" },
            });
          }
        }

        await prisma.syncCursor.upsert({
          where: { providerId_lineId: { providerId: line.providerId, lineId: line.id } },
          create: {
            providerId: line.providerId,
            lineId: line.id,
            lastSyncedAt: result.newLastSyncedAt,
            lastSyncAt: new Date(),
            lastError: null,
          },
          update: { lastSyncedAt: result.newLastSyncedAt, lastSyncAt: new Date(), lastError: null },
        });

        recordSuccess(circuitKey);
        return { newCalls: result.calls.length };
      } catch (err) {
        recordFailure(circuitKey);
        const message = err instanceof Error ? err.message : String(err);
        await prisma.syncCursor.upsert({
          where: { providerId_lineId: { providerId: line.providerId, lineId: line.id } },
          create: { providerId: line.providerId, lineId: line.id, lastSyncAt: new Date(), lastError: message },
          update: { lastSyncAt: new Date(), lastError: message },
        });
        throw err;
      }
    },
    {
      connection: REDIS_CONFIG,
      concurrency: 1, // one line at a time, globally — this is what actually stops the 429s
      limiter: { max: 1, duration: 1000 }, // max 1 line-sync started per second
    },
  );

  worker.on("completed", (job, result) => {
    console.log(`[call-vault][allo] job ${job.id} done`, result);
  });
  worker.on("failed", (job, error) => {
    console.error(`[call-vault][allo] job ${job?.id} failed`, error.message);
  });

  return worker;
}
