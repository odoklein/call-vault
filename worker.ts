// ============================================
// STANDALONE WORKER PROCESS
//
// Run this as its own always-on process (Railway/Fly/Render "worker" service, a small VPS,
// systemd unit, whatever) — separate from the Next.js app, which can stay serverless/anything.
// This file is the ONE process allowed to talk to WithAllo (and, as adapters are added, the other
// providers): a single BullMQ worker with concurrency=1 + a global limiter, enforced by Redis
// rather than by hoping every instance agrees. That's what makes 429s structurally impossible
// instead of just "less likely."
//
// Queues:
//   vault-allo-sync         per-line incremental sync + lookback + history backfill
//   vault-recording-mirror  provider audio -> our storage, with retries + a stale-PENDING sweep
//   vault-crm-sync          CRM SDR lines + CALL actions (read-only) -> matcher (if CRM_DATABASE_URL)
//
// Usage: npm run worker   (== tsx worker.ts)
// ============================================

import "dotenv/config";
import type { Worker } from "bullmq";
import { checkRedisOnce, isRedisAvailable } from "./lib/queue/redis";
import { createAlloSyncWorker, reconcileAlloLineSchedules } from "./lib/queue/allo-sync";
import { createRecordingMirrorWorker, scheduleRecordingSweep } from "./lib/queue/recording-mirror";
import { createCrmSyncWorker, scheduleCrmSync } from "./lib/queue/crm-sync";

const workers: Worker[] = [];

async function main() {
  await checkRedisOnce();
  if (!isRedisAvailable()) {
    console.error("[call-vault][worker] Redis unreachable at boot — fix REDIS_HOST/PORT and restart.");
    process.exit(1);
  }

  console.log("[call-vault][worker] starting...");

  workers.push(createAlloSyncWorker(), createRecordingMirrorWorker(), createCrmSyncWorker());

  const schedules = await reconcileAlloLineSchedules();
  console.log(`[call-vault][allo] ${schedules.active} line(s) scheduled on "${process.env.ALLO_SYNC_CRON ?? "*/2 * * * *"}"`);
  await scheduleRecordingSweep();
  if (!(await scheduleCrmSync())) {
    console.warn("[call-vault][crm] CRM_DATABASE_URL not set — no CRM linking, no line auto-provisioning.");
  }

  console.log("[call-vault][worker] running. Ctrl+C to stop.");
}

async function shutdown() {
  // Let in-flight jobs finish (or hand them back to Redis) instead of killing them mid-write.
  await Promise.allSettled(workers.map((w) => w.close()));
  process.exit(0);
}

main().catch((err) => {
  console.error("[call-vault][worker] fatal error", err);
  process.exit(1);
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
