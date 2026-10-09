import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAlloCall, parseDate } from "../lib/providers/allo/normalize";

test("call times never depend on the worker host's time zone", () => {
  assert.equal(parseDate("2026-10-09T14:35:00")?.toISOString(), "2026-10-09T14:35:00.000Z");
  assert.equal(parseDate("2026-10-09 14:35:00.250")?.toISOString(), "2026-10-09T14:35:00.250Z");
  assert.equal(parseDate("2026-10-09T16:35:00+02:00")?.toISOString(), "2026-10-09T14:35:00.000Z");
  assert.equal(parseDate("2026-10-09T14:35:00Z")?.toISOString(), "2026-10-09T14:35:00.000Z");
  assert.equal(parseDate(1791556500)?.toISOString(), "2026-10-09T14:35:00.000Z");
  assert.equal(parseDate("not a date"), undefined);
});
import { phonesFromJson, toE164, toE164List } from "../lib/phone";

test("Allo transcript array becomes role-tagged segments; plain text format unchanged", () => {
  const c = normalizeAlloCall({
    id: "abc",
    from: "+33600000001",
    to: "+33611111111",
    type: "OUTBOUND",
    duration: 120,
    start_time: "2026-10-05T13:10:00Z",
    transcript: [
      { source: "EXTERNAL", text: "Restaurant La Bûchoire, bonjour." },
      { source: "USER", text: "Bonjour, je suis Théodore de MBS Éducation." },
      { source: "USER", text: "   " },
    ],
    summary: "  Échange sur un alternant en salle  ",
    recording_url: "https://api.withallo.com/rec/abc",
  });
  assert.equal(c.providerCallId, "abc");
  assert.deepEqual(
    c.transcriptSegments?.map((s) => [s.speaker, s.source]),
    [["PROSPECT", "EXTERNAL"], ["SDR", "USER"]],
  );
  assert.equal(c.transcription, "EXTERNAL: Restaurant La Bûchoire, bonjour.\nUSER: Bonjour, je suis Théodore de MBS Éducation.");
  assert.equal(c.summary, "Échange sur un alternant en salle");
  assert.equal(c.endedAt?.toISOString(), "2026-10-05T13:12:00.000Z");
  assert.equal(c.recordingUrl, "https://api.withallo.com/rec/abc");
});

test("phone normalization covers the formats found in CRM free text", () => {
  assert.equal(toE164("06 95 50 12 33"), "+33695501233");
  assert.equal(toE164("+33 6 95 50 12 33"), "+33695501233");
  assert.equal(toE164("0033695501233"), "+33695501233");
  assert.equal(toE164("33695501233"), "+33695501233");
  assert.equal(toE164("06.95.50.12.33"), "+33695501233");
  assert.equal(toE164("+32 470 12 34 56"), "+32470123456");
  assert.equal(toE164(""), null);
  assert.equal(toE164("n/a"), null);
  assert.equal(toE164(null), null);
  assert.deepEqual(toE164List(["06 95 50 12 33", "+33695501233", "x"]), ["+33695501233"]);
});

test("phones out of CRM Json columns", () => {
  assert.deepEqual(phonesFromJson(["+33 6 12 34 56 78", { number: "0611111111" }, { phone: "0622222222" }]), [
    "+33 6 12 34 56 78",
    "0611111111",
    "0622222222",
  ]);
  assert.deepEqual(phonesFromJson({ additionalPhones: ["01"], phones: "02", other: "x" }), ["01", "02"]);
  assert.deepEqual(phonesFromJson(null), []);
});
