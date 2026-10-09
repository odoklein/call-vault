// lib/calls/search.ts + lib/coverage.ts SQL, executed on the real migrated schema (PGlite).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { callSearchQuery, paginate, type CallSearchRow } from "../lib/calls/search";
import { actionCountsQuery, buildCoverage, callCountsQuery, missingTranscriptsQuery, type SdrActionCounts, type SdrCallCounts } from "../lib/coverage";
import { migratedPglite, runSql } from "./helpers/pglite";

let pg: PGlite;
const SWITCHBOARD = "+33240000000";

before(async () => {
  pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "Provider" (id, slug, "displayName", "updatedAt") VALUES ('p', 'allo', 'WithAllo', now());
    INSERT INTO "Line" (id, "providerId", "externalNumber", "crmUserId") VALUES
      ('l-adam', 'p', '+33600000001', 'adam'), ('l-maxime', 'p', '+33600000002', 'maxime'), ('l-ghost', 'p', '+33600000003', NULL);
    INSERT INTO "SyncCursor" (id, "providerId", "lineId", "lastSyncAt", "updatedAt") VALUES
      ('s1', 'p', 'l-adam', now(), now()), ('s2', 'p', 'l-maxime', now() - interval '2 hours', now());

    INSERT INTO "Call" (id, "providerId", "providerCallId", "lineId", "fromNumber", "toNumber", "remoteNumber",
                        "startedAt", "durationSec", transcription, "aiSummary", "recordingStatus", "rawPayload", "updatedAt") VALUES
      -- client A (Orpi) conversation about alternance, linked
      ('cA', 'p', 'x1', 'l-adam', '+33600000001', '${SWITCHBOARD}', '${SWITCHBOARD}', '2026-10-09 14:35:00', 150,
        'EXTERNAL: nous sommes chez Orpi depuis vingt ans\nUSER: je comprends, et pour l''alternance ?', 'Refus, déjà chez Orpi', 'STORED', '{}', now()),
      -- client B, SAME switchboard number, linked to B
      ('cB', 'p', 'x2', 'l-maxime', '+33600000002', '${SWITCHBOARD}', '${SWITCHBOARD}', '2026-10-09 15:00:00', 300,
        'EXTERNAL: on cherche un alternant en cuisine', 'Intéressé, alternance cuisine', 'NONE', '{}', now()),
      -- unlinked conversation to the switchboard (never logged in the CRM), no transcript
      ('cU', 'p', 'x3', 'l-adam', '+33600000001', '${SWITCHBOARD}', '${SWITCHBOARD}', '2026-10-09 09:00:00', 95,
        NULL, NULL, 'FAILED', '{}', now()),
      -- short no-answer on an unmapped line
      ('cG', 'p', 'x4', 'l-ghost', '+33600000003', '+33611111111', '+33611111111', '2026-10-09 10:00:00', 0,
        NULL, NULL, 'NONE', '{}', now());

    INSERT INTO "CrmAction" (id, "sdrUserId", "contactId", "companyId", "campaignId", "missionId", "clientId", result,
                             "loggedAt", phones, "callId", "matchStatus", "matchConfidence", "matchReason", "syncedAt") VALUES
      ('aA', 'adam', 'ct-A', 'co-A', 'k', 'mA', 'client-A', 'REFUS', '2026-10-09 14:38:00', '{${SWITCHBOARD}}', 'cA', 'MATCHED', 'HIGH', 'same SDR line, ended 1m before log, 150s', now()),
      ('aB', 'maxime', 'ct-B', 'co-B', 'k', 'mB', 'client-B', 'RAPPEL', '2026-10-09 15:06:00', '{${SWITCHBOARD}}', 'cB', 'MATCHED', 'HIGH', 'x', now()),
      ('aX', 'adam', 'ct-A', 'co-A', 'k', 'mA', 'client-A', 'NO_RESPONSE', '2026-10-09 11:00:00', '{+33699999999}', NULL, 'UNMATCHED', NULL, NULL, now()),
      ('aZ', 'zoe', NULL, 'co-Z', 'k', 'mZ', 'client-A', 'REFUS', '2026-10-09 12:00:00', '{+33688888888}', NULL, 'PENDING', NULL, NULL, now());
  `);
});

const search = (p: Partial<Parameters<typeof callSearchQuery>[0]>) => runSql<CallSearchRow>(pg, callSearchQuery({ limit: 20, ...p }));

test("tenant isolation: a client-bound search never sees another client's call on the same number", async () => {
  const a = await search({ crmClientId: "client-A" });
  assert.deepEqual(a.map((r) => r.id), ["cA"]);
  const aByPhone = await search({ crmClientId: "client-A", phones: [SWITCHBOARD] });
  assert.deepEqual(aByPhone.map((r) => r.id), ["cA"], "phone filter can't widen a tenant's view");
  const b = await search({ crmClientId: "client-B", q: "alternance" });
  assert.deepEqual(b.map((r) => r.id), ["cB"]);
  const wrongMission = await search({ crmClientId: "client-A", crmMissionId: "mB" });
  assert.deepEqual(wrongMission, []);
});

test("internal (no tenant) phone lookup sees every call to the number, linked or not", async () => {
  const rows = await search({ phones: ["02 40 00 00 00"] });
  assert.deepEqual(rows.map((r) => r.id), ["cB", "cA", "cU"]);
  assert.equal(rows.find((r) => r.id === "cU")?.actionId, null);
});

test("full-text search in French with highlighted snippet and link info", async () => {
  const [hit] = await search({ q: "alternance" , crmClientId: "client-A" });
  assert.equal(hit.id, "cA");
  assert.match(hit.snippet ?? "", /«alternance»/);
  assert.equal(hit.contactId, "ct-A");
  assert.equal(hit.sdrUserId, "adam");
  assert.equal(hit.matchConfidence, "HIGH");
  assert.equal(hit.hasTranscript, true);
  assert.equal(hit.hasRecording, true);
  assert.equal(hit.startedAt, "2026-10-09T14:35:00.000Z");
});

test("filters: SDR (via link or line owner), transcript presence, date range", async () => {
  assert.deepEqual((await search({ sdrUserId: "adam" })).map((r) => r.id), ["cA", "cU"]);
  assert.deepEqual((await search({ hasTranscript: false })).map((r) => r.id), ["cG", "cU"]);
  assert.deepEqual(
    (await search({ from: new Date("2026-10-09T14:00:00Z"), to: new Date("2026-10-09T15:00:00Z") })).map((r) => r.id),
    ["cA"],
  );
  assert.deepEqual((await search({ actionId: "aB" })).map((r) => r.id), ["cB"]);
});

test("keyset pagination walks every row exactly once", async () => {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const rows = await search({ limit: 1, cursor });
    const page = paginate(rows, 1);
    seen.push(...page.items.map((r) => r.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, ["cB", "cA", "cG", "cU"]);
});

test("coverage: per-SDR counts, unlogged conversations, missing transcripts, SDRs with no line", async () => {
  const from = new Date("2026-10-09T00:00:00Z");
  const to = new Date("2026-10-10T00:00:00Z");
  const now = new Date("2026-10-10T12:00:00Z");
  const actionCounts = await runSql<SdrActionCounts>(pg, actionCountsQuery(from, to));
  const callCounts = await runSql<SdrCallCounts>(pg, callCountsQuery(from, to, now));
  const missing = await runSql<{ id: string }>(pg, missingTranscriptsQuery(from, to, now));

  const report = buildCoverage({
    from, to, now, actionCounts, callCounts,
    lines: [
      { id: "l-adam", number: "+33600000001", source: "env", sdrUserId: "adam", isActive: true, lastSyncAt: null, stale: false, lastError: null, backfill: null },
      { id: "l-maxime", number: "+33600000002", source: "crm", sdrUserId: "maxime", isActive: true, lastSyncAt: null, stale: true, lastError: null, backfill: null },
    ],
    missingTranscripts: missing as never,
  });

  const adam = report.bySdr.find((r) => r.sdrUserId === "adam")!;
  assert.equal(adam.actions, 2);
  assert.equal(adam.matched, 1);
  assert.equal(adam.matchedHigh, 1);
  assert.equal(adam.unmatched, 1);
  assert.equal(adam.calls, 2);
  assert.equal(adam.conversations, 2);
  assert.equal(adam.withTranscript, 1);
  assert.equal(adam.missingTranscript, 1);
  assert.equal(adam.unloggedConversations, 1);
  assert.equal(adam.recordingsFailed, 1);

  assert.deepEqual(report.sdrsWithoutLine, ["zoe"], "zoe logs calls but the vault syncs no line of hers");
  assert.equal(report.unmappedLineCalls?.calls, 1);
  assert.deepEqual(missing.map((m) => m.id), ["cU"]);
  assert.equal(report.totals.calls, 4);
  assert.equal(report.totals.actions, 4);
});
