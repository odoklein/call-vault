import { test } from "node:test";
import assert from "node:assert/strict";
import { callWriteData } from "../lib/sync/persist";
import type { NormalizedCall } from "../lib/providers/types";

const NOW = new Date("2026-10-09T12:00:00Z");

const base: NormalizedCall = {
  providerCallId: "x1",
  direction: "OUTBOUND",
  fromNumber: "+33600000001",
  toNumber: "06 11 11 11 11",
  durationSec: 95,
  startedAt: new Date("2026-10-09T11:00:00Z"),
  raw: { id: "x1" },
};

test("first sighting: remote number normalized to E.164, transcript timestamped", () => {
  const w = callWriteData({ ...base, transcription: "USER: allô" }, null, "line1", NOW);
  assert.equal(w.create.remoteNumber, "+33611111111");
  assert.equal(w.create.lineId, "line1");
  assert.equal(w.create.transcriptAt, NOW);
  assert.equal(w.create.recordingStatus, "NONE");
  assert.equal(w.wantsMirror, false);
});

test("inbound calls use the caller as the remote party", () => {
  const w = callWriteData({ ...base, direction: "INBOUND", fromNumber: "+32470123456", toNumber: "+33600000001" }, null, "l", NOW);
  assert.equal(w.create.remoteNumber, "+32470123456");
});

test("a later sighting without content never erases transcript or summary", () => {
  const w = callWriteData({ ...base, durationSec: 0 }, { id: "c1", recordingStatus: "NONE", transcriptAt: null }, "l", NOW);
  assert.ok(!("transcription" in w.update));
  assert.ok(!("aiSummary" in w.update));
  assert.ok(!("transcriptSegments" in w.update));
  assert.ok(!("durationSec" in w.update), "a 0 duration doesn't overwrite a known one");
});

test("transcript that settles after the call is written and timestamped on that sighting", () => {
  const w = callWriteData(
    { ...base, transcription: "EXTERNAL: oui", summary: "Rappel lundi" },
    { id: "c1", recordingStatus: "NONE", transcriptAt: null },
    "l",
    NOW,
  );
  assert.equal(w.update.transcription, "EXTERNAL: oui");
  assert.equal(w.update.aiSummary, "Rappel lundi");
  assert.equal(w.update.transcriptAt, NOW);
});

test("transcriptAt keeps the first arrival time", () => {
  const first = new Date("2026-10-09T11:05:00Z");
  const w = callWriteData({ ...base, transcription: "x" }, { id: "c1", recordingStatus: "NONE", transcriptAt: first }, "l", NOW);
  assert.equal(w.update.transcriptAt, first);
});

test("a STORED recording is never downgraded or re-downloaded", () => {
  // Old code set recordingStatus back to PENDING on every re-sighting and re-mirrored it.
  const withUrl = callWriteData({ ...base, recordingUrl: "https://x/rec.mp3" }, { id: "c1", recordingStatus: "STORED", transcriptAt: null }, "l", NOW);
  assert.ok(!("recordingStatus" in withUrl.update));
  assert.equal(withUrl.wantsMirror, false);

  const withoutUrl = callWriteData(base, { id: "c1", recordingStatus: "STORED", transcriptAt: null }, "l", NOW);
  assert.ok(!("recordingStatus" in withoutUrl.update), "old code set NONE here, orphaning the stored file");
});

test("a fresh URL revives a FAILED recording", () => {
  const w = callWriteData({ ...base, recordingUrl: "https://x/new.mp3" }, { id: "c1", recordingStatus: "FAILED", transcriptAt: null }, "l", NOW);
  assert.equal(w.update.recordingStatus, "PENDING");
  assert.equal(w.wantsMirror, true);
});
