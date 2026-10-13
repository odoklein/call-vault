// The standalone call-vault MCP server: calls, transcripts and summaries — nothing else. It is NOT
// linked to the CRM: no CRM ids in or out. An assistant that also has the CRM's MCP connects the
// two on the phone number (E.164 `phone`, the prospect's number), which both sides normalise the same.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prisma } from "../db";
import { canSeeLine, visibleLineIds, type Viewer } from "../access";
import { toE164 } from "../phone";
import { mcpPaginate, mcpSearchQuery, type McpCallRow } from "./queries";

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export function createVaultMcpServer(viewer: Viewer): McpServer {
  const server = new McpServer(
    { name: "call-vault", version: "1.0.0" },
    {
      instructions:
        "Call recordings, transcripts and AI summaries of the SDR phone calls. Read-only and independent of any CRM: " +
        "calls are identified by the prospect's phone number (`phone`, E.164 like +33612345678). To enrich a CRM " +
        "contact, take their phone number from the CRM and pass it to search_calls. Transcript turns are SDR " +
        "(caller) / PROSPECT. Quote transcripts; never present as fact something the prospect did not say.",
    },
  );

  server.registerTool(
    "search_calls",
    {
      title: "Search calls",
      description:
        "List calls, newest first. Filter by prospect phone number(s) (any format, normalised to E.164), French " +
        "full-text query over transcripts and summaries, date range, direction. Returns summaries and, with `q`, " +
        "matching excerpts. Use get_call for the full transcript. Paginate with `cursor` while `nextCursor` is set.",
      inputSchema: {
        phone: z.array(z.string()).max(20).optional().describe("Prospect phone number(s), e.g. +33612345678 or 06 12 34 56 78."),
        q: z.string().optional().describe("Full-text query (French), websearch syntax: quotes, OR, -exclude."),
        from: z.string().optional().describe("ISO date/time, inclusive."),
        to: z.string().optional().describe("ISO date/time, exclusive."),
        direction: z.enum(["INBOUND", "OUTBOUND"]).optional(),
        hasTranscript: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ phone, q, from, to, direction, hasTranscript, limit, cursor }) => {
      const fromD = from ? new Date(from) : undefined;
      const toD = to ? new Date(to) : undefined;
      if ((fromD && Number.isNaN(fromD.getTime())) || (toD && Number.isNaN(toD.getTime()))) {
        return fail("from/to must be valid ISO dates");
      }
      const rows = await prisma.$queryRaw<McpCallRow[]>(
        mcpSearchQuery({ q, lineIds: visibleLineIds(viewer), phones: phone, direction, from: fromD, to: toD, hasTranscript, cursor, limit }),
      );
      return text(mcpPaginate(rows, limit));
    },
  );

  server.registerTool(
    "get_call",
    {
      title: "Get one call",
      description: "One call in full: summary and the whole transcript, turn by turn (SDR / PROSPECT).",
      inputSchema: { id: z.string().describe("Call id from search_calls.") },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const call = await prisma.call.findUnique({ where: { id }, include: { line: true } });
      if (!call || !canSeeLine(viewer, call.lineId)) return fail("not_found");
      return text({
        id: call.id,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        durationSec: call.durationSec,
        direction: call.direction,
        phone: call.remoteNumber,
        status: call.status,
        lineNumber: call.line?.externalNumber ?? null,
        lineLabel: call.line?.label ?? null,
        summary: call.aiSummary,
        transcript: call.transcriptSegments ?? call.transcription,
        hasRecording: call.recordingStatus === "STORED",
      });
    },
  );

  server.registerTool(
    "get_calls_for_phone",
    {
      title: "Conversation history with a number",
      description:
        "Everything said with one prospect number, oldest to newest: every call with summary and full transcript. " +
        "Use it to brief on a CRM contact from their phone number. Capped to the latest 10 calls.",
      inputSchema: { phone: z.string().describe("Prospect phone number, any format.") },
      annotations: READ_ONLY,
    },
    async ({ phone }) => {
      const e164 = toE164(phone);
      if (!e164) return fail("not a valid phone number");
      const lineIds = visibleLineIds(viewer);
      const calls = await prisma.call.findMany({
        where: { remoteNumber: e164, startedAt: { not: null }, ...(lineIds ? { lineId: { in: lineIds } } : {}) },
        orderBy: { startedAt: "desc" },
        take: 10,
        include: { line: true },
      });
      return text({
        phone: e164,
        calls: calls.reverse().map((c) => ({
          id: c.id,
          startedAt: c.startedAt,
          durationSec: c.durationSec,
          direction: c.direction,
          status: c.status,
          lineLabel: c.line?.label ?? c.line?.externalNumber ?? null,
          summary: c.aiSummary,
          transcript: c.transcriptSegments ?? c.transcription,
        })),
      });
    },
  );

  server.registerTool(
    "list_lines",
    {
      title: "List phone lines",
      description: "The SDR phone numbers whose calls this connection can see, with call counts.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const lineIds = visibleLineIds(viewer);
      const lines = await prisma.line.findMany({
        where: lineIds ? { id: { in: lineIds } } : {},
        orderBy: { externalNumber: "asc" },
        select: { externalNumber: true, label: true, isActive: true, _count: { select: { calls: true } } },
      });
      return text(lines.map((l) => ({ number: l.externalNumber, label: l.label, active: l.isActive, calls: l._count.calls })));
    },
  );

  return server;
}
