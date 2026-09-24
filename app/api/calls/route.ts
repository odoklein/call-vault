import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateApiKey } from "@/lib/api-keys";
import { contentScore, phoneMatches, phoneVariants } from "@/lib/phone-match";
import { getRecordingUrl } from "@/lib/storage";

const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 50;

/**
 * GET /api/calls?phone=+336...&phone=+337...&windowStart=ISO&windowEnd=ISO&limit=1
 *
 * The CRM's replacement for calling WithAllo/Leexi/etc. directly. Runs entirely against already-
 * synced rows — no outbound provider call, so this endpoint can never 429. `phone` may repeat
 * (several distinct candidate numbers per action — meetingPhone/contact/company — not format
 * variants of one number, that's handled internally by phoneVariants()). `limit` (default 1, max
 * 50) controls how many ranked candidates come back: 1 for the automatic best-match enrichment
 * path, higher for the manual "which call was it" picker.
 */
export async function GET(req: NextRequest) {
  const auth = await validateApiKey(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null, "/api/calls");
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const phones = searchParams.getAll("phone").filter(Boolean);
  const windowStart = searchParams.get("windowStart");
  const windowEnd = searchParams.get("windowEnd");
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));

  if (phones.length === 0 || !windowStart || !windowEnd) {
    return NextResponse.json({ error: "at least one phone, plus windowStart and windowEnd, are required" }, { status: 400 });
  }

  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json({ error: "windowStart/windowEnd must be valid ISO dates" }, { status: 400 });
  }

  const variants = phones.flatMap(phoneVariants);

  // Narrow by number in SQL. With the time window alone, `take: 200` only covered the newest
  // 200 calls across every line (about a day of team traffic), so a 90-day lookup silently
  // missed anything older. phoneMatches below still applies the exact space-insensitive check.
  const candidates = await prisma.call.findMany({
    where: {
      startedAt: { gte: start, lte: end },
      OR: variants.flatMap((v) => [{ fromNumber: { contains: v } }, { toNumber: { contains: v } }]),
    },
    orderBy: { startedAt: "desc" },
    take: 200,
  });

  const matches = candidates.filter((c) => phoneMatches(c.fromNumber, variants) || phoneMatches(c.toNumber, variants));
  matches.sort((a, b) => contentScore(b) - contentScore(a));

  const top = matches.slice(0, limit);
  const results = await Promise.all(
    top.map(async (call) => ({
      callId: call.id,
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      direction: call.direction,
      status: call.status,
      durationSec: call.durationSec,
      startedAt: call.startedAt,
      summary: call.aiSummary,
      transcription: call.transcription,
      recordingUrl: call.recordingKey ? await getRecordingUrl(call.recordingKey) : null,
    })),
  );

  return NextResponse.json({ matches: results, candidatesExamined: candidates.length, totalMatches: matches.length });
}
