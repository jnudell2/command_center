import test from "node:test";
import assert from "node:assert/strict";
import { buildExecutiveCardRead } from "../app/executive-card-read.ts";

const base = (overrides = {}) => ({
  id: "fixture-card",
  type: "task",
  companyName: "Personal",
  title: "Confirm next step",
  summary: "Confirm the next step and record the outcome.",
  whyNow: "The commitment is due soon.",
  suggestedAction: "Confirm the next step.",
  preparationInstruction: "",
  priority: "normal",
  status: "to_review",
  decisionState: "accepted",
  owner: "Jake",
  dueAt: "2026-07-24T12:00:00",
  followUpAt: null,
  waitingOn: "",
  events: [],
  sources: [],
  notes: [],
  assignments: [],
  agentRuns: [],
  codexTasks: [],
  relationships: [],
  intelligenceReview: null,
  projectContext: null,
  ...overrides,
});

test("turns the live GovWorX contradiction into an executive read", () => {
  const card = base({
    id: "24485506-6ffd-4b0b-944f-44e9669d32d9",
    type: "project_action",
    companyName: "GovWorX",
    title: "Obtain the GovWorX product demo",
    summary: "Receive a live product demo or an existing recording covering the current and upcoming product set.",
    whyNow: "The product map and future-state architecture depend on understanding the actual workflows and dependencies.",
    suggestedAction: "Ask Kevin to provide or schedule the product demo before the fact-base analysis begins.",
    status: "waiting_external",
    owner: "External",
    dueAt: "2026-07-20T12:00:00",
    events: [{ type: "waiting_external", detail: "Waiting on GovWorX.", createdAt: "2026-07-17T00:00:00Z" }],
    agentRuns: [{ status: "review", result: "Target due date: Friday, July 24, 2026. Proposed stored values: `due_date: 2026-07-24`; `due_at: 2026-07-25T00:00:00.000Z`", error: "", updatedAt: "2026-07-18T00:00:00Z" }],
    sources: [{ id: "kickoff", provider: "project_plan", label: "Kickoff deck commitment", sourceUrl: "https://example.com/kickoff", freshness: "cached" }],
    relationships: [{ id: "hugo", relationType: "informs", state: "confirmed", otherWorkItemId: "hugo-scope", otherTitle: "Hugo secret-shopping scope" }],
    projectContext: { workstream: "Build the fact base and diagnose the current state", phaseTitle: "Fact base", projectTitle: "GovWorX VCI" },
  });
  const read = buildExecutiveCardRead(card, new Date("2026-07-21T12:00:00"));
  assert.equal(read.stateLabel, "Waiting on Kevin");
  assert.match(read.currentTruth, /No demo or recording delivery is proven/i);
  assert.match(read.nextMove, /Confirm whether Kevin has already been asked/i);
  assert.match(read.nextMove, /Jul 24/);
  assert.equal(read.actor, "Jake");
  assert.equal(read.dependency, "Kevin / GovWorX");
  assert.equal(read.doneWhen, "A reviewable demo or recording is linked.");
  assert.deepEqual(read.contradictions, [
    "Card says Waiting on GovWorX, but the recorded next move still requires Jake to contact Kevin.",
    "Card says Jul 20; newer evidence proposes Jul 24.",
  ]);
  assert.equal(read.evidence.length, 1);
  assert.equal(read.relatedWork.length, 2);
});

test("turns the StockIQ completed benchmark into the actual review decision", () => {
  const read = buildExecutiveCardRead(base({
    id: "571e2dff-e118-4f28-a925-f12eabd6b1ec",
    companyName: "StockIQ",
    title: "Benchmark StockIQ execution and entitlements",
    summary: "Benchmark scenario speed, data cadence, integration and write-back, Edison jobs, and StockIQ 2.0 entitlements.",
    whyNow: "Product monetization concepts need a clear fact base before SteerCo 1.",
    suggestedAction: "Build a source-backed benchmark of the capabilities and entitlement boundaries that matter for packaging.",
    status: "back_for_review",
    owner: "Jake + Codex",
    assignments: [{ status: "completed", ownerId: "native", error: "", updatedAt: "2026-07-14T20:59:22Z", result: "Completed and saved locally: [StockIQ Capability and Entitlement Benchmark](C:/private/path/benchmark.md).\n\nMost important remaining decision: whether to advance interim Edison/API/MCP monetization now while deferring the full StockIQ 2.0 tier architecture until entitlement controls and product readiness are confirmed." }],
  }));
  assert.equal(read.currentTruth, "StockIQ Capability and Entitlement Benchmark is ready. The remaining business decision is whether to advance interim Edison/API/MCP monetization now while deferring the full StockIQ 2.0 tier architecture until entitlement controls and product readiness are confirmed.");
  assert.match(read.nextMove, /^Decide whether to advance interim Edison\/API\/MCP monetization/);
  assert.doesNotMatch(read.nextMove, /^Build/i);
  assert.equal(read.artifactLabel, "StockIQ Capability and Entitlement Benchmark");
  assert.equal(read.actor, "Jake");
  assert.match(read.doneWhen, /^Jake records the decision whether to advance interim Edison\/API\/MCP monetization/);
  assert.equal(read.contradictions.length, 1);
  assert.doesNotMatch(`${read.currentTruth} ${read.nextMove}`, /C:\/private|benchmark\.md/);
});

