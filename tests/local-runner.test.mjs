import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response; } catch { /* keep waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Runner did not become ready at ${url}`);
}

test("keeps native Codex task execution outside the Command Center runner", async () => {
  const source = await readFile(fileURLToPath(new URL("../scripts/local-control-server.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /function readCodexThread/);
  assert.doesNotMatch(source, /function launchPersistentCodexTask/);
  assert.doesNotMatch(source, /app-server|thread\/start|thread\/resume|turn\/start|openCodexThreadInApp/);
  assert.match(source, /This launch endpoint is retired/);
  assert.match(source, /reconcileAssignmentAttention/);
  assert.match(source, /existing native Codex owner remains assigned/);
});

test("preserves one assignment owner across restart and keeps technical attention off business status", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "serent-assignment-restart-"));
  const port = 45200 + Math.floor(Math.random() * 500);
  const startRunner = () => spawn(process.execPath, [fileURLToPath(new URL("../scripts/local-control-server.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, SERENT_TEND_DATA_DIR: dataDir, SERENT_TEND_PORT: String(port), SERENT_TEND_DISABLE_LOCAL_WORKFLOWS: "1" },
    windowsHide: true,
  });
  let runner = startRunner();
  t.after(async () => {
    if (runner.exitCode === null) { const exited = once(runner, "exit"); runner.kill(); await exited; }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { await rm(dataDir, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 7) throw error; await new Promise((resolve) => setTimeout(resolve, 80)); }
    }
  });
  await waitFor(`http://127.0.0.1:${port}/api/health`);
  const item = await (await fetch(`http://127.0.0.1:${port}/api/work-items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Restart lifecycle QA", sourceKey: "restart-lifecycle-qa", companySlug: "firm" }) })).json();
  const prepared = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${item.id}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "return_here", instruction: "Remain owner-bound across restart." }) })).json();
  const token = prepared.handoffPacket.prompt.match(/^Authorization: Bearer ([A-Za-z0-9_-]+)$/m)?.[1];
  await fetch(`http://127.0.0.1:${port}/api/assignments/${prepared.assignment.id}/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ eventId: "restart-accepted", type: "accepted", ownerId: "restart-owner" }) });

  const db = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  db.prepare("UPDATE assignments SET heartbeat_at=?,updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", prepared.assignment.id);
  db.close();
  const exited = once(runner, "exit");
  runner.kill();
  await exited;
  runner = startRunner();
  await waitFor(`http://127.0.0.1:${port}/api/health`);
  const restored = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${item.id}`)).json();
  assert.equal(restored.status, "to_review");
  assert.equal(restored.assignments[0].id, prepared.assignment.id);
  assert.equal(restored.assignments[0].ownerId, "restart-owner");
  assert.equal(restored.assignments[0].status, "needs_attention");
  assert.equal(restored.assignments.filter((assignment) => ["prepared", "accepted", "working", "needs_input", "needs_attention"].includes(assignment.status)).length, 1);
});

test("migrates a fresh local store and exposes adaptive Mail contracts", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "serent-tend-test-"));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const runner = spawn(process.execPath, [fileURLToPath(new URL("../scripts/local-control-server.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, SERENT_TEND_DATA_DIR: dataDir, SERENT_TEND_PORT: String(port), SERENT_TEND_DISABLE_LOCAL_WORKFLOWS: "1" },
    windowsHide: true,
  });
  t.after(async () => {
    if (runner.exitCode === null) { const exited = once(runner, "exit"); runner.kill(); await exited; }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { await rm(dataDir, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 7) throw error; await new Promise((resolve) => setTimeout(resolve, 80)); }
    }
  });
  await waitFor(`http://127.0.0.1:${port}/api/health`);

  const rejectedOrigin = await fetch(`http://127.0.0.1:${port}/api/calendar/refresh`, { method: "POST", headers: { origin: "https://example.com" } });
  assert.equal(rejectedOrigin.status, 403);

  const bootstrap = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
  assert.equal(bootstrap.runner.status, "ready");
  const pmAgent = await (await fetch(`http://127.0.0.1:${port}/api/pm-agent`)).json();
  assert.equal(pmAgent.config.mode, "observer");
  assert.equal(pmAgent.config.pulseMinutes, 30);
  assert.equal(pmAgent.config.chatThreadId, "");
  assert.equal(pmAgent.config.chatStatus, "not_created");
  assert.deepEqual(pmAgent.observations, []);
  assert.ok(pmAgent.strategy.projects.length >= 2);
  assert.deepEqual(pmAgent.strategy.calendar, []);
  assert.ok(bootstrap.companies.some((company) => company.slug === "edulog" && company.displayName === "Edulog"));
  assert.deepEqual(bootstrap.mailCounts, { all: 0, needs_reply: 0, unread: 0, drafts: 0, snoozed: 0 });
  const projects = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
  const stockiqProject = projects.find((project) => project.id === "stockiq-2026-vci");
  assert.equal(stockiqProject.source.id, "2316599730929");
  assert.equal(stockiqProject.activePhase.id, "stockiq-phase-1");
  assert.equal(stockiqProject.nextMilestone.id, "stockiq-steerco-1");
  assert.ok(stockiqProject.stayAhead.some((item) => item.id === "stockiq-inputs" && item.workItemId));
  const stockiqInputAction = stockiqProject.stayAhead.find((item) => item.id === "stockiq-inputs");
  const inputCard = bootstrap.items.find((candidate) => candidate.id === stockiqInputAction.workItemId);
  assert.equal(inputCard.projectContext.planItemId, "stockiq-inputs");
  assert.equal(inputCard.decisionState, "accepted");
  const updatedProject = await (await fetch(`http://127.0.0.1:${port}/api/project-plan-items/stockiq-inputs`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "complete" }) })).json();
  assert.equal(updatedProject.planItems.find((item) => item.id === "stockiq-inputs").status, "complete");
  const completedInputCard = await (await fetch(`http://127.0.0.1:${port}/api/work-items?status=done`)).json();
  assert.ok(completedInputCard.some((candidate) => candidate.id === stockiqInputAction.workItemId));
  const govworxProject = projects.find((project) => project.id === "govworx-2026-vci");
  assert.equal(govworxProject.source.id, "2345257521399");
  assert.equal(govworxProject.source.label, "GovWorx_2026_Pricing_Packaging_VCI_Kickoff_v3.pptx");
  assert.equal(govworxProject.activePhase.id, "govworx-phase-a");
  assert.equal(govworxProject.nextMilestone.id, "govworx-kickoff");
  assert.ok(govworxProject.stayAhead.some((item) => item.id === "govworx-kickoff-deck" && item.workItemId));
  for (const planItemId of ["govworx-interview-roster", "govworx-product-demo"]) {
    const planItem = govworxProject.planItems.find((item) => item.id === planItemId);
    assert.ok(planItem.workItemId, `${planItemId} should retain one canonical card`);
    assert.equal(planItem.followUpWorkItemId, planItem.workItemId, `${planItemId} should reuse its canonical card for follow-up`);
    assert.equal(bootstrap.items.filter((item) => item.projectContext?.planItemId === planItemId).length, 1, `${planItemId} should not create a second follow-up card`);
  }
  assert.ok(!bootstrap.items.some((item) => ["Follow up: Confirm the working team and interview roster", "Follow up: Obtain the GovWorx product demo"].includes(item.title)));
  const ingestedProject = await (await fetch(`http://127.0.0.1:${port}/api/projects/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    approved: true,
    sourceId: "box-future-project",
    sourceLabel: "Future_Project_Workplan.pptx",
    sourceUrl: "https://app.box.com/file/box-future-project",
    companySlug: "stockiq",
    projectKey: "future-vci",
    title: "Future VCI",
    objective: "Prove that future approved plans compile into executable guidance.",
    startDate: "2026-07-14",
    targetDate: "2026-08-31",
    phases: [{ sourceKey: "fact-base", title: "Fact base", status: "active", startDate: "2026-07-14", endDate: "2026-07-31" }],
    milestones: [{ sourceKey: "decision", title: "Decision", scheduledDate: "2026-08-01", decision: "Choose the direction." }],
    planItems: [
      { sourceKey: "inputs", phaseKey: "fact-base", workstream: "Fact base", title: "Obtain inputs", owner: "Company team", startDate: "2026-07-14", dueDate: "2026-07-14", status: "blocked", suggestedAction: "Follow up for the inputs." },
      { sourceKey: "analysis", phaseKey: "fact-base", workstream: "Fact base", title: "Run analysis", owner: "Jake", startDate: "2026-07-14", dueDate: "2026-07-21", status: "planned", suggestedAction: "Analyze the received inputs.", dependsOn: ["inputs"] },
    ],
  }) })).json();
  assert.equal(ingestedProject.source.id,"box-future-project");
  assert.equal(ingestedProject.guidance.waiting[0].title,"Obtain inputs");
  assert.equal(ingestedProject.guidance.waiting[0].followUpWorkItemId,ingestedProject.guidance.waiting[0].workItemId);
  assert.equal(ingestedProject.guidance.upNext[0].title,"Run analysis");
  assert.match(ingestedProject.guidance.upNext[0].executionReason,/Unlocks when Obtain inputs is complete/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const dailyBefore = await stat(bootstrap.dailyNote.filePath);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
  const dailyAfter = await stat(bootstrap.dailyNote.filePath);
  assert.equal(dailyAfter.mtimeMs, dailyBefore.mtimeMs, "reading bootstrap must not rewrite the daily note");

  const mail = await (await fetch(`http://127.0.0.1:${port}/api/mail?view=needs_reply`)).json();
  assert.deepEqual(mail.items, []);
  assert.equal(mail.receipt.source, "mail");

  const item = bootstrap.items.find((candidate) => candidate.id === "stockiq-transcript");
  assert.equal(item.decisionState, "proposed");
  assert.equal(bootstrap.items.find((candidate) => candidate.id === "avionte-cm").decisionState, "committed");

  const capturedResponse = await fetch(`http://127.0.0.1:${port}/api/work-items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Prepare tomorrow's kickoff", companySlug: "govworx", type: "artifact", priority: "high", dueAt: "2026-07-13T23:59:00-07:00", sourceKey: "manual-test-kickoff" }) });
  assert.equal(capturedResponse.status, 201);
  const captured = await capturedResponse.json();
  const completionFixture = await (await fetch(`http://127.0.0.1:${port}/api/work-items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Disposable direct-completion fixture", sourceKey: "direct-completion-fixture", companySlug: "firm" }) })).json();
  const waitingFixture = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${completionFixture.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "waiting_external", eventDetail: "Waiting on disposable fixture input." }) })).json();
  assert.equal(waitingFixture.status, "waiting_external");
  const completionCountsBefore = (await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json()).counts;
  const directCompletion = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${completionFixture.id}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "Mark this done" }) })).json();
  assert.equal(directCompletion.updated.id, completionFixture.id);
  assert.equal(directCompletion.updated.status, "done");
  assert.ok(directCompletion.undoToken);
  const completionCountsAfter = (await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json()).counts;
  assert.equal(completionCountsAfter.done || 0, (completionCountsBefore.done || 0) + 1);
  assert.equal(completionCountsAfter.waiting_external || 0, (completionCountsBefore.waiting_external || 0) - 1);
  const completionUndo = await (await fetch(`http://127.0.0.1:${port}/api/card-commands/${directCompletion.undoToken}/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(completionUndo.updated.id, completionFixture.id);
  assert.equal(completionUndo.updated.status, "waiting_external");
  const completionCountsUndone = (await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json()).counts;
  assert.equal(completionCountsUndone.done || 0, completionCountsBefore.done || 0);
  assert.equal(completionCountsUndone.waiting_external || 0, completionCountsBefore.waiting_external || 0);
  const dueSet = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dueAt: "2026-07-18T06:59:59.999Z", eventDetail: "Jake set the due date to 2026-07-17." }) })).json();
  assert.equal(dueSet.dueAt, "2026-07-18T06:59:59.999Z");
  assert.equal(dueSet.events[0].detail, "Jake set the due date to 2026-07-17.");
  const dueChanged = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dueAt: "2026-07-19T06:59:59.999Z", eventDetail: "Jake set the due date to 2026-07-18." }) })).json();
  assert.equal(dueChanged.dueAt, "2026-07-19T06:59:59.999Z");
  const dueCleared = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dueAt: null, eventDetail: "Jake cleared the due date." }) })).json();
  assert.equal(dueCleared.dueAt, null);
  assert.equal(dueCleared.events[0].detail, "Jake cleared the due date.");
  const cardCommand = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "update", instruction: "Change this to Revised kickoff, set priority to urgent, due 2030-08-22" }) })).json();
  assert.equal(cardCommand.outcome, "card_updated");
  assert.equal(cardCommand.handled, true);
  assert.equal(cardCommand.updated.title, "Revised kickoff");
  assert.equal(cardCommand.updated.priority, "urgent");
  assert.equal(new Date(cardCommand.updated.dueAt).getFullYear(), 2030);
  assert.equal(new Date(cardCommand.updated.dueAt).getMonth(), 7);
  assert.equal(new Date(cardCommand.updated.dueAt).getDate(), 22);
  assert.ok(cardCommand.undoToken);
  const cardCommandUndo = await (await fetch(`http://127.0.0.1:${port}/api/card-commands/${cardCommand.undoToken}/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(cardCommandUndo.updated.title, "Prepare tomorrow's kickoff");
  assert.equal(cardCommandUndo.updated.priority, "high");
  assert.equal(cardCommandUndo.updated.dueAt, null);
  const mixedCommand = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "update", instruction: "Move this to 2030-08-23 and draft the kickoff email" }) })).json();
  assert.equal(mixedCommand.handled, true);
  assert.equal(mixedCommand.remainingIntent, "draft the kickoff email");
  await fetch(`http://127.0.0.1:${port}/api/card-commands/${mixedCommand.undoToken}/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const unclearCommand = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "update", instruction: "Due sometime-ish" }) })).json();
  assert.match(unclearCommand.clarification, /could not understand the due date/i);
  assert.equal(unclearCommand.updated.dueAt, null);
  const preparedResponse = await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "return_here", instruction: "Prepare a local kickoff brief.", clientRequestId: "prepare-click-1" }) });
  assert.equal(preparedResponse.status, 201);
  const preparedTask = await preparedResponse.json();
  assert.equal(preparedTask.assignment.status, "prepared");
  assert.equal(preparedTask.assignment.destination, "card");
  assert.match(preparedTask.handoffPacket.prompt, /No Codex task is running yet|does not launch/);
  const liveCaptured = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`)).json();
  assert.equal(liveCaptured.status, "to_review");
  const duplicatePrepared = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "return_here", instruction: "Prepare a local kickoff brief.", clientRequestId: "prepare-click-1" }) })).json();
  assert.equal(duplicatePrepared.assignment.id, preparedTask.assignment.id);
  assert.equal(duplicatePrepared.reused, true);
  const token = preparedTask.handoffPacket.prompt.match(/^Authorization: Bearer ([A-Za-z0-9_-]+)$/m)?.[1];
  assert.ok(token);
  const callbackHeaders = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const unverifiedStart = await fetch(`http://127.0.0.1:${port}/api/assignments/${preparedTask.assignment.id}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "event-started-unowned", type: "started", ownerId: "native-owner-1" }) });
  assert.equal(unverifiedStart.status, 403);
  const acceptedReceipt = await (await fetch(`http://127.0.0.1:${port}/api/assignments/${preparedTask.assignment.id}/events`, { method: "POST", headers: callbackHeaders, body: JSON.stringify({ eventId: "event-accepted-1", type: "accepted", ownerId: "native-owner-1" }) })).json();
  assert.equal(acceptedReceipt.assignment.status, "accepted");
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`)).json()).status, "to_review");
  const conflictingOwner = await fetch(`http://127.0.0.1:${port}/api/assignments/${preparedTask.assignment.id}/events`, { method: "POST", headers: callbackHeaders, body: JSON.stringify({ eventId: "event-conflict-1", type: "started", ownerId: "native-owner-2" }) });
  assert.equal(conflictingOwner.status, 409);
  const startedReceipt = await (await fetch(`http://127.0.0.1:${port}/api/assignments/${preparedTask.assignment.id}/events`, { method: "POST", headers: callbackHeaders, body: JSON.stringify({ eventId: "event-started-1", type: "started", ownerId: "native-owner-1" }) })).json();
  assert.equal(startedReceipt.assignment.status, "working");
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`)).json()).status, "to_review");
  const needsInput = await (await fetch(`http://127.0.0.1:${port}/api/assignments/${preparedTask.assignment.id}/events`, { method: "POST", headers: callbackHeaders, body: JSON.stringify({ eventId: "event-needs-input-1", type: "needs_input", ownerId: "native-owner-1", result: "Choose the audience." }) })).json();
  assert.equal(needsInput.assignment.status, "needs_input");
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`)).json()).status, "to_review");
  const conflictingPreparation = await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "separate_task", instruction: "Start different work." }) });
  assert.equal(conflictingPreparation.status, 409);
  const completedBody = JSON.stringify({ eventId: "event-completed-1", type: "completed", ownerId: "native-owner-1", result: "Kickoff brief ready for review." });
  const completed = await (await fetch(`http://127.0.0.1:${port}/api/assignments/${preparedTask.assignment.id}/events`, { method: "POST", headers: callbackHeaders, body: completedBody })).json();
  assert.equal(completed.assignment.status, "completed");
  const replay = await (await fetch(`http://127.0.0.1:${port}/api/assignments/${preparedTask.assignment.id}/events`, { method: "POST", headers: callbackHeaders, body: completedBody })).json();
  assert.equal(replay.replayed, true);
  const returnedCard = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`)).json();
  assert.equal(returnedCard.status, "to_review");
  assert.equal(returnedCard.assignments[0].result, "Kickoff brief ready for review.");
  const legacyCallback = await fetch(`http://127.0.0.1:${port}/api/codex-tasks/legacy/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(legacyCallback.status, 410);

  const createScenarioItem = async (sourceKey, title) => (await (await fetch(`http://127.0.0.1:${port}/api/work-items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, sourceKey, companySlug: "firm" }) })).json());
  const prepareScenario = async (itemId, instruction, mode = "return_here") => {
    const prepared = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${itemId}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, instruction }) })).json();
    const capability = prepared.handoffPacket.prompt.match(/^Authorization: Bearer ([A-Za-z0-9_-]+)$/m)?.[1];
    return { ...prepared, callbackHeaders: { "content-type": "application/json", authorization: `Bearer ${capability}` } };
  };
  const failedItem = await createScenarioItem("assignment-failure-scenario", "Assignment failure scenario");
  const failedPrepared = await prepareScenario(failedItem.id, "Attempt the failure scenario.");
  await fetch(`http://127.0.0.1:${port}/api/assignments/${failedPrepared.assignment.id}/events`, { method: "POST", headers: failedPrepared.callbackHeaders, body: JSON.stringify({ eventId: "failure-accepted", type: "accepted", ownerId: "failure-owner" }) });
  await fetch(`http://127.0.0.1:${port}/api/assignments/${failedPrepared.assignment.id}/events`, { method: "POST", headers: failedPrepared.callbackHeaders, body: JSON.stringify({ eventId: "failure-started", type: "started", ownerId: "failure-owner" }) });
  const failedReceipt = await (await fetch(`http://127.0.0.1:${port}/api/assignments/${failedPrepared.assignment.id}/events`, { method: "POST", headers: failedPrepared.callbackHeaders, body: JSON.stringify({ eventId: "failure-terminal", type: "failed", ownerId: "failure-owner", error: "Deterministic QA failure." }) })).json();
  assert.equal(failedReceipt.assignment.status, "failed");
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/work-items/${failedItem.id}`)).json()).status, "to_review");

  const cancelledItem = await createScenarioItem("assignment-cancel-scenario", "Assignment cancellation scenario");
  const cancelledPrepared = await prepareScenario(cancelledItem.id, "Prepare but do not start.", "separate_task");
  const cancelled = await (await fetch(`http://127.0.0.1:${port}/api/assignments/${cancelledPrepared.assignment.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(cancelled.assignment.status, "cancelled");
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/work-items/${cancelledItem.id}`)).json()).status, "to_review");

  const releaseItem = await createScenarioItem("assignment-release-scenario", "Assignment interruption scenario");
  const releasePrepared = await prepareScenario(releaseItem.id, "Exercise owner release.");
  await fetch(`http://127.0.0.1:${port}/api/assignments/${releasePrepared.assignment.id}/events`, { method: "POST", headers: releasePrepared.callbackHeaders, body: JSON.stringify({ eventId: "release-accepted", type: "accepted", ownerId: "release-owner" }) });
  const released = await (await fetch(`http://127.0.0.1:${port}/api/assignments/${releasePrepared.assignment.id}/events`, { method: "POST", headers: releasePrepared.callbackHeaders, body: JSON.stringify({ eventId: "release-terminal", type: "ownership_released", ownerId: "release-owner", result: "Interrupted safely." }) })).json();
  assert.equal(released.assignment.status, "ownership_released");
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/work-items/${releaseItem.id}`)).json()).status, "to_review");

  const reconciledItem = await createScenarioItem("assignment-external-reconcile", "External reconciliation scenario");
  const reconciledPrepared = await prepareScenario(reconciledItem.id, "Return after external completion.");
  await fetch(`http://127.0.0.1:${port}/api/assignments/${reconciledPrepared.assignment.id}/events`, { method: "POST", headers: reconciledPrepared.callbackHeaders, body: JSON.stringify({ eventId: "reconcile-accepted", type: "accepted", ownerId: "reconcile-owner" }) });
  await fetch(`http://127.0.0.1:${port}/api/assignments/${reconciledPrepared.assignment.id}/events`, { method: "POST", headers: reconciledPrepared.callbackHeaders, body: JSON.stringify({ eventId: "reconcile-started", type: "started", ownerId: "reconcile-owner" }) });
  await fetch(`http://127.0.0.1:${port}/api/work-items/${reconciledItem.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done", resolution: "Completed outside the card." }) });
  await fetch(`http://127.0.0.1:${port}/api/assignments/${reconciledPrepared.assignment.id}/events`, { method: "POST", headers: reconciledPrepared.callbackHeaders, body: JSON.stringify({ eventId: "reconcile-completed", type: "completed", ownerId: "reconcile-owner", result: "Late receipt preserved." }) });
  const externallyReconciled = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${reconciledItem.id}`)).json();
  assert.equal(externallyReconciled.status, "done");
  assert.equal(externallyReconciled.assignments[0].result, "Late receipt preserved.");
  assert.equal(captured.decisionState, "committed");
  assert.equal(captured.preparationMode, "auto");
  assert.equal(captured.sources[0].provider, "manual");
  const duplicateResponse = await fetch(`http://127.0.0.1:${port}/api/work-items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Duplicate", sourceKey: "manual-test-kickoff" }) });
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await duplicateResponse.json()).id, captured.id);
  const planned = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ plannedAt: "2026-07-13T16:00:00-07:00", plannedMinutes: 90 }) })).json();
  assert.equal(planned.plannedMinutes, 90);
  assert.equal(planned.plannedAt, "2026-07-13T23:00:00.000Z");
  const calendar = await (await fetch(`http://127.0.0.1:${port}/api/calendar?start=2026-07-13T00:00:00.000Z&end=2026-07-14T00:00:00.000Z`)).json();
  assert.deepEqual(calendar.events, []);
  const preview = await (await fetch(`http://127.0.0.1:${port}/api/delegation-preview?workItemId=${item.id}`)).json();
  assert.equal(preview.selectedSkill.id, "zoom-transcript-router");
  assert.ok(preview.availableSkills.some((skill) => skill.id === "draft-executive-email"));

  const policies = await (await fetch(`http://127.0.0.1:${port}/api/policies`)).json();
  assert.deepEqual(policies, []);

  const db = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO mail_messages(id,graph_id,subject,sender_name,sender_email,received_at,preview,body_text,body_cached_at,company_slug,reply_state,reply_confidence,reply_reason,freshness,last_synced_at,created_at,updated_at)
    VALUES('test-mail','graph-test','Need your feedback','Test Sender','sender@example.com',?,'Could you review this?','Could you review the attached proposal and send your reaction?',?,'stockiq','needs_reply',0.9,'The message asks Jake for feedback.','live',?,?,?)`).run(now, now, now, now, now);
  db.prepare(`INSERT INTO mail_messages(id,graph_id,subject,sender_name,sender_email,received_at,preview,company_slug,reply_state,reply_confidence,reply_reason,last_synced_at,created_at,updated_at)
    VALUES('newest-mail','graph-newest','Newest informational message','Recent Sender','recent@example.com',?,'Most recent message.',NULL,'informational',0.9,'Informational.',?,?,?)`).run(new Date(Date.now()+1000).toISOString(),now,now,now);
  db.prepare(`INSERT INTO mail_drafts(id,mail_message_id,generated_body,current_body,status,skill_id,source_basis,created_at,updated_at)
    VALUES('test-draft','test-mail','Thanks for sending this. I will review the attached proposal carefully and share my detailed thoughts shortly.','Thanks. I will review and send thoughts shortly.','edited','draft-executive-email','{}',?,?)`).run(now, now);
  db.prepare("UPDATE mail_messages SET action_work_item_id=? WHERE id='test-mail'").run(captured.id);
  db.close();

  const allMail = await (await fetch(`http://127.0.0.1:${port}/api/mail?view=all`)).json();
  assert.equal(allMail.items[0].id, "newest-mail");
  const categorized = await (await fetch(`http://127.0.0.1:${port}/api/work-items/${captured.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ companySlug: "edulog", eventDetail: "Jake assigned this card to Edulog." }) })).json();
  assert.equal(categorized.companySlug, "edulog");
  assert.equal(categorized.companyName, "Edulog");
  const categorizedMail = await (await fetch(`http://127.0.0.1:${port}/api/mail/test-mail`)).json();
  assert.equal(categorizedMail.companySlug, "edulog");
  const routingRules = await (await fetch(`http://127.0.0.1:${port}/api/policies`)).json();
  assert.ok(routingRules.some((rule) => rule.category === "company_routing" && rule.status === "proposed"));

  const feedback = await fetch(`http://127.0.0.1:${port}/api/feedback-events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventType: "draft_copied", mailMessageId: "test-mail", skillId: "draft-executive-email" }) });
  assert.equal(feedback.status, 201);
  const proposed = await (await fetch(`http://127.0.0.1:${port}/api/policies`)).json();
  const writingRule = proposed.find((rule) => rule.category === "writing");
  assert.equal(writingRule.status, "proposed");

  const accepted = await (await fetch(`http://127.0.0.1:${port}/api/policies/${writingRule.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "accepted" }) })).json();
  assert.equal(accepted.status, "accepted");
  const mailDetail = await (await fetch(`http://127.0.0.1:${port}/api/mail/test-mail`)).json();
  assert.equal(mailDetail.body.length > 0, true);
  assert.equal(mailDetail.activeRules.length, 1);
  const needsReplyBeforeReview = await (await fetch(`http://127.0.0.1:${port}/api/mail?view=needs_reply`)).json();
  assert.ok(needsReplyBeforeReview.items.some((message) => message.id === "test-mail"));
  const reviewedMail = await (await fetch(`http://127.0.0.1:${port}/api/mail/test-mail`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewState: "reviewed" }) })).json();
  assert.equal(reviewedMail.reviewState, "reviewed");
  const needsReplyAfterReview = await (await fetch(`http://127.0.0.1:${port}/api/mail?view=needs_reply`)).json();
  assert.ok(!needsReplyAfterReview.items.some((message) => message.id === "test-mail"));
  assert.equal(needsReplyAfterReview.counts.needs_reply, 0);
  const allMailAfterReview = await (await fetch(`http://127.0.0.1:${port}/api/mail?view=all`)).json();
  assert.ok(allMailAfterReview.items.some((message) => message.id === "test-mail"));
  const correctedMail = await (await fetch(`http://127.0.0.1:${port}/api/mail/test-mail`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ replyState: "responded" }) })).json();
  assert.equal(correctedMail.replyState, "responded");
  const verifyDb = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  const correctedRow = verifyDb.prepare("SELECT reply_override FROM mail_messages WHERE id='test-mail'").get();
  assert.equal(correctedRow.reply_override, "responded");
  verifyDb.close();

  const note = await (await fetch(`http://127.0.0.1:${port}/api/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "StockIQ decision", body: "Use the new packaging decision in follow-through.", type: "decision", companySlug: "stockiq" }) })).json();
  assert.match(note.filePath, /stockiq.+decision.+\.md$/i);
  assert.match(await readFile(note.filePath, "utf8"), /# StockIQ decision[\s\S]*packaging decision/);
  const editedNote = await (await fetch(`http://127.0.0.1:${port}/api/notes/${note.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Updated shared Markdown." }) })).json();
  assert.match(await readFile(editedNote.filePath, "utf8"), /Updated shared Markdown/);
  const previewWithNote = await (await fetch(`http://127.0.0.1:${port}/api/delegation-preview?workItemId=${item.id}`)).json();
  assert.ok(previewWithNote.contextManifest.noteIds.includes(note.id));

  const retiredLaunch = await fetch(`http://127.0.0.1:${port}/api/agent-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workItemId: item.id, scope: "item", skillId: "zoom-transcript-router", intent: "Process the kickoff transcript." }) });
  assert.equal(retiredLaunch.status, 410);

  const invalidOverride = await fetch(`http://127.0.0.1:${port}/api/delegation-preview?workItemId=${item.id}&skillId=arbitrary-shell`);
  assert.equal(invalidOverride.status, 400);

  const unlinkedClickUp = await fetch(`http://127.0.0.1:${port}/api/work-items/stockiq-transcript/complete-clickup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unlinkedClickUp.status, 410);

  const meetingDb = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  meetingDb.prepare(`INSERT INTO calendar_events(id,graph_id,subject,start_at,end_at,attendees_json,freshness,last_synced_at,created_at,updated_at)
    VALUES('meeting-event','graph-meeting','Test client meeting','2026-07-13T20:00:00.000Z','2026-07-13T20:30:00.000Z','[{"name":"Client"}]','live',?,?,?)`).run(now,now,now);
  meetingDb.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,status,suggested_action,source_provider,source_key,decision_state,created_at,updated_at)
    VALUES('meeting-card','meeting_follow_up','firm','Process test meeting','Meeting ended.','Transcript follow-through.','back_for_review','Review follow-ups.','calendar','post-meeting:graph-meeting','accepted',?,?)`).run(now,now);
  meetingDb.prepare(`INSERT INTO meeting_workflows(id,calendar_event_id,work_item_id,state,created_at,updated_at)
    VALUES('meeting-flow','meeting-event','meeting-card','review',?,?)`).run(now,now);
  meetingDb.prepare(`INSERT INTO meeting_action_suggestions(id,meeting_workflow_id,title,summary,company_slug,owner_state,suggested_action,decision,created_at,updated_at)
    VALUES('meeting-suggestion','meeting-flow','Send recap','Send the client a recap.','firm','jake','Draft the recap.','proposed',?,?)`).run(now,now);
  meetingDb.prepare(`INSERT INTO calendar_events(id,graph_id,subject,start_at,end_at,attendees_json,freshness,last_synced_at,created_at,updated_at)
    VALUES('no-transcript-event','graph-no-transcript','Unrecorded meeting','2026-07-13T21:00:00.000Z','2026-07-13T21:30:00.000Z','[{"name":"Client"}]','live',?,?,?)`).run(now,now,now);
  meetingDb.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,status,suggested_action,source_provider,source_key,decision_state,created_at,updated_at)
    VALUES('no-transcript-card','meeting_follow_up','firm','Process unrecorded meeting','Meeting ended.','Transcript follow-through.','waiting_on_user','Download transcript.','calendar','post-meeting:graph-no-transcript','accepted',?,?)`).run(now,now);
  meetingDb.prepare(`INSERT INTO meeting_workflows(id,calendar_event_id,work_item_id,state,created_at,updated_at)
    VALUES('no-transcript-flow','no-transcript-event','no-transcript-card','waiting_for_transcript',?,?)`).run(now,now);
  meetingDb.close();
  const meetingFlow = await (await fetch(`http://127.0.0.1:${port}/api/meeting-workflows/meeting-card`)).json();
  assert.equal(meetingFlow.suggestions.length, 1);
  const editedSuggestion = await (await fetch(`http://127.0.0.1:${port}/api/meeting-workflows/meeting-card/suggestions/meeting-suggestion`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "edit", title: "Send concise recap", suggestedAction: "Draft two paragraphs." }) })).json();
  assert.equal(editedSuggestion.suggestions[0].title, "Send concise recap");
  const acceptedSuggestion = await (await fetch(`http://127.0.0.1:${port}/api/meeting-workflows/meeting-card/suggestions/meeting-suggestion`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "accept" }) })).json();
  assert.equal(acceptedSuggestion.suggestions[0].decision, "accepted");
  const completedMeeting = await (await fetch(`http://127.0.0.1:${port}/api/meeting-workflows/meeting-card/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(completedMeeting.state, "complete");
  const noTranscript = await (await fetch(`http://127.0.0.1:${port}/api/meeting-workflows/no-transcript-card/no-transcript`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(noTranscript.state, "complete");
  const noTranscriptItems = await (await fetch(`http://127.0.0.1:${port}/api/work-items?status=done`)).json();
  assert.equal(noTranscriptItems.find((candidate) => candidate.id === "no-transcript-card").resolution, "No transcript was recorded for this meeting.");
});
