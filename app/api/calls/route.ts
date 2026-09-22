import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateApiKey } from "@/lib/api-keys";
import { contentScore, phoneMatches, phoneVariants } from "@/lib/phone-match";
import { getRecordingUrl } from "@/lib/storage";

/**
 * GET /api/calls?phone=+336...&windowStart=ISO&windowEnd=ISO
 *
 * The CRM's replacement for calling WithAllo/Leexi/etc. directly. Runs entirely against already-
 * synced rows — no outbound provider call, so this endpoint can never 429. Used for the manual
 * "which call was it" picker and any on-demand backfill lookup.
 */
export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null, "/api/calls");
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const phone = searchParams.get("phone");
  const windowStart = searchParams.get("windowStart");
  const windowEnd = searchParams.get("windowEnd");

  if (!phone || !windowStart || !windowEnd) {
    return NextResponse.json({ error: "phone, windowStart and windowEnd are required" }, { status: 400 });
  }

  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json({ error: "windowStart/windowEnd must be valid ISO dates" }, { status: 400 });
  }

  const variants = phoneVariants(phone);

  const candidates = await prisma.call.findMany({
    where: { startedAt: { gte: start, lte: end } },
    orderBy: { startedAt: "desc" },
    take: 200,
  });

  const matches = candidates.filter((c) => phoneMatches(c.fromNumber, variants) || phoneMatches(c.toNumber, variants));

  if (matches.length === 0) {
    return NextResponse.json({ match: null, candidatesExamined: candidates.length });
  }

  matches.sort((a, b) => contentScore(b) - contentScore(a));
  const best = matches[0]!;

  return NextResponse.json({
    match: {
      callId: best.id,
      summary: best.aiSummary,
      transcription: best.transcription,
      recordingUrl: best.recordingKey ? await getRecordingUrl(best.recordingKey) : null,
      startedAt: best.startedAt,
      durationSec: best.durationSec,
    },
    otherCandidates: matches.length - 1,
  });
}
