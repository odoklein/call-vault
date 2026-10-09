import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterBackfill,
  afterIncremental,
  backfillActive,
  planIncremental,
  walkPages,
  type CursorState,
  type SyncConfig,
} from "../lib/sync/walk";
import type { NormalizedCall, ProviderPage } from "../lib/providers/types";

const MIN = 60_000;
const NOW = new Date("2026-10-09T12:00:00Z");

const config: SyncConfig = {
  lookbackMs: 360 * MIN,
  deepLookbackMs: 72 * 60 * MIN,
  deepSweepEveryMs: 24 * 60 * MIN,
  maxPages: 3,
  backfillPagesPerRun: 2,
};

function call(id: string, minutesAgo: number): NormalizedCall {
  return {
    providerCallId: id,
    direction: "OUTBOUND",
    fromNumber: "+33600000001",
    toNumber: "+33611111111",
    durationSec: 30,
    startedAt: new Date(NOW.getTime() - minutesAgo * MIN),
    raw: { id },
  };
}

/** A fake provider: `calls` newest-first, paginated by `size`. */
function fakeProvider(calls: NormalizedCall[], size: number) {
  const fetched: number[] = [];
  const fetchPage = async (page: number): Promise<ProviderPage> => {
    fetched.push(page);
    return { calls: calls.slice(page * size, page * size + size), totalPages: Math.max(1, Math.ceil(calls.length / size)) };
  };
  return { fetchPage, fetched };
}

const cursor = (over: Partial<CursorState> = {}): CursorState => ({
  lastSyncedAt: null,
  lastDeepSweepAt: NOW, // not due for a deep sweep unless a test says so
  backfillUntil: null,
  backfillNextPage: null,
  backfillDoneAt: null,
  ...over,
});

test("stops at the first page that reaches past the lookback boundary", async () => {
  // 10 calls, 10 min apart, 2 per page. Boundary 35 min ago -> pages 0,1 (0..30 min) then page 2 has 40 min.
  const calls = Array.from({ length: 10 }, (_, i) => call(`c${i}`, i * 10));
  const p = fakeProvider(calls, 2);
  const persisted: string[] = [];
  const r = await walkPages({
    fetchPage: p.fetchPage,
    onPage: async (cs) => void persisted.push(...cs.map((c) => c.providerCallId)),
    startPage: 0,
    maxPages: 20,
    stopBefore: new Date(NOW.getTime() - 35 * MIN),
  });
  assert.deepEqual(p.fetched, [0, 1, 2]);
  assert.equal(r.reachedBoundary, true);
  assert.equal(r.reachedEnd, false);
  assert.deepEqual(persisted, ["c0", "c1", "c2", "c3", "c4", "c5"]);
  assert.equal(r.newestStartedAt?.getTime(), calls[0].startedAt!.getTime());
});

test("re-reads calls inside the lookback window, so a transcript that arrives late is captured", async () => {
  // Run 1 saw c0 at 1 min old (no transcript yet). Run 2, 30 min later, must re-read it.
  const prev = cursor({ lastSyncedAt: new Date(NOW.getTime() - 1 * MIN) });
  const plan = planIncremental(prev, new Date(NOW.getTime() + 30 * MIN), config);
  assert.equal(plan.deep, false);
  assert.ok(plan.stopBefore < prev.lastSyncedAt!, "boundary sits before the cursor");

  const late = { ...call("c0", 1), transcription: "USER: bonjour" };
  const p = fakeProvider([late, call("older", 400)], 10);
  const seen: NormalizedCall[] = [];
  await walkPages({ fetchPage: p.fetchPage, onPage: async (cs) => void seen.push(...cs), startPage: 0, maxPages: 3, stopBefore: plan.stopBefore });
  assert.equal(seen.find((c) => c.providerCallId === "c0")?.transcription, "USER: bonjour");
});

test("deep sweep uses the long lookback once a day", () => {
  const due = planIncremental(cursor({ lastSyncedAt: NOW, lastDeepSweepAt: new Date(NOW.getTime() - 25 * 60 * MIN) }), NOW, config);
  assert.equal(due.deep, true);
  assert.equal(NOW.getTime() - due.stopBefore.getTime(), config.deepLookbackMs);

  const fresh = planIncremental(cursor({ lastSyncedAt: NOW }), NOW, config);
  assert.equal(fresh.deep, false);
  assert.equal(NOW.getTime() - fresh.stopBefore.getTime(), config.lookbackMs);
});

