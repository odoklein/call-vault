// Runs the pure matcher over the DB: CRM actions waiting for a call <-> vault calls not yet linked.
//
// Lifecycle of a CrmAction:
//   PENDING   -> just mirrored, or its SDR's line hasn't synced past the action time yet
//   MATCHED   -> callId set (never changed by later runs)
//   UNMATCHED -> the line has synced well past the action and no call fits; re-checked until the
//                retry window closes, in case a deep sweep brings the call in late
//   NO_PHONE  -> nothing to match on

import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { DEFAULT_MATCH_OPTIONS, matchActionsToCalls, type MatchableAction, type MatchableCall } from "./matcher";

const SETTLE_MS = 20 * 60_000; // let the SDR's line sync the call before trying
const LINE_SYNCED_PAST_MS = 2 * 60_000;
const UNMATCHED_AFTER_MS = 2 * 3600_000;
const RETRY_WINDOW_MS = 72 * 3600_000;
const MAX_CALL_DURATION_MS = 2 * 3600_000;
const CHUNK = 500;

export interface MatcherRunResult {
  considered: number;
  matched: number;
  unmatched: number;
  waitingForLine: number;
}

/**
 * `retryWindowMs` widens how far back actions are (re)considered — scripts/match-history.ts uses it
 * to link a month of history once; the scheduled job keeps the 72h default.
 */
export async function runMatcher(now = new Date(), opts: { retryWindowMs?: number } = {}): Promise<MatcherRunResult> {
  const result: MatcherRunResult = { considered: 0, matched: 0, unmatched: 0, waitingForLine: 0 };
  const windowStart = new Date(now.getTime() - (opts.retryWindowMs ?? RETRY_WINDOW_MS));

  // Past the retry window: whatever is still waiting is final.
  await prisma.crmAction.updateMany({
    where: { matchStatus: "PENDING", loggedAt: { lt: windowStart } },
    data: { matchStatus: "UNMATCHED", matchReason: "SDR line never synced past this action" },
  });

  const actions = await prisma.crmAction.findMany({
    where: {
      matchStatus: { in: ["PENDING", "UNMATCHED"] },
      loggedAt: { gte: windowStart, lte: new Date(now.getTime() - SETTLE_MS) },
    },
    orderBy: { loggedAt: "asc" },
    select: { id: true, sdrUserId: true, loggedAt: true, phones: true, matchStatus: true },
  });
  if (actions.length === 0) return result;

  const sdrIds = [...new Set(actions.map((a) => a.sdrUserId))];
  const lines = await prisma.line.findMany({
    where: { crmUserId: { in: sdrIds } },
    select: { crmUserId: true, isActive: true, syncCursors: { select: { lastSyncAt: true } } },
  });
  const linesBySdr = new Map<string, { isActive: boolean; lastSyncAt: Date | null }[]>();
  for (const l of lines) {
    const list = linesBySdr.get(l.crmUserId!) ?? [];
    list.push({ isActive: l.isActive, lastSyncAt: l.syncCursors[0]?.lastSyncAt ?? null });
    linesBySdr.set(l.crmUserId!, list);
  }

  const ready = actions.filter((a) => {
    const sdrLines = (linesBySdr.get(a.sdrUserId) ?? []).filter((l) => l.isActive);
    const synced = sdrLines.every((l) => l.lastSyncAt && l.lastSyncAt.getTime() >= a.loggedAt.getTime() + LINE_SYNCED_PAST_MS);
    if (!synced) result.waitingForLine += 1;
    return synced;
  });

  for (let i = 0; i < ready.length; i += CHUNK) {
    const chunk = ready.slice(i, i + CHUNK);
    result.considered += chunk.length;

    const phones = [...new Set(chunk.flatMap((a) => a.phones))];
    const from = new Date(chunk[0].loggedAt.getTime() - DEFAULT_MATCH_OPTIONS.maxLogDelayMs - MAX_CALL_DURATION_MS);
    const to = new Date(chunk[chunk.length - 1].loggedAt.getTime() + DEFAULT_MATCH_OPTIONS.skewMs);

    const calls = await prisma.call.findMany({
      where: { remoteNumber: { in: phones }, startedAt: { gte: from, lte: to }, crmAction: { is: null } },
      select: { id: true, remoteNumber: true, startedAt: true, durationSec: true, line: { select: { crmUserId: true } } },
    });

    const matchable: MatchableAction[] = chunk.map((a) => ({
      id: a.id,
      sdrUserId: a.sdrUserId,
      loggedAt: a.loggedAt,
      phones: a.phones,
      sdrHasLine: (linesBySdr.get(a.sdrUserId) ?? []).some((l) => l.isActive),
    }));
    const callFacts: MatchableCall[] = calls.map((c) => ({
      id: c.id,
      remoteNumber: c.remoteNumber!,
      startedAt: c.startedAt!,
      durationSec: c.durationSec,
      lineUserId: c.line?.crmUserId ?? null,
    }));

    const matches = matchActionsToCalls(matchable, callFacts);
    const matchedIds = new Set<string>();
    for (const m of matches) {
      try {
        await prisma.crmAction.update({
          where: { id: m.actionId },
          data: { callId: m.callId, matchStatus: "MATCHED", matchConfidence: m.confidence, matchReason: m.reason, matchedAt: now },
        });
        matchedIds.add(m.actionId);
        result.matched += 1;
      } catch (e) {
        // Unique violation on callId: someone else took this call in the meantime — leave the
        // action for the next run rather than double-linking.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      }
    }

    const giveUp = chunk.filter(
      (a) => !matchedIds.has(a.id) && a.matchStatus === "PENDING" && now.getTime() - a.loggedAt.getTime() >= UNMATCHED_AFTER_MS,
    );
    if (giveUp.length) {
      await prisma.crmAction.updateMany({
        where: { id: { in: giveUp.map((a) => a.id) } },
        data: { matchStatus: "UNMATCHED", matchReason: "line synced past the action; no vault call fits" },
      });
      result.unmatched += giveUp.length;
    }
  }

  return result;
}
