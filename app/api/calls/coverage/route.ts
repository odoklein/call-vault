import { NextRequest, NextResponse } from "next/server";
import { apiViewer } from "@/lib/api-keys";
import { getCoverage } from "@/lib/coverage";

const DAY = 86_400_000;

/**
 * GET /api/calls/coverage?from=ISO&to=ISO   (default: last 7 days)
 *
 * Completeness report: per SDR, CRM-logged calls vs vault calls, links, conversations, transcripts
 * present/missing, unlogged conversations, failed recordings; per line, sync freshness and
 * backfill progress; SDRs whose calls aren't being synced at all. See lib/coverage.ts.
 */
export async function GET(req: NextRequest) {
  const viewer = await apiViewer(req);
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Operator-wide numbers (every SDR, every line): not for client-bound keys.
  if (viewer.kind !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const now = new Date();
  const to = sp.get("to") ? new Date(sp.get("to")!) : now;
  const from = sp.get("from") ? new Date(sp.get("from")!) : new Date(to.getTime() - 7 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return NextResponse.json({ error: "from/to must be valid ISO dates with from < to" }, { status: 400 });
  }
  if (to.getTime() - from.getTime() > 93 * DAY) {
    return NextResponse.json({ error: "period too long (max 93 days)" }, { status: 400 });
  }

  return NextResponse.json(await getCoverage(from, to, now));
}
