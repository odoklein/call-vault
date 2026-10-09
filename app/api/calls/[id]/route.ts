import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiViewer } from "@/lib/api-keys";
import { canSeeLine } from "@/lib/access";

/**
 * GET /api/calls/:id                 — one vault call in full (structured transcript included)
 * GET /api/calls/:crmActionId?by=action — the vault call linked to that CRM action
 *
 * Visible only on a line the key's client is granted (lib/access.ts). `crmClientId` / `crmMissionId`
 * (the CRM principal's tenant) additionally make the call visible only if it is linked
 * to a CRM action of that client/mission — otherwise 404, same as a call that doesn't exist.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await apiViewer(req);
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const clientId = sp.get("crmClientId") || undefined;
  const missionId = sp.get("crmMissionId") || undefined;

  const call =
    sp.get("by") === "action"
      ? (await prisma.crmAction.findUnique({ where: { id }, select: { call: { include: { crmAction: true, line: true } } } }))?.call
      : await prisma.call.findUnique({ where: { id }, include: { crmAction: true, line: true } });

  const link = call?.crmAction ?? null;
  const visible = call && canSeeLine(viewer, call.lineId) && (!clientId || link?.clientId === clientId) && (!missionId || link?.missionId === missionId);
  if (!call || !visible) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    id: call.id,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationSec: call.durationSec,
    direction: call.direction,
    remoteNumber: call.remoteNumber,
    status: call.status,
    summary: call.aiSummary,
    transcription: call.transcription,
    transcriptSegments: call.transcriptSegments,
    transcriptAt: call.transcriptAt,
    hasRecording: call.recordingStatus === "STORED",
    recordingStatus: call.recordingStatus,
    sdrUserId: link?.sdrUserId ?? call.line?.crmUserId ?? null,
    link: link && {
      actionId: link.id,
      contactId: link.contactId,
      companyId: link.companyId,
      missionId: link.missionId,
      clientId: link.clientId,
      result: link.result,
      loggedAt: link.loggedAt,
      confidence: link.matchConfidence,
      reason: link.matchReason,
    },
  });
}
