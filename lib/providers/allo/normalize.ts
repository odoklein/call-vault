// WithAllo call payload -> NormalizedCall. Pure (no I/O) so it's unit-tested directly.

import type { NormalizedCall, TranscriptSegment, TranscriptSpeaker } from "../types";

// Seen in real transcripts: USER is the Allo account holder (the SDR introducing themself),
// EXTERNAL is the other party. AGENT is Allo's own AI agent.
const SPEAKERS: Record<string, TranscriptSpeaker> = {
  USER: "SDR",
  EXTERNAL: "PROSPECT",
  AGENT: "AGENT",
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function alloTranscriptSegments(raw: unknown): TranscriptSegment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const segments: TranscriptSegment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === "string" ? e.text.trim() : "";
    if (!text) continue;
    const source = String(e.source ?? e.speaker ?? "UNKNOWN").toUpperCase();
    const segment: TranscriptSegment = { speaker: SPEAKERS[source] ?? "UNKNOWN", source, text };
    const start = num(e.start) ?? num(e.start_time) ?? num(e.timestamp);
    const end = num(e.end) ?? num(e.end_time);
    if (start !== undefined) segment.start = start;
    if (end !== undefined) segment.end = end;
    segments.push(segment);
  }
  return segments.length ? segments : undefined;
}

/**
 * A string without a zone ("2026-10-09T14:35:00") is read as UTC, not as the worker host's local
 * time — call times feed the CRM matcher (minutes matter), and the result must not change with
 * the server's TZ setting.
 */
export function parseDate(v: unknown): Date | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000);
  const s = String(v).trim();
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const d = new Date(naive ? `${s.replace(" ", "T")}Z` : s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function normalizeAlloCall(raw: Record<string, unknown>): NormalizedCall {
  const from = String(raw.from ?? raw.from_number ?? "");
  const to = String(raw.to ?? raw.to_number ?? "");
  const typeRaw = String(raw.direction ?? raw.type ?? "OUTBOUND").toUpperCase();
  const direction: "INBOUND" | "OUTBOUND" = typeRaw === "INBOUND" ? "INBOUND" : "OUTBOUND";

  let duration = typeof raw.duration === "number" ? raw.duration : 0;
  if (!duration && typeof raw.length_in_minutes === "number") {
    duration = Math.round(raw.length_in_minutes * 60);
  }

  const startedAt = parseDate(raw.start_time ?? raw.start_date ?? raw.created_at);
  const endedAt =
    parseDate(raw.end_time ?? raw.end_date) ??
    (startedAt && duration > 0 ? new Date(startedAt.getTime() + duration * 1000) : undefined);

  const recordingRaw = raw.recording_url ?? raw.recording;
  const recordingUrl = typeof recordingRaw === "string" && /^https?:\/\//i.test(recordingRaw) ? recordingRaw : undefined;

  const summaryRaw =
    typeof raw.summary === "string" ? raw.summary : typeof raw.call_summary === "string" ? raw.call_summary : undefined;

  const transcriptSegments = alloTranscriptSegments(raw.transcript);
  const transcriptPlain = typeof raw.transcription === "string" && raw.transcription.trim() ? raw.transcription : undefined;
  // Plain-text format unchanged ("USER: …" / "EXTERNAL: …") — the CRM's existing consumers of
  // /api/calls already display it. The role-normalized form lives in transcriptSegments.
  const transcription = transcriptSegments
    ? transcriptSegments.map((s) => `${s.source}: ${s.text}`).join("\n")
    : transcriptPlain;

  return {
    providerCallId: String(raw.id ?? ""),
    direction,
    fromNumber: from,
    toNumber: to,
    status: typeof raw.outcome === "string" ? raw.outcome : undefined,
    startedAt,
    endedAt,
    durationSec: duration,
    summary: summaryRaw?.trim() || undefined,
    transcription: transcription?.trim() || undefined,
    transcriptSegments,
    recordingUrl,
    raw,
  };
}

/** Recording URL out of a stored rawPayload (for re-mirroring without another list call). */
export function alloRecordingUrl(rawPayload: unknown): string | undefined {
  if (!rawPayload || typeof rawPayload !== "object") return undefined;
  const raw = rawPayload as Record<string, unknown>;
  const candidate = raw.recording_url ?? raw.recording;
  return typeof candidate === "string" && /^https?:\/\//i.test(candidate) ? candidate : undefined;
}
