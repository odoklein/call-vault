// Pairs CRM CALL actions with the vault calls they record — pure, deterministic, unit-tested.
//
// What the CRM's enrichment does today (and why it mis-attaches): "any call to one of these phone
// numbers on this calendar day, best content first, take 1". Two consequences found in production
// data: (1) two actions on two contacts sharing a company switchboard both got the *same* call;
// (2) a booked meeting got a voicemail's summary next to the real conversation's transcript.
//
// The rules here:
//  * Same number (E.164 equality on Call.remoteNumber).
//  * Same SDR: if the call's line is mapped to a CRM user, it must be the action's SDR. If the SDR
//    has mapped lines, a call from an unmapped line isn't theirs either.
//  * Timing: the call started before the action was logged (± clock skew), and ended no more than
//    maxLogDelay before it. SDRs log right after hanging up, so closer is better.
//  * One-to-one: a call backs at most one action, an action gets at most one call. Pairs are
//    assigned greedily by score, so each action gets the call that ended closest before it.

export interface MatchableAction {
  id: string;
  sdrUserId: string;
  loggedAt: Date;
  phones: string[];
  /** The SDR has at least one line mapped in the vault (Line.crmUserId). */
  sdrHasLine: boolean;
}

export interface MatchableCall {
  id: string;
  remoteNumber: string;
  startedAt: Date;
  durationSec: number;
  /** Line.crmUserId of the line the call came from, null when unmapped. */
  lineUserId: string | null;
}

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface Match {
  actionId: string;
  callId: string;
  confidence: Confidence;
  score: number;
  reason: string;
}

export interface MatchOptions {
  /** Longest accepted gap between the call ending and the action being logged. */
  maxLogDelayMs: number;
  /** How long after logging a call may still have started (clock skew between systems). */
  skewMs: number;
  /** Gap under which a same-line match is HIGH confidence. */
  tightMs: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  maxLogDelayMs: 3 * 3600_000,
  skewMs: 2 * 60_000,
  tightMs: 15 * 60_000,
};

interface Candidate extends Match {
  loggedAt: number;
  startedAt: number;
}

function fmtGap(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  const span = m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  return ms >= 0 ? `ended ${span} before log` : `still running ${span} after log`;
}

export function scorePair(action: MatchableAction, call: MatchableCall, opts: MatchOptions = DEFAULT_MATCH_OPTIONS): Match | null {
  if (!action.phones.includes(call.remoteNumber)) return null;

  const sameLine = call.lineUserId !== null && call.lineUserId === action.sdrUserId;
  if (call.lineUserId !== null && !sameLine) return null; // another SDR's call
  if (call.lineUserId === null && action.sdrHasLine) return null; // SDR's calls come from their own mapped lines

  const logged = action.loggedAt.getTime();
  const started = call.startedAt.getTime();
  const ended = started + Math.max(0, call.durationSec) * 1000;
  if (started > logged + opts.skewMs) return null; // started after the outcome was logged
  const gap = logged - ended; // > 0: ended before the log (normal); < 0: logged mid-call
  if (gap > opts.maxLogDelayMs) return null;

  // Closer is better; logging mid-call is plausible but less so than right after.
  const gapMinutes = gap >= 0 ? gap / 60_000 : (3 * -gap) / 60_000;
  let score = 1000 - gapMinutes;
  if (sameLine) score += 500;
  if (call.durationSec > 0) score += 20;

  const confidence: Confidence =
    sameLine && Math.abs(gap) <= opts.tightMs
      ? "HIGH"
      : sameLine || Math.abs(gap) <= opts.tightMs
        ? "MEDIUM"
        : "LOW";

  const reason = `${sameLine ? "same SDR line" : "SDR line not mapped"}, ${fmtGap(gap)}, ${call.durationSec}s`;
  return { actionId: action.id, callId: call.id, confidence, score, reason };
}

export function matchActionsToCalls(
  actions: MatchableAction[],
  calls: MatchableCall[],
  opts: MatchOptions = DEFAULT_MATCH_OPTIONS,
): Match[] {
  const callsByNumber = new Map<string, MatchableCall[]>();
  for (const call of calls) {
    const list = callsByNumber.get(call.remoteNumber) ?? [];
    list.push(call);
    callsByNumber.set(call.remoteNumber, list);
  }

  const candidates: Candidate[] = [];
  for (const action of actions) {
    const seen = new Set<string>();
    for (const phone of action.phones) {
      for (const call of callsByNumber.get(phone) ?? []) {
        if (seen.has(call.id)) continue;
        seen.add(call.id);
        const m = scorePair(action, call, opts);
        if (m) candidates.push({ ...m, loggedAt: action.loggedAt.getTime(), startedAt: call.startedAt.getTime() });
      }
    }
  }

  // Deterministic order: score, then earlier action, then earlier call, then ids.
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.loggedAt - b.loggedAt ||
      a.startedAt - b.startedAt ||
      a.actionId.localeCompare(b.actionId) ||
      a.callId.localeCompare(b.callId),
  );

  const usedActions = new Set<string>();
  const usedCalls = new Set<string>();
  const out: Match[] = [];
  for (const c of candidates) {
    if (usedActions.has(c.actionId) || usedCalls.has(c.callId)) continue;
    usedActions.add(c.actionId);
    usedCalls.add(c.callId);
    out.push({ actionId: c.actionId, callId: c.callId, confidence: c.confidence, score: c.score, reason: c.reason });
  }
  return out;
}
