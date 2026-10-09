// Client isolation: the SQL behind the board and the search, executed on the real migrated schema.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { canSeeLine, visibleLineIds, type Viewer } from "../lib/access";
import { boardByLineQuery, boardTotalsQuery, periodRange, type BoardLineRow, type BoardTotals } from "../lib/board";
import { callSearchQuery, type CallSearchRow } from "../lib/calls/search";
import { hashPassword, verifyPassword, generatePassword } from "../lib/auth/password";
import { migratedPglite, runSql } from "./helpers/pglite";

let pg: PGlite;

before(async () => {
  pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "Provider" (id, slug, "displayName", "updatedAt") VALUES ('p', 'allo', 'WithAllo', now());
    INSERT INTO "Line" (id, "providerId", "externalNumber", label) VALUES
      ('l-cp1', 'p', '+33600000001', 'CP équipe 1'), ('l-cp2', 'p', '+33600000002', NULL),
      ('l-other', 'p', '+33600000003', 'Autre client'), ('l-private', 'p', '+33600000004', 'Interne Suzali');
    INSERT INTO "Client" (id, name, slug, "updatedAt") VALUES ('cp', 'Captain Prospect', 'cp', now()), ('oth', 'Autre', 'oth', now());
    INSERT INTO "ClientLine" ("clientId", "lineId") VALUES ('cp', 'l-cp1'), ('cp', 'l-cp2'), ('oth', 'l-other');

    INSERT INTO "Call" (id, "providerId", "providerCallId", "lineId", "fromNumber", "toNumber", "remoteNumber", "startedAt",
                        "durationSec", transcription, "aiSummary", "recordingStatus", "rawPayload", "updatedAt") VALUES
      ('c1', 'p', 'x1', 'l-cp1', '+33600000001', '+33240000000', '+33240000000', now() - interval '1 day', 120, 'EXTERNAL: bonjour alternance', 'Résumé 1', 'STORED', '{}', now()),
      ('c2', 'p', 'x2', 'l-cp2', '+33600000002', '+33240000000', '+33240000000', now() - interval '2 days', 10, NULL, NULL, 'NONE', '{}', now()),
      ('c3', 'p', 'x3', 'l-other', '+33600000003', '+33240000000', '+33240000000', now() - interval '1 day', 300, 'EXTERNAL: alternance aussi', 'Résumé 3', 'STORED', '{}', now()),
      ('c4', 'p', 'x4', 'l-private', '+33600000004', '+33240000000', '+33240000000', now() - interval '1 day', 500, 'EXTERNAL: secret interne', 'Résumé 4', 'STORED', '{}', now()),
      ('c5', 'p', 'x5', NULL, '+33699999999', '+33240000000', '+33240000000', now() - interval '1 day', 60, 'EXTERNAL: orphelin', NULL, 'NONE', '{}', now());
  `);
});

const cp: Viewer = { kind: "client", clientId: "cp", clientName: "Captain Prospect", lineIds: ["l-cp1", "l-cp2"] };
const admin: Viewer = { kind: "admin" };
const none: Viewer = { kind: "client", clientId: "x", clientName: "Sans numéro", lineIds: [] };
const search = (v: Viewer, extra: Partial<Parameters<typeof callSearchQuery>[0]> = {}) =>
  runSql<CallSearchRow>(pg, callSearchQuery({ lineIds: visibleLineIds(v), limit: 50, ...extra }));

test("a client searches only its granted numbers — even by shared remote number or text", async () => {
  assert.deepEqual((await search(cp)).map((r) => r.id).sort(), ["c1", "c2"]);
  assert.deepEqual((await search(cp, { phones: ["+33240000000"] })).map((r) => r.id).sort(), ["c1", "c2"]);
  assert.deepEqual((await search(cp, { q: "alternance" })).map((r) => r.id), ["c1"], "c3 matches the words but is another client's");
  assert.deepEqual(await search(cp, { q: "secret" }), [], "the internal line's content never surfaces");
});

test("admin sees every call, including unattributed ones; a client with no grants sees nothing", async () => {
  assert.deepEqual((await search(admin)).map((r) => r.id).sort(), ["c1", "c2", "c3", "c4", "c5"]);
  assert.deepEqual(await search(none), []);
});

test("search rows carry the line's number and label for display", async () => {
  const [row] = await search(cp, { q: "alternance" });
  assert.equal(row.lineNumber, "+33600000001");
  assert.equal(row.lineLabel, "CP équipe 1");
});

test("board totals and per-line breakdown are restricted the same way", async () => {
  const totals = await runSql<BoardTotals>(pg, boardTotalsQuery(visibleLineIds(cp)));
  assert.equal(totals[0].calls, 2);
  assert.equal(totals[0].conversations, 1);
  assert.equal(totals[0].withRecording, 1);
  assert.equal(totals[0].talkSec, 130);

  const lines = await runSql<BoardLineRow>(pg, boardByLineQuery(visibleLineIds(cp)));
  assert.deepEqual(lines.map((l) => l.lineId).sort(), ["l-cp1", "l-cp2"]);

  const adminTotals = await runSql<BoardTotals>(pg, boardTotalsQuery(undefined));
  assert.equal(adminTotals[0].calls, 5);
  assert.equal((await runSql<BoardTotals>(pg, boardTotalsQuery([])))[0].calls, 0);
});

test("period filter bounds the board", async () => {
  const { from } = periodRange("7d", new Date());
  assert.equal((await runSql<BoardTotals>(pg, boardTotalsQuery(visibleLineIds(cp), from)))[0].calls, 2);
  assert.ok(!periodRange("all").from);
  assert.equal(periodRange("garbage").key, "30d");
});

test("canSeeLine: clients see only granted lines, never unattributed calls; admins see all", () => {
  assert.ok(canSeeLine(cp, "l-cp1"));
  assert.ok(!canSeeLine(cp, "l-other"));
  assert.ok(!canSeeLine(cp, null));
  assert.ok(canSeeLine(admin, null));
  assert.ok(!canSeeLine(none, "l-cp1"));
});

test("users: ADMIN must have no client and CLIENT must have one (DB constraint)", async () => {
  const ins = (role: string, clientId: string | null) =>
    pg.query(
      `INSERT INTO "User" (id, email, name, "passwordHash", role, "clientId", "updatedAt") VALUES ($1, $1 || '@x.fr', 'n', 'h', $2::"UserRole", $3, now())`,
      [`u-${role}-${clientId}`, role, clientId],
    );
  await ins("ADMIN", null);
  await ins("CLIENT", "cp");
  await assert.rejects(ins("ADMIN", "cp"), /check/i);
  await assert.rejects(ins("CLIENT", null), /check/i);
});

test("a client's API key and its grants disappear with the client (cascade)", async () => {
  await pg.exec(`
    INSERT INTO "Client" (id, name, slug, "updatedAt") VALUES ('tmp', 'Tmp', 'tmp', now());
    INSERT INTO "ClientLine" ("clientId", "lineId") VALUES ('tmp', 'l-private');
    INSERT INTO "ApiKey" (id, name, "keyHash", "keyPrefix", "clientId", "updatedAt") VALUES ('k1', 'k', 'h1', 'vault_live_', 'tmp', now());
    DELETE FROM "Client" WHERE id = 'tmp';
  `);
  assert.equal((await pg.query(`SELECT 1 FROM "ApiKey" WHERE id = 'k1'`)).rows.length, 0);
  assert.equal((await pg.query(`SELECT 1 FROM "ClientLine" WHERE "clientId" = 'tmp'`)).rows.length, 0);
  assert.equal((await pg.query(`SELECT 1 FROM "Line" WHERE id = 'l-private'`)).rows.length, 1, "the line itself stays");
});

test("passwords: scrypt round-trip, wrong password rejected, generated ones are readable", async () => {
  const h = await hashPassword("correct horse battery");
  assert.ok(h.startsWith("scrypt$"));
  assert.ok(await verifyPassword("correct horse battery", h));
  assert.ok(!(await verifyPassword("wrong", h)));
  assert.ok(!(await verifyPassword("x", "garbage")));
  assert.match(generatePassword(), /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
});
