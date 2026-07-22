import assert from "node:assert/strict";
import test from "node:test";

import { cardState, contextKind, definitionOfDone, nextAction, showPriority, workingSurface } from "../app/card-view-model.ts";

const item = (overrides = {}) => ({
  type: "project_action",
  title: "Confirm benchmark plan",
  summary: "The benchmark plan is agreed and recorded.",
  whyNow: "The team needs direction.",
  suggestedAction: "Confirm the next benchmark milestone.",
  preparationInstruction: "",
  priority: "normal",
  status: "to_review",
  decisionState: "accepted",
  owner: "Jake",
  events: [],
  assignments: [],
  agentRuns: [],
  ...overrides,
});

test("derives the collapsed Next line and only promotes high priorities", () => {
  assert.equal(nextAction(item()), "Confirm the next benchmark milestone.");
  assert.equal(showPriority("normal"), false);
  assert.equal(showPriority("high"), true);
  assert.equal(showPriority("urgent"), true);
});

test("turns technical states into meaningful card language", () => {
  const waiting = cardState(item({ status: "waiting_external", events: [{ type: "waiting_external", detail: "Waiting on Kyle.", createdAt: "2026-07-21T10:00:00Z" }] }));
  assert.equal(waiting.label, "Waiting on Kyle");
  assert.equal(cardState(item({ status: "back_for_review" })).label, "Ready to review");
  assert.equal(cardState(item({ status: "error" })).label, "Needs attention");
  assert.equal(cardState(item()).label, "Open");
});

test("shows a company PM only with a verified receipt owned by the exact persistent PM task", () => {
  const withSiq = cardState(item({ status: "working", assignments: [{ status: "started", ownerId: "019f5c8f-5994-7c73-a717-67a0ad7b0682", updatedAt: "2026-07-21T10:00:00Z" }] }));
  assert.equal(withSiq.label, "With SIQ PM");
  const fakePm = cardState(item({ status: "working", assignments: [{ status: "started", ownerId: "lookalike-task", updatedAt: "2026-07-21T10:00:00Z" }] }));
  assert.equal(fakePm.label, "Needs reconciliation");
  const technicalResultOnly = cardState(item({ status: "to_review", assignments: [{ status: "completed", ownerId: "lookalike-task", updatedAt: "2026-07-21T10:00:00Z" }], agentRuns: [{ status: "review", updatedAt: "2026-07-21T10:00:00Z" }] }));
  assert.equal(technicalResultOnly.label, "Open");
});

test("provides type-aware working areas, context labels, and definitions of done", () => {
  assert.equal(workingSurface(item({ type: "email_action", title: "Reply to Kyle" })).label, "Draft reply");
  assert.equal(workingSurface(item({ type: "meeting_follow_up", title: "Prepare kickoff" })).label, "Meeting agenda");
  assert.equal(contextKind(item({ type: "email_action", title: "Reply to Kyle" })), "Email context");
  assert.match(definitionOfDone(item({ type: "review_action", title: "Review pricing deck" })), /reviewed the evidence/i);
});
