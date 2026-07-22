import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return; } catch { /* keep waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Runner did not become ready at ${url}`);
}

test("keeps deterministic autonomy reversible and CEO intelligence shadow-only", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "serent-intelligence-autonomy-"));
  const port = 45800 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
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
  await waitFor(`${base}/api/health`);

  const request = async (pathname, options = {}) => {
    const response = await fetch(`${base}${pathname}`, options.body === undefined ? options : { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) }, body: JSON.stringify(options.body) });
    return { status: response.status, payload: await response.json() };
  };
  const createItem = async (title, companySlug = "firm") => (await request("/api/work-items", { method: "POST", body: { title, companySlug, sourceKey: `fixture:${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}` } })).payload;

  const databasePath = path.join(dataDir, "serent-tend.sqlite");
  const db = new DatabaseSync(databasePath);
  const now = "2026-07-21T20:00:00.000Z";
  const centralId = "24485506-6ffd-4b0b-944f-44e9669d32d9";
  db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,draft,owner,source_provider,source_key,resolution,created_at,updated_at,decision_state,planned_minutes,preparation_mode,preparation_skill,preparation_instruction,waiting_on)
    VALUES(?, 'project_action','govworx','Obtain the GovWorx product demo','A product demo is required for the fact base.','The kickoff plan and secret-shopping scope both depend on seeing the product.','high',1,'waiting_external','Ask Kevin to provide or schedule the product demo.','','External','fixture','fixture:govworx-demo','',?,?,'committed',0,'none','','','GovWorx / Kevin')`).run(centralId, now, now);
  const kickoff = await createItem("Approved GovWorx kickoff deck commitment", "govworx");
  const hugo = await createItem("Define Hugo secret-shopping scope", "govworx");

  const centralReview = await request("/api/intelligence/reviews", { method: "POST", body: {
    workItemId: centralId,
    reviewKey: "shadow:govworx-demo:v1",
    status: "new_evidence",
    whatItMeans: "The product demo remains an unmet external dependency.",
    whyItMattersNow: "The approved kickoff fact base and Hugo secret-shopping scope both depend on seeing the product.",
    recommendedNextMove: "Ask Kevin to provide or schedule the product demo before the fact-base analysis begins.",
    ownerDependency: "GovWorx / Kevin",
    definitionOfDone: "A reviewable demo or recording is linked as delivered evidence.",
    evidenceWatermark: now,
    evidence: [
      { label: "Approved kickoff deck", freshness: "Verified fixture evidence", observedAt: now },
      { label: "Hugo secret-shopping scope", freshness: "Verified fixture evidence", observedAt: now },
      { label: "No delivered demo or recording", freshness: "Not proven as of fixture review", observedAt: now },
    ],
    relationships: [
      { toWorkItemId: kickoff.id, relationType: "supports", state: "confirmed", rationale: "The kickoff deck records the demo commitment." },
      { toWorkItemId: hugo.id, relationType: "informs", state: "confirmed", rationale: "The demo informs the secret-shopping scope." },
    ],
  } });
  assert.equal(centralReview.status, 201);
  const centralReviewReplay = await request("/api/intelligence/reviews", { method: "POST", body: { workItemId: centralId, reviewKey: "shadow:govworx-demo:v1" } });
  assert.equal(centralReviewReplay.payload.replayed, true);
  const central = (await request(`/api/work-items/${centralId}`)).payload;
  assert.equal(central.status, "waiting_external");
  assert.equal(central.waitingOn, "GovWorx / Kevin");
  assert.equal(central.intelligenceReview.status, "new_evidence");
  assert.equal(central.relationships.length, 2);
  assert.match(central.intelligenceReview.recommendedNextMove, /Ask Kevin/i);
  assert.equal(central.intelligenceReview.evidence.some((evidence) => /delivered demo/i.test(evidence.label)), true);

  const shadowCards = [central];
  for (let index = 0; index < 11; index += 1) {
    const companySlug = ["govworx", "stockiq", "avionte"][index % 3];
    const card = await createItem(`Shadow acceptance card ${index + 1}`, companySlug);
    const review = await request("/api/intelligence/reviews", { method: "POST", body: { workItemId: card.id, reviewKey: `shadow:acceptance:${index + 1}`, status: index % 4 === 0 ? "needs_reconciliation" : "current", whatItMeans: `Fixture interpretation ${index + 1}`, recommendedNextMove: `One clear fixture next move ${index + 1}`, ownerDependency: "Jake", definitionOfDone: "The fixture outcome is recorded.", evidence: [{ label: `Fixture evidence ${index + 1}`, freshness: "Current fixture" }] } });
    assert.equal(review.status, 201);
    shadowCards.push((await request(`/api/work-items/${card.id}`)).payload);
  }
  assert.equal(shadowCards.length, 12);
  assert.equal(shadowCards.filter((card) => card.status === "back_for_review").length, 0);
  assert.equal(shadowCards.every((card) => card.intelligenceReview?.recommendedNextMove), true);
  const queue = (await request("/api/intelligence/reconciliation")).payload;
  assert.ok(queue.some((item) => item.workItemId === centralId && item.businessStatus === "waiting_external"));

  const lifecycle = await createItem("Technical result must not change business state", "stockiq");
  const prepared = (await request(`/api/work-items/${lifecycle.id}/instructions`, { method: "POST", body: { mode: "return_here", instruction: "Return fixture evidence only." } })).payload;
  const capability = prepared.handoffPacket.prompt.match(/^Authorization: Bearer ([A-Za-z0-9_-]+)$/m)?.[1];
  for (const event of [
    { eventId: "shadow-tech-accepted", type: "accepted", ownerId: "fixture-owner" },
    { eventId: "shadow-tech-started", type: "started", ownerId: "fixture-owner" },
    { eventId: "shadow-tech-completed", type: "completed", ownerId: "fixture-owner", result: "Read-only technical evidence." },
  ]) {
    const result = await request(`/api/assignments/${prepared.assignment.id}/events`, { method: "POST", headers: { authorization: `Bearer ${capability}` }, body: event });
    assert.equal(result.status, 200);
  }
  const afterTechnicalResult = (await request(`/api/work-items/${lifecycle.id}`)).payload;
  assert.equal(afterTechnicalResult.status, "to_review");
  assert.equal(afterTechnicalResult.assignments[0].status, "completed");

  const mutable = await createItem("Deterministic mutation fixture", "avionte");
  const waitingMutation = await request(`/api/work-items/${mutable.id}/mutations`, { method: "POST", body: { type: "waiting", idempotencyKey: "fixture:waiting:one", waitingOn: "Fixture owner", followUpAt: "2026-07-25T23:59:59.000Z", evidence: [{ label: "Fixture dependency" }] } });
  assert.equal(waitingMutation.payload.updated.status, "waiting_external");
  assert.equal(waitingMutation.payload.updated.waitingOn, "Fixture owner");
  const waitingReplay = await request(`/api/work-items/${mutable.id}/mutations`, { method: "POST", body: { type: "waiting", idempotencyKey: "fixture:waiting:one", waitingOn: "Different owner" } });
  assert.equal(waitingReplay.payload.replayed, true);
  assert.equal(waitingReplay.payload.mutationId, waitingMutation.payload.mutationId);
  const waitingUndo = await request(`/api/deterministic-mutations/${waitingMutation.payload.mutationId}/undo`, { method: "POST", body: {} });
  assert.equal(waitingUndo.payload.updated.status, "to_review");
  assert.equal(waitingUndo.payload.updated.waitingOn, "");
  assert.equal(waitingUndo.payload.updated.followUpAt, null);

  const evidenceMutation = await request(`/api/work-items/${mutable.id}/mutations`, { method: "POST", body: { type: "add_evidence", idempotencyKey: "fixture:evidence:one", label: "Fixture source", sourceUrl: "https://example.com/fixture" } });
  assert.equal(evidenceMutation.payload.updated.sources.some((source) => source.sourceUrl === "https://example.com/fixture"), true);
  const evidenceUndo = await request(`/api/deterministic-mutations/${evidenceMutation.payload.mutationId}/undo`, { method: "POST", body: {} });
  assert.equal(evidenceUndo.payload.updated.sources.some((source) => source.sourceUrl === "https://example.com/fixture"), false);

  const duplicate = await createItem("Explicit duplicate fixture", "avionte");
  const duplicateLink = await request(`/api/work-items/${duplicate.id}/mutations`, { method: "POST", body: { type: "link_duplicate", idempotencyKey: "fixture:duplicate:one", canonicalWorkItemId: mutable.id } });
  assert.equal(duplicateLink.payload.updated.relationships[0].relationType, "duplicates");
  assert.equal(duplicateLink.payload.updated.status, "to_review");
  const duplicateUndo = await request(`/api/deterministic-mutations/${duplicateLink.payload.mutationId}/undo`, { method: "POST", body: {} });
  assert.equal(duplicateUndo.payload.updated.relationships.length, 0);

  const reconciled = await createItem("Reconciliation packet fixture", "firm");
  const packet = await request("/api/reconciliation-packets", { method: "POST", body: { workItemId: reconciled.id, idempotencyKey: "fixture:reconciliation:one", expectedUpdatedAt: reconciled.updatedAt, proposed: { priority: "high", owner: "Jake" }, evidence: [{ label: "Fixture CEO evidence" }] } });
  assert.equal(packet.status, 201);
  const applied = await request(`/api/reconciliation-packets/${packet.payload.packet.id}/apply`, { method: "POST", body: {} });
  assert.equal(applied.payload.updated.priority, "high");
  const replayedApply = await request(`/api/reconciliation-packets/${packet.payload.packet.id}/apply`, { method: "POST", body: {} });
  assert.equal(replayedApply.payload.replayed, true);

  const stale = await createItem("Stale reconciliation fixture", "firm");
  const stalePacket = await request("/api/reconciliation-packets", { method: "POST", body: { workItemId: stale.id, idempotencyKey: "fixture:reconciliation:stale", expectedUpdatedAt: stale.updatedAt, proposed: { priority: "urgent" } } });
  await request(`/api/work-items/${stale.id}/mutations`, { method: "POST", body: { type: "update", idempotencyKey: "fixture:stale:intervening", changes: { owner: "Intervening owner" } } });
  const staleApply = await request(`/api/reconciliation-packets/${stalePacket.payload.packet.id}/apply`, { method: "POST", body: {} });
  assert.equal(staleApply.status, 409);
  assert.match(staleApply.payload.error, /changed after/i);

  assert.ok(db.prepare("SELECT version FROM schema_migrations WHERE version=13").get());
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM deterministic_mutations WHERE idempotency_key='fixture:waiting:one'").get().count, 1);
  assert.equal(db.prepare("SELECT status FROM reconciliation_packets WHERE id=?").get(stalePacket.payload.packet.id).status, "stale");
  db.close();
});
