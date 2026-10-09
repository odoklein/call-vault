// The SQL in lib/crm/queries.ts executed for real against the subset of the CRM schema it reads
// (same table/column names and enum types as captainprospect-crm/prisma/schema.prisma).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { callActionsQuery, sdrNumbersQuery, type CrmCallActionRow, type CrmSdrNumberRow } from "../lib/crm/queries";
import { actionUpsertPlan, crmActionData, sdrOwnership } from "../lib/crm/directory-sync";
import { runSql } from "./helpers/pglite";

let crm: PGlite;

before(async () => {
  crm = new PGlite();
  await crm.exec(`
    CREATE TYPE "Channel" AS ENUM ('CALL', 'EMAIL', 'LINKEDIN');
    CREATE TYPE "ActionResult" AS ENUM ('NO_RESPONSE', 'REFUS', 'MEETING_BOOKED', 'RAPPEL');
    CREATE TABLE "User" (id text PRIMARY KEY, "alloPhoneNumber" text, "isActive" boolean NOT NULL DEFAULT true);
    CREATE TABLE "Mission" (id text PRIMARY KEY, "clientId" text NOT NULL);
    CREATE TABLE "Campaign" (id text PRIMARY KEY, "missionId" text NOT NULL);
    CREATE TABLE "Company" (id text PRIMARY KEY, phone text, "customData" jsonb);
    CREATE TABLE "Contact" (id text PRIMARY KEY, "companyId" text NOT NULL, phone text, "additionalPhones" jsonb);
    CREATE TABLE "Action" (
      id text PRIMARY KEY, "contactId" text, "companyId" text, "sdrId" text NOT NULL, "campaignId" text NOT NULL,
      channel "Channel" NOT NULL, result "ActionResult" NOT NULL, "meetingPhone" text,
      "createdAt" timestamp(3) NOT NULL);

    INSERT INTO "User" VALUES ('adam', '06 00 00 00 01', true), ('ex', '+33600000002', false), ('nophone', '  ', true);
    INSERT INTO "Mission" VALUES ('m1', 'client-orpi');
    INSERT INTO "Campaign" VALUES ('k1', 'm1');
    INSERT INTO "Company" VALUES ('co1', '02 40 00 00 00', '{"phones": ["02 40 99 99 99"]}');
    INSERT INTO "Contact" VALUES ('ct1', 'co1', '06 11 11 11 11', '["+33 6 22 22 22 22"]');
    INSERT INTO "Action" VALUES
      ('a1', 'ct1', NULL, 'adam', 'k1', 'CALL', 'REFUS', NULL, '2026-10-09 14:38:00'),
      ('a2', NULL, 'co1', 'adam', 'k1', 'CALL', 'MEETING_BOOKED', '06 33 33 33 33', '2026-10-09 14:44:00'),
      ('a3', 'ct1', NULL, 'adam', 'k1', 'EMAIL', 'REFUS', NULL, '2026-10-09 14:45:00'),
      ('a4', 'ct1', NULL, 'adam', 'k1', 'CALL', 'RAPPEL', NULL, '2026-10-09 14:44:00');
  `);
});

test("SDR numbers: blank numbers excluded", async () => {
  const rows = await runSql<CrmSdrNumberRow>(crm, sdrNumbersQuery());
  assert.deepEqual(rows.map((r) => r.id).sort(), ["adam", "ex"]);
});

test("CALL actions: joined to client, company resolved through the contact, timestamps stay UTC", async () => {
  const rows = await runSql<CrmCallActionRow>(crm, callActionsQuery("2026-10-09T00:00:00.000Z", "", 100));
  assert.deepEqual(rows.map((r) => r.id), ["a1", "a2", "a4"], "EMAIL excluded; ordered by (createdAt, id)");

  const a1 = rows[0];
  assert.equal(a1.clientId, "client-orpi");
  assert.equal(a1.missionId, "m1");
  assert.equal(a1.companyId, "co1", "company comes from the contact when the action has none");
  assert.equal(a1.loggedAt, "2026-10-09T14:38:00.000Z");
  assert.equal(a1.result, "REFUS");

  assert.deepEqual(crmActionData(a1).phones, ["+33611111111", "+33622222222", "+33240000000", "+33240999999"]);
  assert.deepEqual(crmActionData(rows[1]).phones, ["+33633333333", "+33240000000", "+33240999999"]);
});

test("CALL actions: keyset pagination resumes after (createdAt, id) without skipping ties", async () => {
  const page1 = await runSql<CrmCallActionRow>(crm, callActionsQuery("2026-10-09T00:00:00.000Z", "", 2));
  assert.deepEqual(page1.map((r) => r.id), ["a1", "a2"]);
  const last = page1[page1.length - 1];
  const page2 = await runSql<CrmCallActionRow>(crm, callActionsQuery(last.loggedAt, last.id, 2));
  assert.deepEqual(page2.map((r) => r.id), ["a4"], "a4 shares a2's timestamp and must not be skipped");
});

test("SDR ownership: active user wins a reassigned number; two active users is a conflict", () => {
  const { owners, conflicts } = sdrOwnership([
    { id: "left", alloPhoneNumber: "+33600000009", isActive: false },
    { id: "new", alloPhoneNumber: "06 00 00 00 09", isActive: true },
    { id: "x", alloPhoneNumber: "+33600000008", isActive: true },
    { id: "y", alloPhoneNumber: "0600000008", isActive: true },
    { id: "solo-inactive", alloPhoneNumber: "+33600000007", isActive: false },
  ]);
  assert.equal(owners.get("+33600000009")?.userId, "new");
  assert.equal(owners.has("+33600000008"), false);
  assert.deepEqual(conflicts, ["+33600000008"]);
  assert.equal(owners.get("+33600000007")?.userId, "solo-inactive", "history still attributable");
});

test("action mirror: unchanged rows aren't rewritten, matches survive edits, new phones retry unmatched", () => {
  const data = {
    sdrUserId: "adam", contactId: "ct1", companyId: "co1", campaignId: "k1", missionId: "m1",
    clientId: "c", result: "REFUS", loggedAt: new Date(), phones: ["+33611111111"],
  };
  assert.equal(actionUpsertPlan(null, data)?.data.matchStatus, "PENDING");
  assert.equal(actionUpsertPlan(null, { ...data, phones: [] })?.data.matchStatus, "NO_PHONE");
  assert.equal(actionUpsertPlan({ ...data, matchStatus: "PENDING" }, data), null);

  const matchedEdit = actionUpsertPlan({ ...data, matchStatus: "MATCHED" }, { ...data, phones: ["+33699999999"] });
  assert.equal(matchedEdit?.data.matchStatus, undefined, "a made match is not reset");

  const retry = actionUpsertPlan({ ...data, phones: [], matchStatus: "NO_PHONE" }, data);
  assert.equal(retry?.data.matchStatus, "PENDING");
});
