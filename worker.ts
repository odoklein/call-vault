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
// Usage: npm run worker   (== tsx worker.ts)
// ============================================

import "dotenv/config";
import { checkRedisOnce, isRedisAvailable } from "./lib/queue/redis";
import { createAlloSyncWorker, scheduleAlloRepeatingSyncs } from "./lib/queue/allo-sync";

async function main() {
  await checkRedisOnce();
  if (!isRedisAvailable()) {
    console.error("[call-vault][worker] Redis unreachable at boot — fix REDIS_HOST/PORT and restart.");
    process.exit(1);
  }

  console.log("[call-vault][worker] starting...");

  createAlloSyncWorker();
  await scheduleAlloRepeatingSyncs();

  console.log("[call-vault][worker] running. Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[call-vault][worker] fatal error", err);
  process.exit(1);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
