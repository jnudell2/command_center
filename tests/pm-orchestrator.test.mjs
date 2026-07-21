import assert from "node:assert/strict";
import test from "node:test";
import { buildPmChatPrompt, buildPmSnapshot, inferPmCompany, isPmThreadActive, normalizePmText } from "../scripts/pm-orchestrator.mjs";

test("normalizes company aliases used in Jake's Codex task titles", () => {
  assert.equal(inferPmCompany("SIQ competitive perspective"), "stockiq");
  assert.equal(inferPmCompany("Avionté CA / CM tracker"), "avionte");
  assert.equal(inferPmCompany("Gov Works kickoff"), "govworx");
  assert.equal(normalizePmText("Stock IQ – SteerCo 1"), "stockiq steerco 1");
});

test("links embedded work-item IDs and proposes a likely StockIQ match without duplicating work", () => {
  const avionteId = "302edf83-350f-485c-b042-b164fd02c9db";
  const workItems = [
    { id: avionteId, company_slug: "avionte", title: "Build the Avionte CA / CM scorecard", summary: "Weekly rollout tracker", suggested_action: "Prepare the scorecard.", owner: "Jake + Codex", status: "to_review", decision_state: "accepted" },
    { id: "70742380-200c-4f56-8ee9-c1e73f371052", company_slug: "stockiq", title: "Build the SteerCo 1 concept story", summary: "Develop the story and concepts", suggested_action: "Use competitive information to shape the SteerCo story.", owner: "Jake + Codex", status: "to_review", decision_state: "accepted" },
  ];
  const threads = [
    { id: "019f5d4d-9e45-7910-930c-d31f57e917b7", name: "Avionté - Build the Avionte CA / CM scorecard", preview: `Work item ID: ${avionteId}`, status: { type: "idle" }, updatedAt: 1784054558, cwd: "C:\\AI" },
    { id: "019f5c8f-5994-7c73-a717-67a0ad7b0682", name: "SIQ", preview: "Competitive information perspective going into SteerCo 1 and how it shapes our story", status: { type: "active", activeFlags: [] }, updatedAt: 1784054237, cwd: "C:\\AI" },
  ];
  const snapshot = buildPmSnapshot({ threads, workItems });
  const avionte = snapshot.observations.find((item) => item.companySlug === "avionte");
  const stockiq = snapshot.observations.find((item) => item.companySlug === "stockiq");
  assert.equal(avionte.linkedWorkItemId, avionteId);
  assert.equal(avionte.matchType, "embedded_id");
  assert.equal(stockiq.linkedWorkItemTitle, "Build the SteerCo 1 concept story");
  assert.equal(stockiq.matchType, "likely");
  assert.ok(snapshot.recommendations.some((item) => item.action === "link" && item.threadId === stockiq.threadId));
  assert.equal(snapshot.summary.wouldDispatch, 0);
  assert.equal(snapshot.summary.underway, 1);
  assert.equal(isPmThreadActive("completed"), false);
});

test("only marks accepted Codex-owned unlinked work as dispatchable", () => {
  const snapshot = buildPmSnapshot({
    threads: [],
    workItems: [
      { id: "accepted", company_slug: "stockiq", title: "Run benchmark", owner: "Jake + Codex", status: "to_review", decision_state: "accepted", suggested_action: "Run it." },
      { id: "proposed", company_slug: "stockiq", title: "Draft future deck", owner: "Jake + Codex", status: "to_review", decision_state: "proposed", suggested_action: "Draft it." },
      { id: "external", company_slug: "stockiq", title: "Receive data", owner: "External", status: "waiting_external", decision_state: "accepted", suggested_action: "Wait for Kyle." },
    ],
  });
  assert.deepEqual(snapshot.recommendations.map((item) => item.action), ["dispatch", "needs_jake", "wait"]);
});

