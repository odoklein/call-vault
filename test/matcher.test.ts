import { test } from "node:test";
import assert from "node:assert/strict";
import { matchActionsToCalls, type MatchableAction, type MatchableCall } from "../lib/linking/matcher";

const T = (hhmm: string) => new Date(`2026-10-09T${hhmm}:00Z`);
const SWITCHBOARD = "+33240000000";

const action = (id: string, loggedAt: string, over: Partial<MatchableAction> = {}): MatchableAction => ({
  id,
  sdrUserId: "adam",
  loggedAt: T(loggedAt),
  phones: [SWITCHBOARD],
  sdrHasLine: true,
  ...over,
});
const call = (id: string, startedAt: string, durationSec: number, over: Partial<MatchableCall> = {}): MatchableCall => ({
  id,
  remoteNumber: SWITCHBOARD,
  startedAt: T(startedAt),
  durationSec,
  lineUserId: "adam",
  ...over,
});

test("production case: two contacts at one agency, one switchboard — each action gets its own call", () => {
  // Orpi AGP: adam logged REFUS for Jacques at 14:38 and for Nadine at 14:44, both via the
  // company number. The CRM attached the same call (same summary) to both.
  const matches = matchActionsToCalls(
    [action("jacques", "14:38"), action("nadine", "14:44")],
    [call("c1", "14:35", 150), call("c2", "14:41", 160)],
  );
  assert.deepEqual(
    matches.map((m) => [m.actionId, m.callId, m.confidence]).sort(),
    [
      ["jacques", "c1", "HIGH"],
      ["nadine", "c2", "HIGH"],
    ],
  );
});

test("one call, two actions: the call goes to one action only, never duplicated", () => {
  const matches = matchActionsToCalls([action("a1", "14:38"), action("a2", "14:44")], [call("c1", "14:35", 150)]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].actionId, "a1"); // ended 0.5m before a1, 6.5m before a2
});

test("production case: a meeting isn't matched to an earlier voicemail when the real conversation exists", () => {
  // Cantine Max: the action got a voicemail's summary. Same number, same day: the 09:10 voicemail
  // and the 16:25 conversation the meeting was booked on (logged 16:34).
  const matches = matchActionsToCalls(
    [action("rdv", "16:34", { sdrUserId: "maxime" })],
    [call("voicemail", "09:10", 25, { lineUserId: "maxime" }), call("conversation", "16:25", 520, { lineUserId: "maxime" })],
  );
  assert.deepEqual(matches.map((m) => m.callId), ["conversation"]);
});

test("another SDR's call to the same number is never attached", () => {
  const matches = matchActionsToCalls([action("a1", "10:05", { sdrUserId: "maxime" })], [call("c1", "10:00", 120, { lineUserId: "adam" })]);
  assert.deepEqual(matches, []);
});

test("a call from an unmapped line can't belong to an SDR whose lines are mapped", () => {
  assert.deepEqual(matchActionsToCalls([action("a1", "10:05")], [call("c1", "10:00", 120, { lineUserId: null })]), []);
});

test("SDR without a mapped line: matched on number + timing, but never HIGH", () => {
  const [m] = matchActionsToCalls([action("a1", "10:05", { sdrHasLine: false })], [call("c1", "10:00", 120, { lineUserId: null })]);
  assert.equal(m.callId, "c1");
  assert.equal(m.confidence, "MEDIUM");
  assert.match(m.reason, /not mapped/);
});

test("a call that started after the outcome was logged is a different attempt", () => {
  assert.deepEqual(matchActionsToCalls([action("a1", "10:00")], [call("callback", "10:20", 60)]), []);
});

test("calls ending more than the max delay before the log are ignored", () => {
  assert.deepEqual(matchActionsToCalls([action("a1", "18:00")], [call("morning", "09:00", 60)]), []);
});

test("same line but logged long after: MEDIUM, with a readable reason", () => {
  const [m] = matchActionsToCalls([action("a1", "12:00")], [call("c1", "10:30", 60)]);
  assert.equal(m.confidence, "MEDIUM");
  assert.equal(m.reason, "same SDR line, ended 1h29 before log, 60s");
});

test("a contact's other numbers are candidates too", () => {
  const [m] = matchActionsToCalls(
    [action("a1", "10:05", { phones: ["+33611111111", SWITCHBOARD] })],
    [call("mobile", "10:01", 200, { remoteNumber: "+33611111111" })],
  );
  assert.equal(m.callId, "mobile");
});
