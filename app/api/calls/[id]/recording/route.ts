import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateApiKey } from "@/lib/api-keys";
import { getRecordingUrl } from "@/lib/storage";

/**
 * GET /api/calls/:id/recording
 *
 * A STABLE reference to a call's audio — unlike the presigned URL returned inline by
 * `GET /api/calls` (short TTL, fine for immediate display, wrong to persist). Callers that need to
 * store a long-lived reference (e.g. the CRM's Action.callRecordingUrl) should point at this URL
 * instead; it resolves to a freshly generated signed URL on every request instead of going stale.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateApiKey(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null, "/api/calls");
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const call = await prisma.call.findUnique({ where: { id }, select: { recordingKey: true } });
  if (!call?.recordingKey) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const target = await getRecordingUrl(call.recordingKey);
  const absolute = target.startsWith("http") ? target : new URL(target, req.url).toString();
  return NextResponse.redirect(absolute, 302);
}
