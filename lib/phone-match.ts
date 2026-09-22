// Phone/window matching — ported from captainprospect-crm's lib/call-enrichment/allo-provider.ts
// (phoneVariants / phoneMatchesCall / contentScore). This used to run against a live paginated
// WithAllo scan per action; here it runs as a plain query over already-synced Call rows, so it's
// instant and can never 429 — the fallback tier for providers that can't click-to-dial with a
// CRM id attached (see the plan's "Matching" section).

/** All format variants of an E.164 number, to match against a provider's from/to fields. */
export function phoneVariants(e164: string): string[] {
  const variants: string[] = [e164];
  if (e164.startsWith("+33")) variants.push("0" + e164.slice(3)); // French local
  if (e164.startsWith("+")) variants.push(e164.slice(1)); // without leading +
  return [...new Set(variants)];
}

function stripSpaces(s: string): string {
  return s.replace(/\s+/g, "");
}

export function phoneMatches(fromOrTo: string, variants: string[]): boolean {
  const n = stripSpaces(fromOrTo ?? "").toLowerCase();
  return variants.some((v) => n.includes(stripSpaces(v).toLowerCase()));
}

export interface ScorableCall {
  summary?: string | null;
  transcription?: string | null;
  recordingKey?: string | null;
  durationSec: number;
  startedAt?: Date | null;
}

/** Prefer calls with real content; tie-break with duration then recency. */
export function contentScore(call: ScorableCall): number {
  let s = 0;
  if (call.summary?.trim()) s += 1_000_000;
  if (call.transcription?.trim()) s += 100_000 + Math.min(call.transcription.length, 50_000);
  if (call.recordingKey) s += 10_000;
  s += Math.min(call.durationSec, 3600);
  return s;
}
