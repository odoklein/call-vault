import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiSource, CrmSourceError, encodeCrmCursor, getCrmSource } from "../lib/crm/source";

type Call = { url: URL; auth: string | null };

function fakeFetch(handler: (url: URL) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const r = handler(url);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const apiAction = {
  id: "a1", sdr_id: "u1", contact_id: "ct1", company_id: "co1", campaign_id: "k1", mission_id: "m1", client_id: "c1",
  result: "REFUS", logged_at: "2026-10-09T14:38:00.000Z", meeting_phone: "06 33", contact_phone: "06 11",
  contact_additional_phones: ["+33 6 22"], company_phone: "02 40", company_custom_data: { phones: ["02 99"] },
};

test("API source: sends the Bearer key, maps SDR numbers to the sync's row shape", async () => {
  const f = fakeFetch(() => ({ body: { data: [{ id: "u1", allo_phone_number: "06 00 00 00 01", is_active: true }] } }));
  const src = createApiSource("https://app.captainprospect.fr/", "cp_live_x", f.impl);
  assert.deepEqual(await src.sdrNumbers(), [{ id: "u1", alloPhoneNumber: "06 00 00 00 01", isActive: true }]);
  assert.equal(f.calls[0].url.toString(), "https://app.captainprospect.fr/api/v1/vault/sdr-numbers");
  assert.equal(f.calls[0].auth, "Bearer cp_live_x");
  assert.equal(src.describe(), "CRM API app.captainprospect.fr");
});

test("API source: first page uses `since`, later pages hand the keyset back as the CRM's cursor", async () => {
  const f = fakeFetch(() => ({ body: { data: [apiAction], pagination: {} } }));
  const src = createApiSource("https://app.captainprospect.fr", "k", f.impl);

  const rows = await src.callActions("2026-10-09T00:00:00.000Z", "", 1000);
  assert.equal(f.calls[0].url.searchParams.get("since"), "2026-10-09T00:00:00.000Z");
  assert.equal(f.calls[0].url.searchParams.get("cursor"), null);
  assert.equal(f.calls[0].url.searchParams.get("limit"), "1000");
  assert.deepEqual(rows[0], {
    id: "a1", sdrId: "u1", contactId: "ct1", companyId: "co1", campaignId: "k1", missionId: "m1", clientId: "c1", result: "REFUS",
    loggedAt: "2026-10-09T14:38:00.000Z", meetingPhone: "06 33", contactPhone: "06 11", contactAdditionalPhones: ["+33 6 22"],
    companyPhone: "02 40", companyCustomData: { phones: ["02 99"] },
  });

  await src.callActions("2026-10-09T14:38:00.000Z", "a1", 500);
  const cursor = f.calls[1].url.searchParams.get("cursor")!;
  assert.deepEqual(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")), { t: "2026-10-09T14:38:00.000Z", id: "a1" });
  assert.equal(cursor, encodeCrmCursor("2026-10-09T14:38:00.000Z", "a1"));
  assert.equal(f.calls[1].url.searchParams.get("since"), null);
});

test("API source: an expired/revoked key and a non-internal key give actionable errors", async () => {
  const expired = createApiSource("https://crm.example", "k", fakeFetch(() => ({ status: 401 })).impl);
  await assert.rejects(expired.sdrNumbers(), (e) => e instanceof CrmSourceError && /EXPIRED/.test(e.message) && /90 days/.test(e.message));

  const forbidden = createApiSource("https://crm.example", "k", fakeFetch(() => ({ status: 403 })).impl);
  await assert.rejects(forbidden.callActions("2026-10-09T00:00:00Z", "", 10), (e) => e instanceof CrmSourceError && /all-clients/.test(e.message));

  const down = createApiSource("https://crm.example", "k", (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  await assert.rejects(down.sdrNumbers(), /unreachable/);
});

test("source selection: API wins over DB, nothing configured = null", () => {
  assert.equal(getCrmSource({ CRM_API_URL: "https://app.captainprospect.fr", CRM_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)?.kind, "api");
  assert.equal(getCrmSource({ CRM_API_URL: "https://app.captainprospect.fr" } as unknown as NodeJS.ProcessEnv), null, "URL without key is not enough");
});
