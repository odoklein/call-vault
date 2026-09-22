// ============================================
// REDIS / BULLMQ CONNECTION
// Same pattern as captainprospect-crm's lib/email/queue/index.ts —
// reused here deliberately so ops already familiar with that queue
// recognize this one.
// ============================================

import Redis, { type RedisOptions } from "ioredis";

export const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null as null, // required by BullMQ's blocking connections
};

const REDIS_CHECK_OPTIONS = {
  ...REDIS_CONFIG,
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  connectTimeout: 2000,
  retryStrategy: () => null,
};

let redisAvailable = true;
let redisCheckPromise: Promise<void> | null = null;

/** One-time Redis connectivity check so we fail fast instead of retry-spamming ECONNREFUSED. */
export function checkRedisOnce(): Promise<void> {
  if (redisCheckPromise !== null) return redisCheckPromise;
  redisCheckPromise = (async () => {
    const client = new Redis(REDIS_CHECK_OPTIONS as RedisOptions);
    client.on("error", () => {});
    try {
      await client.ping();
    } catch {
      redisAvailable = false;
      console.warn(
        "[call-vault][queue] Redis not reachable — sync/webhook queues are disabled until it is. " +
          "Set REDIS_HOST/REDIS_PORT/REDIS_PASSWORD.",
      );
    } finally {
      client.disconnect();
    }
  })();
  return redisCheckPromise;
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}
