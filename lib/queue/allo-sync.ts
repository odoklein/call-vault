// ============================================
// ALLO SYNC QUEUE
// One BullMQ queue, one worker, concurrency 1 + a global rate limiter — enforced by Redis, so it
// holds regardless of how many web/API instances are running. This is the actual fix for the
// 429s: a single process is the only thing ever allowed to call WithAllo's list API.
// ============================================

import { Queue, Worker, type Job } from "bullmq";
import { REDIS_CONFIG, checkRedisOnce, isRedisAvailable } from "./redis";
import { prisma } from "../db";
import { alloProvider } from "../providers/allo/sync";
import { syncLineOnce } from "../sync/line-sync";
import { syncConfigFromEnv } from "../sync/walk";
import { enqueueRecordingMirrors } from "./recording-mirror";
import { canExecute, recordFailure, recordSuccess } from "../circuit-breaker";

// BullMQ rejects colons in queue names outright — keep this alphanumeric/hyphen only.
const QUEUE_NAME = "vault-allo-sync";
const SCHEDULER_PREFIX = "allo-sync-";
const SYNC_CONFIG = syncConfigFromEnv();

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

/**
 * Make the repeatable jobs match the active Allo lines in the DB: one scheduler per active line,
 * none for inactive/deleted ones. Idempotent — called at boot and after every CRM directory sync,
 * so a line auto-provisioned from a new SDR's Allo number starts syncing without a restart.
 */
export async function reconcileAlloLineSchedules(): Promise<{ active: number; removed: number }> {
  await checkRedisOnce();
  if (!isRedisAvailable()) return { active: 0, removed: 0 };

  const provider = await prisma.provider.findUnique({ where: { slug: "allo" } });
  const lines =
    provider && provider.isActive
      ? await prisma.line.findMany({ where: { providerId: provider.id, isActive: true }, select: { id: true } })
      : [];
  const cronPattern = process.env.ALLO_SYNC_CRON ?? "*/2 * * * *";
  const q = getAlloSyncQueue();

  const wanted = new Set(lines.map((l) => `${SCHEDULER_PREFIX}${l.id}`));
  for (const line of lines) {
    await q.upsertJobScheduler(`${SCHEDULER_PREFIX}${line.id}`, { pattern: cronPattern }, { name: "sync-line", data: { lineId: line.id } });
  }

  let removed = 0;
  for (const scheduler of await q.getJobSchedulers()) {
    const id = scheduler.key ?? scheduler.id;
    if (id && id.startsWith(SCHEDULER_PREFIX) && !wanted.has(id)) {
      await q.removeJobScheduler(id);
      removed += 1;
    }
  }

  return { active: lines.length, removed };
}

export function createAlloSyncWorker(): Worker<AlloSyncJobData> {
  const worker = new Worker<AlloSyncJobData>(
    QUEUE_NAME,
    async (job: Job<AlloSyncJobData>) => {
      const line = await prisma.line.findUnique({ where: { id: job.data.lineId } });
      if (!line || !line.isActive) return { skipped: true };

      const circuitKey = `${line.providerId}:${line.id}`;
      if (!canExecute(circuitKey)) {
        console.warn(`[call-vault][allo] circuit open for line=${line.externalNumber} — skipping this run`);
        return { skipped: true, reason: "circuit_open" };
      }

      try {
        const result = await syncLineOnce({ provider: alloProvider, providerId: line.providerId, line, config: SYNC_CONFIG });
        await enqueueRecordingMirrors(result.toMirror);
        if (result.incremental.gap) {
          console.warn(
            `[call-vault][allo] line=${line.externalNumber} hit the ${SYNC_CONFIG.maxPages}-page cap before its lookback ` +
              `boundary — remaining pages handed to backfill, nothing skipped`,
          );
        }
        recordSuccess(circuitKey);
        return {
          calls: result.incremental.calls,
          deep: result.incremental.deep,
          backfill: result.backfill,
          recordingsQueued: result.toMirror.length,
        };
      } catch (err) {
        recordFailure(circuitKey);
        const message = err instanceof Error ? err.message : String(err);
        await prisma.syncCursor.upsert({
          where: { providerId_lineId: { providerId: line.providerId, lineId: line.id } },
          create: { providerId: line.providerId, lineId: line.id, lastError: message },
          update: { lastError: message },
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