test("page cap hit before the boundary hands the rest to backfill instead of skipping it", async () => {
  // Old code advanced the cursor to the newest call here, silently skipping pages 3..N forever.
  const calls = Array.from({ length: 20 }, (_, i) => call(`c${i}`, i)); // all within lookback
  const p = fakeProvider(calls, 2);
  const prev = cursor({ lastSyncedAt: new Date(NOW.getTime() - 2 * MIN) });
  const plan = planIncremental(prev, NOW, config);
  const r = await walkPages({ fetchPage: p.fetchPage, onPage: async () => {}, startPage: 0, maxPages: config.maxPages, stopBefore: plan.stopBefore });
  assert.equal(r.reachedBoundary, false);
  assert.equal(r.reachedEnd, false);

  const update = afterIncremental(prev, r, plan, NOW);
  assert.equal(update.backfillUntil?.getTime(), plan.stopBefore.getTime());
  assert.equal(update.backfillNextPage, 3);
  assert.equal(update.backfillDoneAt, null);
  assert.ok(backfillActive({ ...prev, ...update } as CursorState));
});

test("a gap during an active history backfill keeps the older target and the lower page", () => {
  const prev = cursor({
    lastSyncedAt: NOW,
    backfillUntil: new Date("2026-09-08T00:00:00Z"),
    backfillNextPage: 40,
  });
  const plan = { stopBefore: new Date(NOW.getTime() - 360 * MIN), deep: false };
  const capped = { pagesFetched: 3, nextPage: 3, reachedBoundary: false, reachedEnd: false, callsSeen: 300, newestStartedAt: NOW };
  const update = afterIncremental(prev, capped, plan, NOW);
  assert.equal(update.backfillUntil?.toISOString(), "2026-09-08T00:00:00.000Z");
  assert.equal(update.backfillNextPage, 3);
});

test("history backfill resumes page by page and completes at the target date", async () => {
  const calls = Array.from({ length: 12 }, (_, i) => call(`c${i}`, i * 60 * 24)); // one per day
  const p = fakeProvider(calls, 2);
  const until = new Date(NOW.getTime() - 9 * 24 * 60 * MIN);

  let state = cursor({ backfillUntil: until, backfillNextPage: 0 });
  const pagesPerStep: number[][] = [];
  while (backfillActive(state)) {
    const before = p.fetched.length;
    const r = await walkPages({ fetchPage: p.fetchPage, onPage: async () => {}, startPage: state.backfillNextPage ?? 0, maxPages: 2, stopBefore: until });
    pagesPerStep.push(p.fetched.slice(before));
    state = { ...state, ...afterBackfill(r, NOW) };
  }
  assert.deepEqual(pagesPerStep, [[0, 1], [2, 3], [4, 5]]);
  assert.equal(state.backfillNextPage, null);
  assert.ok(state.backfillDoneAt);
});

test("an error mid-walk keeps earlier pages and does not advance the cursor", async () => {
  const persisted: string[] = [];
  const fetchPage = async (page: number): Promise<ProviderPage> => {
    if (page === 1) throw new Error("Allo API error status=500");
    return { calls: [call("c0", 0), call("c1", 1)], totalPages: 5 };
  };
  await assert.rejects(
    walkPages({ fetchPage, onPage: async (cs) => void persisted.push(...cs.map((c) => c.providerCallId)), startPage: 0, maxPages: 5, stopBefore: null }),
    /status=500/,
  );
  assert.deepEqual(persisted, ["c0", "c1"]);
  // afterIncremental is never reached on a throw — line-sync.ts writes the cursor only after a walk returns.
});

test("cursor never moves backwards", () => {
  const prev = cursor({ lastSyncedAt: NOW });
  const older = { pagesFetched: 1, nextPage: 1, reachedBoundary: true, reachedEnd: false, callsSeen: 1, newestStartedAt: new Date(NOW.getTime() - MIN) };
  const update = afterIncremental(prev, older, { stopBefore: NOW, deep: false }, NOW);
  assert.equal(update.lastSyncedAt?.getTime(), NOW.getTime());
});
