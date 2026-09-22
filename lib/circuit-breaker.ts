// ============================================
// GENERIC CIRCUIT BREAKER, keyed by an arbitrary string (e.g. `${providerId}:${lineId}`).
// Same shape as captainprospect-crm's lib/email/utils/circuit-breaker.ts, generalized to any key
// instead of just a mailbox id.
//
// Purpose here specifically: if a provider keeps returning 429/5xx for a given line, stop hammering
// it and surface "paused" on the dashboard instead of burning the retry budget silently.
// ============================================

interface CircuitState {
  failures: number;
  lastFailure: Date | null;
  status: "closed" | "open" | "half-open";
}

const circuits = new Map<string, CircuitState>();

const FAILURE_THRESHOLD = 5;
const RECOVERY_TIME_MS = 5 * 60_000;

export function canExecute(key: string): boolean {
  const state = circuits.get(key);
  if (!state || state.status === "closed") return true;

  if (state.status === "open") {
    const elapsed = Date.now() - (state.lastFailure?.getTime() ?? 0);
    if (elapsed > RECOVERY_TIME_MS) {
      state.status = "half-open";
      circuits.set(key, state);
      return true;
    }
    return false;
  }

  return true; // half-open: allow one test request through
}

export function recordSuccess(key: string): void {
  circuits.set(key, { failures: 0, lastFailure: null, status: "closed" });
}

export function recordFailure(key: string): void {
  const state = circuits.get(key) ?? { failures: 0, lastFailure: null, status: "closed" as const };
  state.failures += 1;
  state.lastFailure = new Date();

  if (state.status === "half-open") {
    state.status = "open";
  } else if (state.failures >= FAILURE_THRESHOLD) {
    state.status = "open";
  }

  circuits.set(key, state);
}

export function getCircuitState(key: string): CircuitState | null {
  return circuits.get(key) ?? null;
}

export function getOpenCircuits(): { key: string; state: CircuitState }[] {
  const open: { key: string; state: CircuitState }[] = [];
  for (const [key, state] of circuits) {
    if (state.status === "open" || state.status === "half-open") open.push({ key, state });
  }
  return open;
}