test("keeps the 20 most recent unmatched Codex tasks as PM awareness without treating them as active project work", () => {
  const threads = Array.from({ length: 22 }, (_, index) => ({
    id: `thread-${index}`,
    name: `Recent task ${index}`,
    preview: `Unlinked research topic ${index}`,
    latestSummary: index === 0 ? "A relevant deliverable is ready." : "",
    status: { type: index === 0 ? "completed" : "idle" },
    updatedAt: 1784055000 - index,
    cwd: "C:\\AI",
  }));
  const snapshot = buildPmSnapshot({ threads, workItems: [], recentAwarenessLimit: 20 });
  assert.equal(snapshot.observations.length, 20);
  assert.equal(snapshot.observations[0].matchType, "unmatched");
  assert.match(snapshot.observations[0].preview, /Latest Codex update: A relevant deliverable is ready/);
  assert.equal(snapshot.summary.underway, 0);
  assert.equal(snapshot.recommendations.length, 0);
});

test("marks accepted Jake-owned auto-preparation work as dispatchable", () => {
  const snapshot = buildPmSnapshot({
    threads: [],
    workItems: [
      { id: "auto-email", company_slug: "govworx", title: "Prepare the kickoff update", owner: "Jake", status: "to_review", decision_state: "committed", preparation_mode: "auto", suggested_action: "Draft the update for Jake to review." },
      { id: "manual-email", company_slug: "govworx", title: "Send the kickoff update", owner: "Jake", status: "to_review", decision_state: "committed", preparation_mode: "manual", suggested_action: "Jake sends it." },
    ],
  });
  assert.deepEqual(snapshot.recommendations.map((item) => item.action), ["dispatch", "needs_jake"]);
});

test("builds short pulse and fuller morning prompts for the persistent PM chat", () => {
  const payload = {
    summary: { underway: 1, autoStarted: 1, needsJake: 1, waiting: 1 },
    observations: [{ linkedWorkItemId: "work-1", companyName: "GovWorX", linkedWorkItemTitle: "Draft kickoff update", status: "active" }],
    recommendations: [
      { action: "dispatch", status: "executed", companyName: "GovWorX", workItemTitle: "Draft kickoff update" },
      { action: "review", status: "proposed", companyName: "StockIQ", workItemTitle: "Review analysis" },
      { action: "wait", status: "proposed", companyName: "StockIQ", workItemTitle: "Receive data" },
    ],
    strategy: {
      projects: [{ companyName: "StockIQ", title: "Pricing VCI", objective: "Define the future offer", health: "At risk: inputs are late", progress: { percent: 20 }, activePhase: "Fact base", nextMilestone: "SteerCo 1 on 2026-08-03", criticalPath: [{ companyName: "StockIQ", title: "Reconcile pricing evidence", dueAt: "2026-07-17", status: "to_review" }], blocked: [{ companyName: "StockIQ", title: "Receive data", dueAt: "2026-07-10", status: "waiting_external" }], upNext: [{ companyName: "StockIQ", title: "Review customer data", dueAt: "2026-07-24", status: "up_next" }] }],
      calendar: [{ companyName: "GovWorX", title: "Kickoff", startAt: "2026-07-16T21:30:00.000Z" }],
      mail: [{ companyName: "StockIQ", title: "Data follow-up", receivedAt: "2026-07-14T18:00:00.000Z" }],
    },
  };
  const pulse = buildPmChatPrompt({ kind: "pulse", payload, generatedAt: "2026-07-14T20:30:00.000Z" });
  const morning = buildPmChatPrompt({ kind: "morning", payload, generatedAt: "2026-07-15T15:00:00.000Z" });
  assert.match(pulse, /30-minute strategic pulse/);
  assert.match(pulse, /under 260 words/);
  assert.match(pulse, /CEO and PM Agent/);
  assert.match(pulse, /Critical path now/);
  assert.match(pulse, /GovWorX: Draft kickoff update/);
  assert.match(pulse, /new task launch accepted; completion not yet established/);
  assert.match(pulse, /A launch means only that a task was created or resumed/);
  assert.match(pulse, /Recent Codex work radar \(20 most recent tasks/);
  assert.match(morning, /morning briefing/);
  assert.match(morning, /Recommended sequence/);
});
