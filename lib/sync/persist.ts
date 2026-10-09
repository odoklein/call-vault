// Upserting provider calls into the vault. Every call is seen many times (each lookback pass), so
// the rules for merging a new sighting into the stored row are what keep content from being lost:
//  * content only ever accumulates — a sighting without transcript/summary never erases one;
//  * a STORED recording is never downgraded or re-downloaded;
//  * a fresh recording URL revives a FAILED/NONE recording (provider URLs can expire).

import { Prisma, type RecordingStatus } from "@prisma/client";
import { prisma } from "../db";
import { toE164 } from "../phone";
import type { NormalizedCall } from "../providers/types";

export interface ExistingCallState {
  id: string;
  recordingStatus: RecordingStatus;
  transcriptAt: Date | null;
}

export interface CallWrite {
  create: Omit<Prisma.CallUncheckedCreateInput, "providerId" | "providerCallId">;
  update: Prisma.CallUncheckedUpdateInput;
  /** The recording should be (re)mirrored after this write. */
  wantsMirror: boolean;
}

export function callWriteData(call: NormalizedCall, existing: ExistingCallState | null, lineId: string, now: Date): CallWrite {
  const remoteNumber = toE164(call.direction === "INBOUND" ? call.fromNumber : call.toNumber);
  const hasTranscript = !!call.transcription;
  const transcriptAt = existing?.transcriptAt ?? (hasTranscript ? now : null);
  const segments = call.transcriptSegments ? (call.transcriptSegments as unknown as Prisma.InputJsonValue) : undefined;

  let recordingStatus: RecordingStatus | undefined;
  if (existing?.recordingStatus === "STORED") recordingStatus = undefined; // keep as-is, forever
  else if (call.recordingUrl) recordingStatus = "PENDING";
  else if (!existing) recordingStatus = "NONE";

  const create: CallWrite["create"] = {
    lineId,
    direction: call.direction,
    fromNumber: call.fromNumber,
    toNumber: call.toNumber,
    remoteNumber,
    status: call.status,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationSec: call.durationSec,
    transcription: call.transcription,
    transcriptSegments: segments,
    transcriptAt,
    aiSummary: call.summary,
    rawPayload: call.raw as Prisma.InputJsonValue,
    recordingStatus: recordingStatus ?? "NONE",
    lastSeenAt: now,
  };

  const update: Prisma.CallUncheckedUpdateInput = {
    lineId,
    remoteNumber: remoteNumber ?? undefined,
    rawPayload: call.raw as Prisma.InputJsonValue,
    lastSeenAt: now,
    transcriptAt,
  };
  if (call.status) update.status = call.status;
  if (call.startedAt) update.startedAt = call.startedAt;
  if (call.endedAt) update.endedAt = call.endedAt;
  if (call.durationSec > 0) update.durationSec = call.durationSec;
  if (call.transcription) update.transcription = call.transcription;
  if (segments) update.transcriptSegments = segments;
  if (call.summary) update.aiSummary = call.summary;
  if (recordingStatus) update.recordingStatus = recordingStatus;

  return { create, update, wantsMirror: recordingStatus === "PENDING" };
}

/** Upserts one page of calls for a line. Returns the vault ids whose recording needs mirroring. */
export async function persistCalls(params: {
  providerId: string;
  lineId: string;
  calls: NormalizedCall[];
  now?: Date;
}): Promise<{ upserted: number; toMirror: string[] }> {
  const { providerId, lineId, calls } = params;
  const now = params.now ?? new Date();
  const toMirror: string[] = [];

  for (const call of calls) {
    const where = { providerId_providerCallId: { providerId, providerCallId: call.providerCallId } };
    const existing = await prisma.call.findUnique({
      where,
      select: { id: true, recordingStatus: true, transcriptAt: true },
    });
    const write = callWriteData(call, existing, lineId, now);

    const saved = existing
      ? await prisma.call.update({ where: { id: existing.id }, data: write.update, select: { id: true } })
      : await prisma.call.create({
          data: { ...write.create, providerId, providerCallId: call.providerCallId },
          select: { id: true },
        });

    if (write.wantsMirror) toMirror.push(saved.id);
  }

  return { upserted: calls.length, toMirror };
}
