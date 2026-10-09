// ============================================
// RECORDING MIRROR QUEUE
// Downloads provider audio into our storage, off the sync path: a slow 60s media download used to
// sit inside the single sync job and hold up every other line. Retries with backoff, and a periodic
// sweep re-enqueues anything left PENDING (lost job, worker restart) so no recording is forgotten.
// ============================================

import { Queue, Worker, type Job } from "bullmq";
import { REDIS_CONFIG, isRedisAvailable } from "./redis";
import { prisma } from "../db";
import { mirrorRecording } from "../audio/mirror-recording";
import { getRecordingAuthHeaders, recordingUrlFromPayload } from "../providers/recordings";

const QUEUE_NAME = "vault-recording-mirror";
const ATTEMPTS = Math.max(1, parseInt(process.env.RECORDING_MIRROR_ATTEMPTS ?? "6", 10) || 6);
const SWEEP_STALE_MS = 10 * 60_000;

type MirrorJob = { callId: string } | { sweep: true };

let queue: Queue<MirrorJob> | null = null;

function getQueue(): Queue<MirrorJob> {
  if (!isRedisAvailable()) throw new Error("Queue unavailable: Redis not connected");
  if (!queue) {
    queue = new Queue<MirrorJob>(QUEUE_NAME, {
      connection: REDIS_CONFIG,
      defaultJobOptions: {
        attempts: ATTEMPTS,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: true, // frees the jobId so a later re-mirror isn't deduped away
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return queue;
}

/** Enqueue one mirror job per call, deduped by call id. */
export async function enqueueRecordingMirrors(callIds: string[]): Promise<void> {
  if (callIds.length === 0) return;
  const q = getQueue();
  for (const callId of new Set(callIds)) {
    const jobId = `mirror-${callId}`;
    const existing = await q.getJob(jobId);
    if (existing && (await existing.isFailed())) await existing.remove(); // allow a fresh attempt
    await q.add("mirror", { callId }, { jobId });
  }
}

export async function scheduleRecordingSweep(): Promise<void> {
  await getQueue().upsertJobScheduler("recording-sweep", { every: SWEEP_STALE_MS }, { name: "sweep", data: { sweep: true } });
}

async function sweep(): Promise<{ requeued: number }> {
  const stale = await prisma.call.findMany({
    where: { recordingStatus: "PENDING", updatedAt: { lt: new Date(Date.now() - SWEEP_STALE_MS) } },
    select: { id: true },
    take: 500,
  });
  await enqueueRecordingMirrors(stale.map((c) => c.id));
  return { requeued: stale.length };
}

async function mirrorOne(job: Job<MirrorJob>, callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { provider: true } });
  if (!call || call.recordingStatus === "STORED") return { skipped: true };

  const url = recordingUrlFromPayload(call.provider.slug, call.rawPayload);
  if (!url) {
    await prisma.call.update({ where: { id: call.id }, data: { recordingStatus: "NONE" } });
    return { skipped: true, reason: "no_url" };
  }

  const mirrored = await mirrorRecording({
    recordingUrl: url,
    providerSlug: call.provider.slug,
    callId: call.id,
    headers: getRecordingAuthHeaders(call.provider.slug),
  });
  if (mirrored) {
    await prisma.call.update({ where: { id: call.id }, data: { recordingKey: mirrored.key, recordingStatus: "STORED" } });
    return { stored: mirrored.key };
  }

  const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  if (lastAttempt) {
    // Visible and countable on the dashboard; scripts/remirror-recordings.ts can retry later.
    await prisma.call.update({ where: { id: call.id }, data: { recordingStatus: "FAILED" } });
  }
  throw new Error(`mirror failed callId=${call.id} attempt=${job.attemptsMade + 1}`);
}

export function createRecordingMirrorWorker(): Worker<MirrorJob> {
  const worker = new Worker<MirrorJob>(
    QUEUE_NAME,
    async (job) => ("sweep" in job.data ? sweep() : mirrorOne(job, job.data.callId)),
    {
      connection: REDIS_CONFIG,
      // Media downloads hit the same provider account as the list API — keep them gentle so they
      // never eat into the sync's rate budget.
      concurrency: Math.max(1, parseInt(process.env.RECORDING_MIRROR_CONCURRENCY ?? "1", 10) || 1),
      limiter: { max: 1, duration: Math.max(250, parseInt(process.env.RECORDING_MIRROR_MIN_INTERVAL_MS ?? "2000", 10) || 2000) },
    },
  );
  worker.on("failed", (job, error) => {
    console.warn(`[call-vault][recordings] job ${job?.id} failed: ${error.message}`);
  });
  return worker;
}
