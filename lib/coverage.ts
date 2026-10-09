// "Did we miss anything?" — the completeness report behind the dashboard and
// GET /api/calls/coverage. Every number here is a way a transcript could go missing:
//   * SDR logging calls in the CRM with no vault line          -> their calls aren't synced at all
//   * line not synced recently / erroring / backfill in flight -> calls not in the vault yet
//   * conversation with no transcript after the settle delay   -> provider never produced one
//   * CRM action no vault call fits                            -> dialed from elsewhere, or wrong number
//   * conversation in the vault no CRM action points to        -> call happened, never logged
//   * recording FAILED                                         -> audio lost at the provider

import { Prisma } from "@prisma/client";
import { prisma } from "./db";

export const CONVERSATION_MIN_SEC = Math.max(1, parseInt(process.env.COVERAGE_CONVERSATION_MIN_SEC ?? "20", 10) || 20);
const TRANSCRIPT_SETTLE_MS = 6 * 3600_000;
const LINE_STALE_MS = 15 * 60_000;

const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

export interface SdrActionCounts {
  sdrUserId: string;
  actions: number;
  matched: number;
  matchedHigh: number;
  unmatched: number;
  pending: number;
  noPhone: number;
}

export function actionCountsQuery(from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT "sdrUserId",
           count(*)::int AS actions,
           count(*) FILTER (WHERE "matchStatus" = 'MATCHED')::int AS matched,
           count(*) FILTER (WHERE "matchStatus" = 'MATCHED' AND "matchConfidence" = 'HIGH')::int AS "matchedHigh",
           count(*) FILTER (WHERE "matchStatus" = 'UNMATCHED')::int AS unmatched,
           count(*) FILTER (WHERE "matchStatus" = 'PENDING')::int AS pending,
           count(*) FILTER (WHERE "matchStatus" = 'NO_PHONE')::int AS "noPhone"
    FROM "CrmAction"
    WHERE "loggedAt" >= ${ts(from)} AND "loggedAt" < ${ts(to)}
    GROUP BY 1`;
}

export interface SdrCallCounts {
  sdrUserId: string | null;
  calls: number;
  conversations: number;
  withTranscript: number;
  missingTranscript: number;
  unloggedConversations: number;
  recordingsFailed: number;
  recordingsPending: number;
}

export function callCountsQuery(from: Date, to: Date, now: Date): Prisma.Sql {
  const conv = Prisma.sql`c."durationSec" >= ${CONVERSATION_MIN_SEC}`;
  return Prisma.sql`
    SELECT l."crmUserId" AS "sdrUserId",
           count(*)::int AS calls,
           count(*) FILTER (WHERE ${conv})::int AS conversations,
           count(*) FILTER (WHERE ${conv} AND c.transcription IS NOT NULL)::int AS "withTranscript",
           count(*) FILTER (WHERE ${conv} AND c.transcription IS NULL
                            AND c."startedAt" < ${ts(new Date(now.getTime() - TRANSCRIPT_SETTLE_MS))})::int AS "missingTranscript",
           count(*) FILTER (WHERE ${conv} AND a.id IS NULL)::int AS "unloggedConversations",
           count(*) FILTER (WHERE c."recordingStatus" = 'FAILED')::int AS "recordingsFailed",
           count(*) FILTER (WHERE c."recordingStatus" = 'PENDING')::int AS "recordingsPending"
    FROM "Call" c
    LEFT JOIN "Line" l ON l.id = c."lineId"
    LEFT JOIN "CrmAction" a ON a."callId" = c.id
    WHERE c."startedAt" >= ${ts(from)} AND c."startedAt" < ${ts(to)}
    GROUP BY 1`;
}

export function missingTranscriptsQuery(from: Date, to: Date, now: Date, limit = 50): Prisma.Sql {
  return Prisma.sql`
    SELECT c.id, to_char(c."startedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt", c."durationSec",
           l."externalNumber" AS line, l."crmUserId" AS "sdrUserId", a.id AS "actionId"
    FROM "Call" c
    LEFT JOIN "Line" l ON l.id = c."lineId"
    LEFT JOIN "CrmAction" a ON a."callId" = c.id
    WHERE c."startedAt" >= ${ts(from)} AND c."startedAt" < ${ts(to)}
      AND c."startedAt" < ${ts(new Date(now.getTime() - TRANSCRIPT_SETTLE_MS))}
      AND c."durationSec" >= ${CONVERSATION_MIN_SEC} AND c.transcription IS NULL
    ORDER BY c."durationSec" DESC
    LIMIT ${limit}`;
}

export interface CoverageReport {
  period: { from: string; to: string };
  definitions: Record<string, string>;
  totals: Omit<SdrActionCounts, "sdrUserId"> & Omit<SdrCallCounts, "sdrUserId">;
  lines: {
    id: string;
    number: string;
    source: string;
    sdrUserId: string | null;
    isActive: boolean;
    lastSyncAt: string | null;
    stale: boolean;
    lastError: string | null;
    backfill: { until: string; nextPage: number | null; done: boolean } | null;
  }[];
  /** SDRs with CRM CALL actions in the period but no active vault line: their calls aren't synced. */
  sdrsWithoutLine: string[];
  bySdr: (SdrActionCounts & Omit<SdrCallCounts, "sdrUserId">)[];
  /** Calls on lines not mapped to any CRM user. */
  unmappedLineCalls: Omit<SdrCallCounts, "sdrUserId"> | null;
  missingTranscripts: { id: string; startedAt: string; durationSec: number; line: string | null; sdrUserId: string | null; actionId: string | null }[];
}

const zeroCalls = (): Omit<SdrCallCounts, "sdrUserId"> => ({
  calls: 0, conversations: 0, withTranscript: 0, missingTranscript: 0, unloggedConversations: 0, recordingsFailed: 0, recordingsPending: 0,
});
const zeroActions = (): Omit<SdrActionCounts, "sdrUserId"> => ({ actions: 0, matched: 0, matchedHigh: 0, unmatched: 0, pending: 0, noPhone: 0 });

/** Pure merge of the two aggregates + line list into the report (unit-tested). */
export function buildCoverage(input: {
  from: Date;
  to: Date;
  now: Date;
  actionCounts: SdrActionCounts[];
  callCounts: SdrCallCounts[];
  lines: CoverageReport["lines"];
  missingTranscripts: CoverageReport["missingTranscripts"];
}): CoverageReport {
  const bySdr = new Map<string, SdrActionCounts & Omit<SdrCallCounts, "sdrUserId">>();
  const row = (id: string) => {
    if (!bySdr.has(id)) bySdr.set(id, { sdrUserId: id, ...zeroActions(), ...zeroCalls() });
    return bySdr.get(id)!;
  };
  for (const a of input.actionCounts) Object.assign(row(a.sdrUserId), a);
  let unmappedLineCalls: CoverageReport["unmappedLineCalls"] = null;
  for (const c of input.callCounts) {
    const { sdrUserId, ...counts } = c;
    if (sdrUserId) Object.assign(row(sdrUserId), counts);
    else unmappedLineCalls = counts;
  }

  const activeOwners = new Set(input.lines.filter((l) => l.isActive && l.sdrUserId).map((l) => l.sdrUserId));
  const sdrsWithoutLine = input.actionCounts.filter((a) => a.actions > 0 && !activeOwners.has(a.sdrUserId)).map((a) => a.sdrUserId);

  const totals = { ...zeroActions(), ...zeroCalls() };
  for (const r of [...bySdr.values(), ...(unmappedLineCalls ? [{ ...zeroActions(), ...unmappedLineCalls }] : [])]) {
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
  }

  return {
    period: { from: input.from.toISOString(), to: input.to.toISOString() },
    definitions: {
      conversation: `call lasting >= ${CONVERSATION_MIN_SEC}s`,
      missingTranscript: "conversation with no transcript 6h after it started",
      unloggedConversations: "conversation no CRM CALL action is linked to",
      unmatched: "CRM CALL action no vault call fits, after the SDR's line synced past it",
      stale: "line not successfully synced in the last 15 minutes",
    },
    totals,
    lines: input.lines,
    sdrsWithoutLine,
    bySdr: [...bySdr.values()].sort((a, b) => b.actions - a.actions || b.calls - a.calls),
    unmappedLineCalls,
    missingTranscripts: input.missingTranscripts,
  };
}

export async function getCoverage(from: Date, to: Date, now = new Date()): Promise<CoverageReport> {
  const [actionCounts, callCounts, missingTranscripts, lineRows] = await Promise.all([
    prisma.$queryRaw<SdrActionCounts[]>(actionCountsQuery(from, to)),
    prisma.$queryRaw<SdrCallCounts[]>(callCountsQuery(from, to, now)),
    prisma.$queryRaw<CoverageReport["missingTranscripts"]>(missingTranscriptsQuery(from, to, now)),
    prisma.line.findMany({ include: { syncCursors: true }, orderBy: { externalNumber: "asc" } }),
  ]);

  const lines: CoverageReport["lines"] = lineRows.map((l) => {
    const c = l.syncCursors[0];
    return {
      id: l.id,
      number: l.externalNumber,
      source: l.source,
      sdrUserId: l.crmUserId,
      isActive: l.isActive,
      lastSyncAt: c?.lastSyncAt?.toISOString() ?? null,
      stale: l.isActive && (!c?.lastSyncAt || now.getTime() - c.lastSyncAt.getTime() > LINE_STALE_MS),
      lastError: c?.lastError ?? null,
      backfill: c?.backfillUntil
        ? { until: c.backfillUntil.toISOString(), nextPage: c.backfillNextPage, done: !!c.backfillDoneAt }
        : null,
    };
  });

  return buildCoverage({ from, to, now, actionCounts, callCounts, lines, missingTranscripts });
}