test("a cited CEO PM read is authoritative but remains read-only", () => {
  const read = buildExecutiveCardRead(base({ intelligenceReview: {
    status: "current", whatItMeans: "The customer decision is now the blocker.", whyItMattersNow: "The launch date depends on it.", recommendedNextMove: "Ask for the decision by Friday.", ownerDependency: "Customer sponsor", definitionOfDone: "The decision is recorded.", reviewedBy: "Command Center CEO / PM", updatedAt: "2026-07-21T10:00:00Z", lastReconciledAt: null, evidence: [],
  } }), new Date("2026-07-21T12:00:00Z"));
  assert.equal(read.currentTruth, "The customer decision is now the blocker.");
  assert.equal(read.nextMove, "Ask for the decision by Friday.");
  assert.match(read.authorityMeta, /CEO \/ PM read · read-only/);
});

test("deduplicates evidence rows and omits raw note bodies", () => {
  const read = buildExecutiveCardRead(base({
    sources: [
      { id: "one", provider: "box", label: "Kickoff deck", sourceUrl: "https://example.com/deck", freshness: "fresh" },
      { id: "two", provider: "box", label: "Duplicate deck", sourceUrl: "https://example.com/deck", freshness: "cached" },
    ],
    notes: [{ id: "meeting", title: "Kickoff meeting decisions", type: "meeting", body: "RAW MARKDOWN SHOULD NOT APPEAR" }],
  }));
  assert.equal(read.evidence.length, 2);
  assert.equal(read.evidence[1].meta, "Meeting note");
  assert.doesNotMatch(JSON.stringify(read.evidence), /RAW MARKDOWN/);
});

test("ten-card scan always exposes truth, why, next move, actor, timing, and no stale Ready action", () => {
  const fixtures = [
    base(),
    base({ id: "waiting", status: "waiting_external", owner: "Kyle", waitingOn: "Kyle", suggestedAction: "Wait for Kyle to send the recording." }),
    base({ id: "jake", status: "waiting_on_user", suggestedAction: "Choose the preferred option." }),
    base({ id: "attention", status: "needs_attention", suggestedAction: "Resolve the missing source." }),
    base({ id: "decision", decisionState: "proposed", suggestedAction: "Decide whether to accept this commitment." }),
    base({ id: "email", type: "email_reply", title: "Reply to the customer", suggestedAction: "Review and send the reply." }),
    base({ id: "meeting", type: "meeting_prep", title: "Prepare the kickoff agenda", suggestedAction: "Confirm the decisions needed in the meeting." }),
    base({ id: "review", type: "review", title: "Review the pricing recommendation", suggestedAction: "Record the decision." }),
    base({ id: "later", dueAt: null, suggestedAction: "Define the next milestone." }),
    base({ id: "ready", status: "back_for_review", suggestedAction: "Build the analysis.", assignments: [{ status: "completed", ownerId: "native", result: "Completed locally. Most important remaining decision: whether to approve the proposed rollout.", error: "", updatedAt: "2026-07-21T00:00:00Z" }] }),
  ];
  const reads = fixtures.map((fixture) => buildExecutiveCardRead(fixture));
  assert.equal(reads.length, 10);
  for (const read of reads) {
    assert.ok(read.currentTruth);
    assert.ok(read.whyNow);
    assert.ok(read.nextMove);
    assert.ok(read.actor);
    assert.ok(read.timing);
    assert.ok(read.doneWhen);
  }
  assert.doesNotMatch(reads[9].nextMove, /^Build/i);
});
