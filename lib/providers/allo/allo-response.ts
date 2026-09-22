// Copied verbatim from captainprospect-crm/lib/call-enrichment/allo-response.ts — pure parsing
// logic, no reason to diverge.

/** Max depth for `{ data: { data: … } }` wrappers from WithAllo list API. */
const MAX_DATA_UNWRAP = 8;

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function resultsArrayFrom(pack: Record<string, unknown>): unknown[] | null {
  const r = pack.results;
  if (Array.isArray(r)) return r;
  const c = pack.calls;
  if (Array.isArray(c)) return c;
  return null;
}

function totalPagesFrom(pack: Record<string, unknown>): number {
  const meta = pack.metadata;
  if (isRecord(meta) && meta.total_pages != null) {
    return Math.max(1, Number(meta.total_pages) || 1);
  }
  if (pack.total_pages != null) {
    return Math.max(1, Number(pack.total_pages) || 1);
  }
  return 1;
}

function filterObjectRecords(arr: unknown[]): Record<string, unknown>[] {
  return arr.filter((c): c is Record<string, unknown> => c !== null && typeof c === "object");
}

/**
 * Normalize WithAllo `/v1/api/calls` JSON: flat `{ results }`, one `{ data: { results, metadata } }`,
 * or nested `{ data: { data: { results, metadata } } }` (and repeated `data` wrappers).
 */
export function parseAlloCallsListResponse(body: unknown): { rawCalls: Record<string, unknown>[]; totalPages: number } {
  if (!isRecord(body)) {
    return { rawCalls: [], totalPages: 1 };
  }

  let cursor: unknown = body;
  for (let i = 0; i < MAX_DATA_UNWRAP; i++) {
    if (!isRecord(cursor)) break;
    const arr = resultsArrayFrom(cursor);
    if (arr !== null) {
      return { rawCalls: filterObjectRecords(arr), totalPages: totalPagesFrom(cursor) };
    }
    const next = cursor.data;
    if (isRecord(next)) {
      cursor = next;
      continue;
    }
    break;
  }

  const arr = resultsArrayFrom(body);
  if (arr !== null) {
    return { rawCalls: filterObjectRecords(arr), totalPages: totalPagesFrom(body) };
  }

  return { rawCalls: [], totalPages: 1 };
}
