import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiViewer } from "@/lib/api-keys";
import { visibleLineIds } from "@/lib/access";
import { callSearchQuery, paginate, type CallSearchRow } from "@/lib/calls/search";

const MAX_LIMIT = 100;

/**
 * GET /api/calls/search?q=&crmClientId=&crmMissionId=&actionId=&contactId=&companyId=&sdrUserId=
 *                       &phone=&phone=&from=ISO&to=ISO&hasTranscript=true|false&limit=&cursor=
 *
 * Full-text (French) search over transcripts + summaries, plus structured filters, newest first.
 * Built for the CRM's MCP tools. A client-bound API key only ever sees its granted lines (lib/access.ts).
 * `crmClientId` / `crmMissionId` are the CRM principal's tenant: when set,
 * only calls linked to that client's/mission's CRM actions are returned (see lib/calls/search.ts).
 */
export async function GET(req: NextRequest) {
  const viewer = await apiViewer(req);
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const str = (k: string) => sp.get(k)?.trim() || undefined;
  const date = (k: string) => {
    const v = str(k);
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const from = date("from");
  const to = date("to");
  if (from === null || to === null) {
    return NextResponse.json({ error: "from/to must be valid ISO dates" }, { status: 400 });
  }
  const hasTranscriptRaw = str("hasTranscript");
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(sp.get("limit") ?? "20", 10) || 20));

  const rows = await prisma.$queryRaw<CallSearchRow[]>(
    callSearchQuery({
      q: str("q"),
      lineIds: visibleLineIds(viewer),
      crmClientId: str("crmClientId"),
      crmMissionId: str("crmMissionId"),
      actionId: str("actionId"),
      contactId: str("contactId"),
      companyId: str("companyId"),
      sdrUserId: str("sdrUserId"),
      phones: sp.getAll("phone").filter(Boolean),
      from,
      to,
      hasTranscript: hasTranscriptRaw === undefined ? undefined : hasTranscriptRaw === "true",
      cursor: str("cursor"),
      limit,
    }),
  );

  const { items, nextCursor } = paginate(rows, limit);
  return NextResponse.json({ items, nextCursor });
}
