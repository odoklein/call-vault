// Transcript / call search for the CRM's MCP tools. One parameterized SQL statement (built here,
// executed on PGlite in test/search.test.ts), keyset-paginated newest first.
//
// Two independent restrictions, both ANDed:
//  * lineIds — the vault's own access rule (lib/access.ts): a vault client only sees its granted lines.
//  * crmClientId / crmMissionId — the CRM principal's tenant, passed by the CRM's MCP. When set, ONLY
//    calls linked to a CRM action of that CRM client/mission are visible. Calls matched to nobody, or
//    found only by phone number, never reach a CRM client key: one switchboard number can sit in two
//    CRM clients' lists.

import { Prisma } from "@prisma/client";
import { toE164List } from "../phone";

export interface CallSearchParams {
  q?: string;
  /** Restrict to these vault lines (client viewer). undefined = every line. */
  lineIds?: string[];
  crmClientId?: string;
  crmMissionId?: string;
  actionId?: string;
  contactId?: string;
  companyId?: string;
  sdrUserId?: string;
  phones?: string[];
  from?: Date;
  to?: Date;
  hasTranscript?: boolean;
  /** Opaque cursor from a previous page. */
  cursor?: string;
  limit: number;
}

export interface CallSearchRow {
  id: string;
  startedAt: string;
  durationSec: number;
  direction: string;
  remoteNumber: string | null;
  status: string | null;
  lineId: string | null;
  lineNumber: string | null;
  lineLabel: string | null;
  summary: string | null;
  hasTranscript: boolean;
  hasRecording: boolean;
  snippet: string | null;
  actionId: string | null;
  contactId: string | null;
  companyId: string | null;
  sdrUserId: string | null;
  missionId: string | null;
  clientId: string | null;
  result: string | null;
  matchConfidence: string | null;
  matchReason: string | null;
}

const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

export function encodeCursor(row: Pick<CallSearchRow, "startedAt" | "id">): string {
  return Buffer.from(JSON.stringify([row.startedAt, row.id])).toString("base64url");
}

function decodeCursor(cursor: string): { startedAt: Date; id: string } | null {
  try {
    const [startedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const d = new Date(startedAt);
    return typeof id === "string" && !Number.isNaN(d.getTime()) ? { startedAt: d, id } : null;
  } catch {
    return null;
  }
}

export function callSearchQuery(p: CallSearchParams): Prisma.Sql {
  const linkedOnly = !!(p.crmClientId || p.crmMissionId || p.actionId || p.contactId || p.companyId);
  const where: Prisma.Sql[] = [Prisma.sql`c."startedAt" IS NOT NULL`];

  if (p.lineIds) where.push(p.lineIds.length ? Prisma.sql`c."lineId" = ANY(${p.lineIds})` : Prisma.sql`FALSE`);
  if (p.crmClientId) where.push(Prisma.sql`a."clientId" = ${p.crmClientId}`);
  if (p.crmMissionId) where.push(Prisma.sql`a."missionId" = ${p.crmMissionId}`);
  if (p.actionId) where.push(Prisma.sql`a.id = ${p.actionId}`);
  if (p.contactId) where.push(Prisma.sql`a."contactId" = ${p.contactId}`);
  if (p.companyId) where.push(Prisma.sql`a."companyId" = ${p.companyId}`);
  if (p.sdrUserId) where.push(Prisma.sql`COALESCE(a."sdrUserId", l."crmUserId") = ${p.sdrUserId}`);
  if (p.phones?.length) {
    const phones = toE164List(p.phones);
    where.push(phones.length ? Prisma.sql`c."remoteNumber" = ANY(${phones})` : Prisma.sql`FALSE`);
  }
  if (p.from) where.push(Prisma.sql`c."startedAt" >= ${ts(p.from)}`);
  if (p.to) where.push(Prisma.sql`c."startedAt" < ${ts(p.to)}`);
  if (p.hasTranscript !== undefined) {
    where.push(p.hasTranscript ? Prisma.sql`c.transcription IS NOT NULL` : Prisma.sql`c.transcription IS NULL`);
  }
  const q = p.q?.trim();
  if (q) where.push(Prisma.sql`c."searchVector" @@ websearch_to_tsquery('french', ${q})`);
  const cursor = p.cursor ? decodeCursor(p.cursor) : null;
  if (cursor) where.push(Prisma.sql`(c."startedAt", c.id) < (${ts(cursor.startedAt)}, ${cursor.id})`);

  const snippet = q
    ? Prisma.sql`ts_headline('french', coalesce(c.transcription, c."aiSummary", ''), websearch_to_tsquery('french', ${q}),
        'StartSel=«, StopSel=», MaxWords=35, MinWords=12, MaxFragments=3, FragmentDelimiter=" … "')`
    : Prisma.sql`NULL`;

  return Prisma.sql`
    SELECT c.id,
           to_char(c."startedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",
           c."durationSec",
           c.direction::text AS direction,
           c."remoteNumber",
           c.status,
           c."lineId",
           l."externalNumber" AS "lineNumber",
           l.label AS "lineLabel",
           c."aiSummary" AS summary,
           (c.transcription IS NOT NULL) AS "hasTranscript",
           (c."recordingStatus" = 'STORED') AS "hasRecording",
           ${snippet} AS snippet,
           a.id AS "actionId",
           a."contactId",
           a."companyId",
           COALESCE(a."sdrUserId", l."crmUserId") AS "sdrUserId",
           a."missionId",
           a."clientId",
           a.result,
           a."matchConfidence"::text AS "matchConfidence",
           a."matchReason"
    FROM "Call" c
    ${linkedOnly ? Prisma.sql`JOIN` : Prisma.sql`LEFT JOIN`} "CrmAction" a ON a."callId" = c.id
    LEFT JOIN "Line" l ON l.id = c."lineId"
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY c."startedAt" DESC, c.id DESC
    LIMIT ${p.limit + 1}`;
}

/** Splits the extra probe row off into a next cursor. */
export function paginate(rows: CallSearchRow[], limit: number): { items: CallSearchRow[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
}
