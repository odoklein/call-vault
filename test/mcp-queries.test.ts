// lib/mcp/queries.ts on the real migrated schema (PGlite): the standalone MCP is keyed on phone only.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { mcpPaginate, mcpSearchQuery, type McpCallRow } from "../lib/mcp/queries";
import { migratedPglite, runSql } from "./helpers/pglite";

let pg: PGlite;

before(async () => {
  pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "Provider" (id, slug, "displayName", "updatedAt") VALUES ('p', 'allo', 'WithAllo', now());
    INSERT INTO "Line" (id, "providerId", "externalNumber", label) VALUES
      ('l1', 'p', '+33600000001', 'Adam'), ('l2', 'p', '+33600000002', 'Maxime');
    INSERT INTO "Call" (id, "providerId", "providerCallId", "lineId", direction, "fromNumber", "toNumber", "remoteNumber",
                        "startedAt", "durationSec", transcription, "aiSummary", "recordingStatus", "rawPayload", "updatedAt") VALUES
      ('c1', 'p', 'x1', 'l1', 'OUTBOUND', '+33600000001', '+33612345678', '+33612345678', '2026-10-09 14:35:00', 150,
        'USER: bonjour\nEXTERNAL: nous cherchons un alternant', 'Intéressé par une alternance', 'STORED', '{}', now()),
      ('c2', 'p', 'x2', 'l2', 'INBOUND', '+33612345678', '+33600000002', '+33612345678', '2026-10-10 09:00:00', 60,
        NULL, NULL, 'NONE', '{}', now()),
      ('c3', 'p', 'x3', 'l1', 'OUTBOUND', '+33600000001', '+33699999999', '+33699999999', '2026-10-10 10:00:00', 0,
        NULL, NULL, 'NONE', '{}', now());
  `);
});

const search = (p: Partial<Parameters<typeof mcpSearchQuery>[0]>) => runSql<McpCallRow>(pg, mcpSearchQuery({ limit: 20, ...p }));

test("phone lookup accepts any format and returns every call with that number, newest first", async () => {
  assert.deepEqual((await search({ phones: ["06 12 34 56 78"] })).map((r) => r.id), ["c2", "c1"]);
  assert.deepEqual((await search({ phones: ["not a number"] })), []);
});

test("rows carry no CRM identifiers", async () => {
  const [row] = await search({ phones: ["+33612345678"], q: "alternance" });
  assert.equal(row.id, "c1");
  assert.match(row.snippet ?? "", /«alternan/);
  assert.equal(row.phone, "+33612345678");
  assert.equal(row.lineLabel, "Adam");
  assert.deepEqual(Object.keys(row).filter((k) => /action|contact|company|mission|client/i.test(k)), []);
});

test("line grants and direction filter apply", async () => {
  assert.deepEqual((await search({ lineIds: ["l2"] })).map((r) => r.id), ["c2"]);
  assert.deepEqual(await search({ lineIds: [] }), []);
  assert.deepEqual((await search({ direction: "INBOUND" })).map((r) => r.id), ["c2"]);
});

test("keyset pagination", async () => {
  const page1 = mcpPaginate(await search({ limit: 2 }), 2);
  assert.deepEqual(page1.items.map((r) => r.id), ["c3", "c2"]);
  const page2 = mcpPaginate(await search({ limit: 2, cursor: page1.nextCursor! }), 2);
  assert.deepEqual(page2.items.map((r) => r.id), ["c1"]);
  assert.equal(page2.nextCursor, null);
});
