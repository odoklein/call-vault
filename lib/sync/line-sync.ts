// One sync run for one line: an incremental pass (newest calls + lookback window), then — if a
// history backfill is pending — one bounded backfill step. Run by the sync queue worker.

import { prisma } from "../db";
import type { PollableCallProvider } from "../providers/types";
import { persistCalls } from "./persist";
import {
  afterBackfill,
  afterIncremental,
  backfillActive,
  planIncremental,
  walkPages,
  type CursorState,
  type SyncConfig,
} from "./walk";

export interface LineSyncResult {
  incremental: { pages: number; calls: number; deep: boolean; gap: boolean };
  backfill: { pages: number; calls: number; done: boolean } | null;
  toMirror: string[];
}

export async function syncLineOnce(params: {
  provider: PollableCallProvider;
  providerId: string;
  line: { id: string; externalNumber: string };
  config: SyncConfig;
}): Promise<LineSyncResult> {
  const { provider, providerId, line, config } = params;
  const cursorKey = { providerId_lineId: { providerId, lineId: line.id } };
  const toMirror: string[] = [];

  const row = await prisma.syncCursor.findUnique({ where: cursorKey });
  let cursor: CursorState | null = row
    ? {
        lastSyncedAt: row.lastSyncedAt,
        lastDeepSweepAt: row.lastDeepSweepAt,
        backfillUntil: row.backfillUntil,
        backfillNextPage: row.backfillNextPage,
        backfillDoneAt: row.backfillDoneAt,
      }
    : null;

  const fetchPage = (page: number) => provider.fetchPage(line.externalNumber, page);
  const onPage = async (calls: Parameters<typeof persistCalls>[0]["calls"]) => {
    const r = await persistCalls({ providerId, lineId: line.id, calls });
    toMirror.push(...r.toMirror);
  };

  // 1. Incremental pass.
  const now = new Date();
  const plan = planIncremental(cursor, now, config);
  const inc = await walkPages({ fetchPage, onPage, startPage: 0, maxPages: config.maxPages, stopBefore: plan.stopBefore });
  const incUpdate = afterIncremental(cursor, inc, plan, now);
  await prisma.syncCursor.upsert({
    where: cursorKey,
    create: { providerId, lineId: line.id, ...incUpdate, lastError: null },
    update: { ...incUpdate, lastError: null },
  });
  cursor = { ...(cursor ?? emptyCursor()), ...incUpdate };

  const result: LineSyncResult = {
    incremental: {
      pages: inc.pagesFetched,
      calls: inc.callsSeen,
      deep: plan.deep,
      gap: !inc.reachedBoundary && !inc.reachedEnd,
    },
    backfill: null,
    toMirror,
  };

  // 2. One bounded backfill step (history import, or closing a page-cap gap).
  if (backfillActive(cursor)) {
    const bf = await walkPages({
      fetchPage,
      onPage,
      startPage: cursor.backfillNextPage ?? 0,
      maxPages: config.backfillPagesPerRun,
      stopBefore: cursor.backfillUntil,
    });
    const bfUpdate = afterBackfill(bf, new Date());
    await prisma.syncCursor.update({ where: cursorKey, data: bfUpdate });
    result.backfill = { pages: bf.pagesFetched, calls: bf.callsSeen, done: !!bfUpdate.backfillDoneAt };
  }

  return result;
}

function emptyCursor(): CursorState {
  return { lastSyncedAt: null, lastDeepSweepAt: null, backfillUntil: null, backfillNextPage: null, backfillDoneAt: null };
}
