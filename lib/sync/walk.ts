// Provider-agnostic page walker + cursor planning. Pure logic (I/O is injected), unit-tested in
// test/sync-walk.test.ts — this is where "never miss a call" is actually decided.
//
// Invariants:
//  * Each page is persisted (onPage) before the next is fetched, so an error on page N keeps
//    pages 0..N-1 and the cursor is simply not advanced — the next run repeats, idempotently.
//  * The walk only stops at a page that reaches *older* than `stopBefore`, or at the real end of
//    the list. Hitting the page cap first is reported as a gap, never silently treated as done.
//  * `stopBefore` sits a lookback window behind the cursor, so recent calls are re-read for a
//    while: transcript/summary/recording that the provider attaches after the call get picked up.

import type { NormalizedCall, ProviderPage } from "../providers/types";

export interface WalkParams {
  fetchPage: (page: number) => Promise<ProviderPage>;
  onPage: (calls: NormalizedCall[]) => Promise<void>;
  startPage: number;
  maxPages: number;
  /** Stop after the first page containing a call older than this. null = walk to the end. */
  stopBefore: Date | null;
}

export interface WalkResult {
  pagesFetched: number;
  /** Page index to resume from if this walk didn't finish. */
  nextPage: number;
  /** Saw a call older than stopBefore — everything newer has been read. */
  reachedBoundary: boolean;
  /** The provider has no more pages. */
  reachedEnd: boolean;
  callsSeen: number;
  newestStartedAt: Date | null;
}

export async function walkPages(params: WalkParams): Promise<WalkResult> {
  const { fetchPage, onPage, startPage, maxPages, stopBefore } = params;
  const result: WalkResult = {
    pagesFetched: 0,
    nextPage: startPage,
    reachedBoundary: false,
    reachedEnd: false,
    callsSeen: 0,
    newestStartedAt: null,
  };

  for (let page = startPage; page < startPage + maxPages; page++) {
    const { calls, totalPages } = await fetchPage(page);
    result.pagesFetched += 1;
    result.nextPage = page + 1;

    if (calls.length === 0) {
      result.reachedEnd = true;
      break;
    }

    // Persist the whole page, including calls past the boundary — re-upserting a few older calls
    // is harmless and keeps their content fresh.
    await onPage(calls);
    result.callsSeen += calls.length;

    for (const call of calls) {
      if (!call.startedAt) continue;
      if (!result.newestStartedAt || call.startedAt > result.newestStartedAt) result.newestStartedAt = call.startedAt;
      if (stopBefore && call.startedAt < stopBefore) result.reachedBoundary = true;
    }

    if (result.reachedBoundary) break;
    if (page + 1 >= totalPages) {
      result.reachedEnd = true;
      break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------------------------
// Cursor planning
// ---------------------------------------------------------------------------------------------

export interface SyncConfig {
  /** Normal lookback behind the cursor, re-read on every run. */
  lookbackMs: number;
  /** Longer lookback used once per deepSweepEveryMs, for content that settles very late. */
  deepLookbackMs: number;
  deepSweepEveryMs: number;
  maxPages: number;
  backfillPagesPerRun: number;
}

export interface CursorState {
  lastSyncedAt: Date | null;
  lastDeepSweepAt: Date | null;
  backfillUntil: Date | null;
  backfillNextPage: number | null;
  backfillDoneAt: Date | null;
}

export function planIncremental(cursor: CursorState | null, now: Date, config: SyncConfig): { stopBefore: Date; deep: boolean } {
  const deep = !cursor?.lastDeepSweepAt || now.getTime() - cursor.lastDeepSweepAt.getTime() >= config.deepSweepEveryMs;
  const anchor = cursor?.lastSyncedAt ?? now;
  const lookback = deep ? config.deepLookbackMs : config.lookbackMs;
  return { stopBefore: new Date(anchor.getTime() - lookback), deep };
}

export function backfillActive(cursor: CursorState | null): boolean {
  return !!cursor?.backfillUntil && !cursor.backfillDoneAt;
}

/** Cursor fields to write after an incremental walk. */
export function afterIncremental(
  cursor: CursorState | null,
  walk: WalkResult,
  plan: { stopBefore: Date; deep: boolean },
  now: Date,
): Partial<CursorState> & { lastSyncAt: Date } {
  const prev = cursor?.lastSyncedAt ?? null;
  const newest = walk.newestStartedAt;
  const lastSyncedAt = newest && (!prev || newest > prev) ? newest : prev;

  const update: Partial<CursorState> & { lastSyncAt: Date } = { lastSyncedAt, lastSyncAt: now };
  if (plan.deep) update.lastDeepSweepAt = now;

  if (!walk.reachedBoundary && !walk.reachedEnd) {
    // Page cap hit before reaching the lookback boundary: there are unread calls between
    // walk.nextPage and stopBefore. Hand them to the resumable backfill instead of skipping them.
    const active = backfillActive(cursor);
    const until = active && cursor!.backfillUntil! < plan.stopBefore ? cursor!.backfillUntil! : plan.stopBefore;
    const fromPage = active && cursor!.backfillNextPage != null ? Math.min(cursor!.backfillNextPage, walk.nextPage) : walk.nextPage;
    update.backfillUntil = until;
    update.backfillNextPage = fromPage;
    update.backfillDoneAt = null;
  }
  return update;
}

/** Cursor fields to write after one backfill step. */
export function afterBackfill(walk: WalkResult, now: Date): Partial<CursorState> {
  if (walk.reachedBoundary || walk.reachedEnd) {
    return { backfillDoneAt: now, backfillNextPage: null };
  }
  return { backfillNextPage: walk.nextPage };
}

export function syncConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const minutes = (name: string, fallback: number) => Math.max(1, parseInt(env[name] ?? String(fallback), 10) || fallback) * 60_000;
  return {
    lookbackMs: minutes("SYNC_LOOKBACK_MINUTES", 360),
    deepLookbackMs: minutes("SYNC_DEEP_LOOKBACK_MINUTES", 72 * 60),
    deepSweepEveryMs: minutes("SYNC_DEEP_SWEEP_EVERY_MINUTES", 24 * 60),
    maxPages: Math.max(1, parseInt(env.ALLO_SYNC_MAX_PAGES ?? "20", 10) || 20),
    backfillPagesPerRun: Math.max(1, parseInt(env.SYNC_BACKFILL_PAGES_PER_RUN ?? "5", 10) || 5),
  };
}
