// Where the vault reads CRM data from. Two interchangeable sources behind one interface:
//   * API (preferred): CRM_API_URL + CRM_API_KEY -> GET {CRM}/api/v1/vault/*  (e.g.
//     https://app.captainprospect.fr). No database exposure; key-authenticated and audited on the CRM.
//   * DB (fallback): CRM_DATABASE_URL -> read-only SQL (lib/crm/queries.ts).
// directory-sync.ts only sees CrmSource, so the matching logic is identical either way.

import type { PrismaClient } from "@prisma/client";
import { getCrmDb } from "./db";
import { callActionsQuery, sdrNumbersQuery, type CrmCallActionRow, type CrmSdrNumberRow } from "./queries";

export interface CrmSource {
  kind: "api" | "db";
  describe(): string;
  sdrNumbers(): Promise<CrmSdrNumberRow[]>;
  /** CALL actions strictly after (sinceIso, afterId) in (log time, id) order. */
  callActions(sinceIso: string, afterId: string, limit: number): Promise<CrmCallActionRow[]>;
}

export class CrmSourceError extends Error {}

// ---- API ----

interface ApiSdrNumber {
  id: string;
  allo_phone_number: string;
  is_active: boolean;
}

interface ApiCallAction {
  id: string;
  sdr_id: string;
  contact_id: string | null;
  company_id: string | null;
  campaign_id: string;
  mission_id: string;
  client_id: string;
  result: string;
  logged_at: string;
  meeting_phone: string | null;
  contact_phone: string | null;
  contact_additional_phones: unknown;
  company_phone: string | null;
  company_custom_data: unknown;
}

/** Same opaque cursor encoding as the CRM (lib/api-v1/pagination.ts): base64url(JSON). */
export const encodeCrmCursor = (t: string, id: string) => Buffer.from(JSON.stringify({ t, id })).toString("base64url");

export function createApiSource(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): CrmSource {
  const base = baseUrl.replace(/\/+$/, "");

  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new CrmSourceError(`CRM API unreachable (${url.host}): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401) {
      throw new CrmSourceError("CRM API rejected CRM_API_KEY (invalid, revoked or EXPIRED — all-clients CRM keys live at most 90 days: mint a new one)");
    }
    if (res.status === 403) {
      throw new CrmSourceError("CRM API refused CRM_API_KEY: it must be an internal all-clients key with the calls:read scope");
    }
    if (!res.ok) throw new CrmSourceError(`CRM API error status=${res.status} path=${url.pathname}`);
    return ((await res.json()) as { data: T }).data;
  }

  return {
    kind: "api",
    describe: () => `CRM API ${new URL(base).host}`,

    async sdrNumbers() {
      const rows = await get<ApiSdrNumber[]>("/api/v1/vault/sdr-numbers", {});
      return rows.map((r) => ({ id: r.id, alloPhoneNumber: r.allo_phone_number, isActive: r.is_active }));
    },

    async callActions(sinceIso, afterId, limit) {
      const params: Record<string, string> = { limit: String(limit) };
      if (afterId) params.cursor = encodeCrmCursor(sinceIso, afterId);
      else params.since = sinceIso;
      const rows = await get<ApiCallAction[]>("/api/v1/vault/call-actions", params);
      return rows.map((r) => ({
        id: r.id,
        sdrId: r.sdr_id,
        contactId: r.contact_id,
        companyId: r.company_id,
        campaignId: r.campaign_id,
        missionId: r.mission_id,
        clientId: r.client_id,
        result: r.result,
        loggedAt: r.logged_at,
        meetingPhone: r.meeting_phone,
        contactPhone: r.contact_phone,
        contactAdditionalPhones: r.contact_additional_phones,
        companyPhone: r.company_phone,
        companyCustomData: r.company_custom_data,
      }));
    },
  };
}

// ---- DB ----

export function createDbSource(db: PrismaClient): CrmSource {
  return {
    kind: "db",
    describe: () => "CRM database (read-only)",
    sdrNumbers: () => db.$queryRaw<CrmSdrNumberRow[]>(sdrNumbersQuery()),
    callActions: (sinceIso, afterId, limit) => db.$queryRaw<CrmCallActionRow[]>(callActionsQuery(sinceIso, afterId, limit)),
  };
}

/** API when CRM_API_URL + CRM_API_KEY are set, else the database when CRM_DATABASE_URL is, else null. */
export function getCrmSource(env: NodeJS.ProcessEnv = process.env): CrmSource | null {
  if (env.CRM_API_URL && env.CRM_API_KEY) return createApiSource(env.CRM_API_URL, env.CRM_API_KEY);
  const db = getCrmDb();
  return db ? createDbSource(db) : null;
}
