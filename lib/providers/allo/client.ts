// Low-level WithAllo HTTP client: fetch one page + normalize its calls.
// Retry/backoff logic ported as-is from captainprospect-crm's
// lib/call-enrichment/allo-provider.ts (fetchPageForLine) — that part was never the problem,
// it's genuinely careful. What changes is who calls it and how often (see sync.ts).

import { parseAlloCallsListResponse } from "./allo-response";
import type { NormalizedCall } from "../types";

const BASE_URL = "https://api.withallo.com";

const RETRIES_429 = Math.max(0, parseInt(process.env.CALL_ENRICHMENT_ALLO_429_RETRIES ?? "6", 10));
const RETRY_429_BASE_MS = Math.max(100, parseInt(process.env.CALL_ENRICHMENT_ALLO_429_BASE_MS ?? "750", 10));
const NETWORK_RETRIES = Math.max(0, parseInt(process.env.CALL_ENRICHMENT_ALLO_NETWORK_RETRIES ?? "3", 10));
const NETWORK_RETRY_BASE_MS = Math.max(200, parseInt(process.env.CALL_ENRICHMENT_ALLO_NETWORK_RETRY_MS ?? "1500", 10));
const FETCH_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.CALL_ENRICHMENT_ALLO_FETCH_TIMEOUT_MS ?? "30000", 10));
const PAGE_SIZE = Math.min(100, Math.max(1, parseInt(process.env.CALL_ENRICHMENT_ALLO_PAGE_SIZE ?? "100", 10)));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchErrorHint(e: unknown): string {
  if (e instanceof Error) {
    const c = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    const code = c && typeof c === "object" && "code" in c ? String((c as { code: string }).code) : "";
    return [e.name, e.message, code].filter(Boolean).join(" | ");
  }
  return String(e);
}

function isRetriableFetchError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (e instanceof Error && e.name === "AbortError") return true;
  const c = (e as { cause?: { code?: string } })?.cause;
  const code = c?.code;
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  );
}

/** Retry-After: seconds or HTTP-date */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("Retry-After");
  if (!h) return null;
  const sec = parseInt(h.trim(), 10);
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 120_000);
  const t = Date.parse(h);
  if (!Number.isNaN(t)) return Math.min(Math.max(0, t - Date.now()), 120_000);
  return null;
}

interface AlloTranscriptEntry {
  source: "AGENT" | "EXTERNAL" | "USER";
  text: string;
}

function normalizeAlloCall(raw: Record<string, unknown>): NormalizedCall & { id: string } {
  const from = String(raw.from ?? raw.from_number ?? "");
  const to = String(raw.to ?? raw.to_number ?? "");
  const typeRaw = String(raw.direction ?? raw.type ?? "OUTBOUND").toUpperCase();
  const direction: "INBOUND" | "OUTBOUND" = typeRaw === "INBOUND" ? "INBOUND" : "OUTBOUND";

  let duration = typeof raw.duration === "number" ? raw.duration : 0;
  if (!duration && typeof raw.length_in_minutes === "number") {
    duration = Math.round(raw.length_in_minutes * 60);
  }

  const startRaw = raw.start_time ?? raw.start_date ?? raw.created_at;
  const startedAt = (() => {
    if (startRaw === undefined || startRaw === null || startRaw === "") return undefined;
    if (typeof startRaw === "number") return new Date(startRaw > 1e12 ? startRaw : startRaw * 1000);
    const d = new Date(startRaw as string);
    return Number.isNaN(d.getTime()) ? undefined : d;
  })();

  const recordingRaw = raw.recording_url ?? raw.recording;
  const recordingUrl = typeof recordingRaw === "string" && /^https?:\/\//i.test(recordingRaw) ? recordingRaw : undefined;

  const summary =
    typeof raw.summary === "string" ? raw.summary : typeof raw.call_summary === "string" ? raw.call_summary : undefined;

  const transcriptArr = Array.isArray(raw.transcript) ? (raw.transcript as AlloTranscriptEntry[]) : undefined;
  const transcriptPlain = typeof raw.transcription === "string" && raw.transcription.trim() ? raw.transcription : undefined;
  const transcription = transcriptArr?.length
    ? transcriptArr.map((e) => `${e.source}: ${e.text}`).join("\n")
    : transcriptPlain;

  return {
    id: String(raw.id ?? ""),
    providerCallId: String(raw.id ?? ""),
    from,
    to,
    direction,
    fromNumber: from,
    toNumber: to,
    status: typeof raw.outcome === "string" ? raw.outcome : undefined,
    startedAt,
    durationSec: duration,
    summary: summary?.trim() || undefined,
    transcription: transcription?.trim() || undefined,
    recordingUrl,
    raw,
  } as NormalizedCall & { id: string };
}

export interface AlloPageResult {
  calls: (NormalizedCall & { id: string })[];
  totalPages: number;
  httpOk: boolean;
  httpStatus: number;
}

/** Fetch one page of calls for an allo_number. Retries 429s and transient network errors. */
export async function fetchAlloPage(apiKey: string, alloNumber: string, page: number): Promise<AlloPageResult> {
  const url = new URL(`${BASE_URL}/v1/api/calls`);
  url.searchParams.set("allo_number", alloNumber);
  url.searchParams.set("size", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));

  for (let net = 0; net <= NETWORK_RETRIES; net++) {
    try {
      for (let attempt = 0; attempt <= RETRIES_429; attempt++) {
        const res = await fetch(url.toString(), {
          headers: { Authorization: apiKey },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        console.log(
          `[call-vault][allo] GET alloNumber=${alloNumber} page=${page} status=${res.status}` +
            (attempt > 0 ? ` (429 retry ${attempt}/${RETRIES_429})` : ""),
        );

        if (res.status === 429 && attempt < RETRIES_429) {
          const backoff = retryAfterMs(res) ?? Math.min(RETRY_429_BASE_MS * 2 ** attempt, 30_000);
          console.warn(`[call-vault][allo] 429 — waiting ${backoff}ms (line=${alloNumber} page=${page})`);
          await sleep(backoff);
          continue;
        }

        if (res.status === 401 || res.status === 403) {
          throw new Error(`Allo API auth error: ${res.status}`);
        }
        if (!res.ok) {
          return { calls: [], totalPages: 0, httpOk: false, httpStatus: res.status };
        }

        const data = await res.json();
        const { rawCalls, totalPages } = parseAlloCallsListResponse(data);
        const calls = rawCalls.map(normalizeAlloCall).filter((c) => c.id);
        return { calls, totalPages, httpOk: true, httpStatus: res.status };
      }
      return { calls: [], totalPages: 0, httpOk: false, httpStatus: 429 };
    } catch (e) {
      const retriable = isRetriableFetchError(e);
      if (net < NETWORK_RETRIES && retriable) {
        const backoff = Math.min(NETWORK_RETRY_BASE_MS * 2 ** net, 20_000);
        console.warn(
          `[call-vault][allo] fetch failed — retry ${net + 1}/${NETWORK_RETRIES} in ${backoff}ms ` +
            `line=${alloNumber} page=${page} hint=${fetchErrorHint(e)}`,
        );
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }

  return { calls: [], totalPages: 0, httpOk: false, httpStatus: 0 };
}
