// SQL behind the standalone call-vault MCP. Deliberately CRM-free: no CrmAction join, no CRM ids in
// the output. The only key a caller (ChatGPT, next to the CRM MCP) has to join calls to a CRM
// contact is the other party's phone number, in E.164. Visibility is lib/access.ts's line grant.

import { Prisma } from "@prisma/client";
import { toE164List } from "../phone";
import { encodeCursor } from "../calls/search";

export interface McpSearchParams {
  q?: string;
  /** Restrict to these vault lines (client viewer). undefined = every line. */
  lineIds?: string[];
  phones?: string[];
  direction?: "INBOUND" | "OUTBOUND";
  from?: Date;
  to?: Date;
  hasTranscript?: boolean;
  cursor?: string;
  limit: number;
}

export interface McpCallRow {
  id: string;
  startedAt: string;
  durationSec: number;
  direction: string;
  phone: string | null;
  status: string | null;
  lineNumber: string | null;
  lineLabel: string | null;
  summary: string | null;
  hasTranscript: boolean;
  hasRecording: boolean;
  snippet: string | null;
}

const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

export function decodeCursor(cursor: string): { startedAt: Date; id: string } | null {
  try {
    const [startedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const d = new Date(startedAt);
    return typeof id === "string" && !Number.isNaN(d.getTime()) ? { startedAt: d, id } : null;
  } catch {
    return null;
  }
}

export function mcpSearchQuery(p: McpSearchParams): Prisma.Sql {
  const where: Prisma.Sql[] = [Prisma.sql`c."startedAt" IS NOT NULL`];

  if (p.lineIds) where.push(p.lineIds.length ? Prisma.sql`c."lineId" = ANY(${p.lineIds})` : Prisma.sql`FALSE`);
  if (p.phones?.length) {
    const phones = toE164List(p.phones);
    where.push(phones.length ? Prisma.sql`c."remoteNumber" = ANY(${phones})` : Prisma.sql`FALSE`);
  }
  if (p.direction) where.push(Prisma.sql`c.direction::text = ${p.direction}`);
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
           c."remoteNumber" AS phone,
           c.status,
           l."externalNumber" AS "lineNumber",
           l.label AS "lineLabel",
           c."aiSummary" AS summary,
           (c.transcription IS NOT NULL) AS "hasTranscript",
           (c."recordingStatus" = 'STORED') AS "hasRecording",
           ${snippet} AS snippet
    FROM "Call" c
    LEFT JOIN "Line" l ON l.id = c."lineId"
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY c."startedAt" DESC, c.id DESC
    LIMIT ${p.limit + 1}`;
}

export function mcpPaginate(rows: McpCallRow[], limit: number): { items: McpCallRow[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
