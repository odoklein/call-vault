// ============================================
// PROVIDER ADAPTER CONTRACT
// Every telephony/call-intelligence provider (allo, leexi, twilio, aircall, ringover, ...)
// implements this so the sync worker, the Call schema, and /api/calls never need to know which
// provider a given line belongs to. Adapters only fetch + normalize one page; cursor, lookback and
// backfill logic lives once in lib/sync/ so every provider gets the same never-miss guarantees.
// ============================================

/** Who spoke, normalized across providers. Provider's own label is kept in `source`. */
export type TranscriptSpeaker = "SDR" | "PROSPECT" | "AGENT" | "UNKNOWN";

export interface TranscriptSegment {
  speaker: TranscriptSpeaker;
  /** Provider's raw speaker label (Allo: USER / EXTERNAL / AGENT). */
  source: string;
  text: string;
  /** Offsets in seconds from call start, when the provider gives them. */
  start?: number;
  end?: number;
}

export interface NormalizedCall {
  providerCallId: string;
  direction: "INBOUND" | "OUTBOUND";
  fromNumber: string;
  toNumber: string;
  status?: string;
  startedAt?: Date;
  endedAt?: Date;
  durationSec: number;
  summary?: string;
  /** Plain text, one "SOURCE: text" turn per line. */
  transcription?: string;
  transcriptSegments?: TranscriptSegment[];
  /** Provider's own media URL — fetched by the recording-mirror queue, then never used again. */
  recordingUrl?: string;
  raw: Record<string, unknown>;
}

export interface ProviderPage {
  /** Newest-first. */
  calls: NormalizedCall[];
  totalPages: number;
}

/** Implemented by poll-based providers (WithAllo, Leexi). */
export interface PollableCallProvider {
  slug: string;
  /**
   * Fetch one page (0-based) of a line's call list, newest first. Throws on any non-retriable
   * failure so the caller never mistakes an error for "no more calls".
   */
  fetchPage(externalNumber: string, page: number): Promise<ProviderPage>;
}
