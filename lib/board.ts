// Aggregates for the call board (admin and client), always restricted by the viewer's lines.

import { Prisma } from "@prisma/client";
import { CONVERSATION_MIN_SEC } from "./coverage";

const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

function scope(lineIds: string[] | undefined, from: Date | undefined, to: Date | undefined): Prisma.Sql {
  const where: Prisma.Sql[] = [Prisma.sql`c."startedAt" IS NOT NULL`];
  if (lineIds) where.push(lineIds.length ? Prisma.sql`c."lineId" = ANY(${lineIds})` : Prisma.sql`FALSE`);
  if (from) where.push(Prisma.sql`c."startedAt" >= ${ts(from)}`);
  if (to) where.push(Prisma.sql`c."startedAt" < ${ts(to)}`);
  return Prisma.join(where, " AND ");
}

export interface BoardTotals {
  calls: number;
  conversations: number;
  withTranscript: number;
  withRecording: number;
  talkSec: number;
}

export function boardTotalsQuery(lineIds: string[] | undefined, from?: Date, to?: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS calls,
           count(*) FILTER (WHERE c."durationSec" >= ${CONVERSATION_MIN_SEC})::int AS conversations,
           count(*) FILTER (WHERE c.transcription IS NOT NULL)::int AS "withTranscript",
           count(*) FILTER (WHERE c."recordingStatus" = 'STORED')::int AS "withRecording",
           coalesce(sum(c."durationSec"), 0)::int AS "talkSec"
    FROM "Call" c
    WHERE ${scope(lineIds, from, to)}`;
}

export interface BoardLineRow extends BoardTotals {
  lineId: string;
  number: string;
  label: string | null;
  lastCallAt: string | null;
}

export function boardByLineQuery(lineIds: string[] | undefined, from?: Date, to?: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT l.id AS "lineId", l."externalNumber" AS number, l.label,
           count(*)::int AS calls,
           count(*) FILTER (WHERE c."durationSec" >= ${CONVERSATION_MIN_SEC})::int AS conversations,
           count(*) FILTER (WHERE c.transcription IS NOT NULL)::int AS "withTranscript",
           count(*) FILTER (WHERE c."recordingStatus" = 'STORED')::int AS "withRecording",
           coalesce(sum(c."durationSec"), 0)::int AS "talkSec",
           to_char(max(c."startedAt"), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCallAt"
    FROM "Call" c
    JOIN "Line" l ON l.id = c."lineId"
    WHERE ${scope(lineIds, from, to)}
    GROUP BY l.id, l."externalNumber", l.label
    ORDER BY calls DESC`;
}

export const PERIODS = {
  "7d": { label: "7 derniers jours", days: 7 },
  "30d": { label: "30 derniers jours", days: 30 },
  "90d": { label: "90 derniers jours", days: 90 },
  all: { label: "Tout l'historique", days: null },
} as const;
export type PeriodKey = keyof typeof PERIODS;

export function periodRange(key: string | undefined, now = new Date()): { key: PeriodKey; from?: Date } {
  const k = (key && key in PERIODS ? key : "30d") as PeriodKey;
  const days = PERIODS[k].days;
  return { key: k, from: days ? new Date(now.getTime() - days * 86_400_000) : undefined };
}
