// ============================================
// PROVIDER ADAPTER CONTRACT
// Every telephony/call-intelligence provider (allo, leexi, twilio, aircall, ringover, ...)
// implements this so the sync worker, the Call schema, and /api/calls never need to know which
// provider a given line belongs to.
// ============================================

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
  transcription?: string;
  /** Provider's own media URL — fetched once by the worker, then discarded. Never persisted. */
  recordingUrl?: string;
  raw: Record<string, unknown>;
}

export interface LineCursor {
  lineId: string;
  externalNumber: string;
  lastSyncedAt: Date | null;
}

export interface SyncResult {
  calls: NormalizedCall[];
  /** New high-water mark — the worker persists this to SyncCursor after a successful run. */
  newLastSyncedAt: Date | null;
}

/** Implemented by poll-based providers (WithAllo, Leexi today). */
export interface PollableCallProvider {
  slug: string;
  /**
   * Fetch only calls newer than `cursor.lastSyncedAt` for one line, walking pages forward until
   * either an already-seen call is hit or `maxPages` is reached (safety cap — should rarely
   * trigger once cursors are warm).
   */
  syncLine(cursor: LineCursor, maxPages: number): Promise<SyncResult>;
}
