import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedTranscriptPath,
  isEligibleCompletedMeeting,
  normalizeMeetingAction,
  scoreTranscriptCandidate,
  transcriptTimestamp,
} from "../scripts/meeting-workflow.mjs";

test("creates post-meeting work only for recent real meetings", () => {
  const now = Date.parse("2026-07-13T22:00:00.000Z");
  const event = {
    subject: "Jake / Kavya 1:1",
    start_at: "2026-07-13T20:00:00.000Z",
    end_at: "2026-07-13T20:30:00.000Z",
    attendees_json: JSON.stringify([{ email: "kavya@example.com" }]),
  };
  assert.equal(isEligibleCompletedMeeting(event, { nowMs: now, enabledAtMs: Date.parse("2026-07-13T19:00:00.000Z") }), true);
  assert.equal(isEligibleCompletedMeeting({ ...event, subject: "Focus time" }, { nowMs: now }), false);
  assert.equal(isEligibleCompletedMeeting({ ...event, attendees_json: "[]" }, { nowMs: now }), false);
});

test("matches Zoom filenames to the calendar start before loose freshness", () => {
  const event = { subject: "Jake / Kavya 1:1", start_at: "2026-07-13T20:00:00.000Z", end_at: "2026-07-13T20:30:00.000Z" };
  assert.equal(transcriptTimestamp("GMT20260713-200031_Recording.transcript.vtt"), Date.parse("2026-07-13T20:00:31.000Z"));
  const matched = scoreTranscriptCandidate({ name: "GMT20260713-200031_Recording.transcript.vtt", mtimeMs: Date.parse("2026-07-13T20:40:00.000Z") }, event, Date.parse("2026-07-13T21:00:00.000Z"));
  const unrelated = scoreTranscriptCandidate({ name: "GMT20260712-180000_Recording.transcript.vtt", mtimeMs: Date.parse("2026-07-13T20:40:00.000Z") }, event, Date.parse("2026-07-13T21:00:00.000Z"));
  assert.ok(matched.score > unrelated.score);
  assert.ok(matched.reasons.includes("filename time matches the meeting"));
  assert.ok(unrelated.score < 3, "a timestamped transcript outside the 20-minute window must not be offered as a candidate");
});

test("normalizes reviewable actions and enforces transcript roots", () => {
  const action = normalizeMeetingAction({ title: " Send follow-up ", companySlug: "stockiq", owner: "jake", priority: "high", dueAt: "2026-07-14T17:00:00-07:00" });
  assert.equal(action.title, "Send follow-up");
  assert.equal(action.companySlug, "stockiq");
  assert.equal(action.dueAt, "2026-07-15T00:00:00.000Z");
  assert.equal(isAllowedTranscriptPath("C:\\Users\\Jake\\Downloads\\meeting.vtt", ["C:\\Users\\Jake\\Downloads"]), true);
  assert.equal(isAllowedTranscriptPath("C:\\Windows\\meeting.vtt", ["C:\\Users\\Jake\\Downloads"]), false);
});
