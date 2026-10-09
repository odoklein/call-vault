import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";
import { canSeeLine, viewerForUser } from "@/lib/access";
import { getStorageProvider } from "@/lib/storage";

/**
 * GET /media/calls/:id — a call's audio for the logged-in web user, streamed through the app (so the
 * object store never has to be reachable from browsers) with HTTP Range support for seeking.
 * Same visibility rule as everything else: lib/access.ts.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const viewer = user ? await viewerForUser(user) : null;
  if (!viewer) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const call = await prisma.call.findUnique({ where: { id }, select: { recordingKey: true, recordingStatus: true, lineId: true } });
  if (!call || call.recordingStatus !== "STORED" || !call.recordingKey || !canSeeLine(viewer, call.lineId)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const range = req.headers.get("range") ?? undefined;
  const s = await getStorageProvider().stream(call.recordingKey, range);
  const headers: Record<string, string> = {
    "Content-Type": s.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  if (s.contentLength !== undefined) headers["Content-Length"] = String(s.contentLength);
  if (s.contentRange) headers["Content-Range"] = s.contentRange;
  return new NextResponse(s.body, { status: s.contentRange ? 206 : 200, headers });
}
