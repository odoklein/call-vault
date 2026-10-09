import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedPglite } from "./helpers/pglite";

test("all migrations apply on a fresh Postgres, and the French search vector is generated", async () => {
  const pg = await migratedPglite();

  await pg.exec(`
    INSERT INTO "Provider" (id, slug, "displayName", "updatedAt") VALUES ('p1', 'allo', 'WithAllo', now());
    INSERT INTO "Call" (id, "providerId", "providerCallId", "fromNumber", "toNumber", "rawPayload", "updatedAt",
                        "aiSummary", transcription)
    VALUES ('c1', 'p1', 'x1', '+33600000001', '+33611111111', '{}', now(),
            'Rendez-vous fixé avec la responsable RH', 'PROSPECT: le recrutement des alternants en cuisine est ouvert');
  `);

  // French stemming: "alternance" matches "alternants" (both stem to 'altern'). Note the Snowball
  // stemmer does not conflate verb conjugations ("recrutons" stays 'recruton'), so searches are
  // noun-oriented — fine for how transcripts get queried.
  const hit = await pg.query<{ id: string }>(
    `SELECT id FROM "Call" WHERE "searchVector" @@ websearch_to_tsquery('french', $1)`,
    ["recrutement alternance"],
  );
  assert.deepEqual(hit.rows.map((r) => r.id), ["c1"]);

  // Generated column follows updates — nothing in the app maintains it.
  await pg.exec(`UPDATE "Call" SET transcription = 'PROSPECT: pas de budget cette année' WHERE id = 'c1'`);
  const stale = await pg.query(`SELECT id FROM "Call" WHERE "searchVector" @@ websearch_to_tsquery('french', 'cuisine')`);
  assert.equal(stale.rows.length, 0);
  const fresh = await pg.query(`SELECT id FROM "Call" WHERE "searchVector" @@ websearch_to_tsquery('french', 'budget')`);
  assert.equal(fresh.rows.length, 1);
});

test("CrmAction.callId is one-to-one: a vault call can back at most one CRM action", async () => {
  const pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "Provider" (id, slug, "displayName", "updatedAt") VALUES ('p1', 'allo', 'WithAllo', now());
    INSERT INTO "Call" (id, "providerId", "providerCallId", "fromNumber", "toNumber", "rawPayload", "updatedAt")
    VALUES ('c1', 'p1', 'x1', '+33600000001', '+33611111111', '{}', now());
    INSERT INTO "CrmAction" (id, "sdrUserId", "campaignId", "missionId", "clientId", result, "loggedAt", phones, "callId", "syncedAt")
    VALUES ('a1', 'u1', 'k1', 'm1', 'cl1', 'REFUS', now(), '{}', 'c1', now());
  `);
  await assert.rejects(
    pg.exec(`
      INSERT INTO "CrmAction" (id, "sdrUserId", "campaignId", "missionId", "clientId", result, "loggedAt", phones, "callId", "syncedAt")
      VALUES ('a2', 'u1', 'k1', 'm1', 'cl1', 'REFUS', now(), '{}', 'c1', now());
    `),
    /unique/i,
  );
});
