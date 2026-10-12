// ============================================
// CRM LINK QUEUE
// Every CRM_SYNC_EVERY_MINUTES: refresh SDR -> line ownership (and provision missing lines), make
// sure every active line has a sync schedule, mirror new CALL actions, then run the matcher (CRM data
// comes from CRM_API_URL/CRM_API_KEY, else CRM_DATABASE_URL). One
// repeatable job, concurrency 1 — each step reads what the previous one wrote.
// ============================================

import { Queue, Worker } from "bullmq";
import { REDIS_CONFIG, isRedisAvailable } from "./redis";
import { prisma } from "../db";
import { getCrmSource } from "../crm/source";
import { syncCrmActions, syncSdrLines } from "../crm/directory-sync";
import { runMatcher } from "../linking/run-matcher";
import { reconcileAlloLineSchedules } from "./allo-sync";

const QUEUE_NAME = "vault-crm-sync";

let queue: Queue | null = null;

function getQueue(): Queue {
  if (!isRedisAvailable()) throw new Error("Queue unavailable: Redis not connected");
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: REDIS_CONFIG,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { age: 24 * 3600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return queue;
}

/** Returns false (and schedules nothing) when CRM_DATABASE_URL isn't configured. */
export async function scheduleCrmSync(): Promise<boolean> {
  if (!getCrmSource()) return false;
  const minutes = Math.max(1, parseInt(process.env.CRM_SYNC_EVERY_MINUTES ?? "5", 10) || 5);
  await getQueue().upsertJobScheduler("crm-sync", { every: minutes * 60_000 }, { name: "crm-sync", data: {} });
  return true;
}

const STATUS_KEY = "crm.sync.status";

async function recordStatus(value: { ok: boolean; source: string; error?: string }) {
  const v = { at: new Date().toISOString(), ...value };
  await prisma.syncState.upsert({ where: { key: STATUS_KEY }, create: { key: STATUS_KEY, value: v }, update: { value: v } });
}

export async function runCrmSyncOnce() {
  const source = getCrmSource();
  if (!source) return { skipped: "neither CRM_API_URL + CRM_API_KEY nor CRM_DATABASE_URL is set" };
  try {
    const result = await syncFromCrm(source);
    await recordStatus({ ok: true, source: source.describe() });
    return result;
  } catch (e) {
    // Visible on the dashboard / coverage report: an expired CRM key must not fail silently.
    await recordStatus({ ok: false, source: source.describe(), error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function syncFromCrm(crm: NonNullable<ReturnType<typeof getCrmSource>>) {
  const lines = await syncSdrLines(crm);
  if (lines.conflicts.length) {
    console.warn(`[call-vault][crm] Allo number held by several active CRM users, left unowned: ${lines.conflicts.join(", ")}`);
  }
  if (lines.provisioned.length) {
    console.log(`[call-vault][crm] provisioned line(s) from CRM User.alloPhoneNumber: ${lines.provisioned.join(", ")}`);
  }
  const schedules = await reconcileAlloLineSchedules();
  const actions = await syncCrmActions(crm);
  const matcher = await runMatcher();
  return { lines, schedules, actions, matcher };
}

export function createCrmSyncWorker(): Worker {
  const worker = new Worker(QUEUE_NAME, () => runCrmSyncOnce(), { connection: REDIS_CONFIG, concurrency: 1 });
  worker.on("completed", (job, result) => console.log(`[call-vault][crm] job ${job.id} done`, JSON.stringify(result)));
  worker.on("failed", (job, error) => console.error(`[call-vault][crm] job ${job?.id} failed`, error.message));
  return worker;
}
