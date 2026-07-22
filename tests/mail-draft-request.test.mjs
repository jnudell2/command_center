import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const runnerPath = fileURLToPath(new URL("../scripts/local-control-server.mjs", import.meta.url));
const executorPath = fileURLToPath(new URL("./fixtures/fake-mail-draft-executor.mjs", import.meta.url));

async function waitFor(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return; } catch { /* keep waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Runner did not become ready at ${url}`);
}

async function stopRunner(runner) {
  if (!runner || runner.exitCode !== null) return;
  const exited = once(runner, "exit");
  runner.kill();
  await exited;
}

function startRunner({ dataDir, port, delayMs = 80, failFile = "", draftsEnabled = true }) {
  return spawn(process.execPath, [runnerPath], {
    cwd: appRoot,
    env: {
      ...process.env,
      SERENT_TEND_DATA_DIR: dataDir,
      SERENT_TEND_PORT: String(port),
      SERENT_TEND_DISABLE_LOCAL_WORKFLOWS: "1",
      SERENT_TEND_DISABLE_MAIL_DRAFTS: draftsEnabled ? "0" : "1",
      SERENT_TEND_MAIL_DRAFT_EXECUTOR_SCRIPT: executorPath,
      SERENT_TEND_MAIL_DRAFT_CONCURRENCY: "2",
      SERENT_TEND_MAIL_DRAFT_TIMEOUT_MS: "4000",
      SERENT_TEND_MAIL_DRAFT_TEST_DELAY_MS: String(delayMs),
      SERENT_TEND_MAIL_DRAFT_TEST_FAIL_FILE: failFile,
      SERENT_TEND_MAIL_DRAFT_TEST_LOG: path.join(dataDir, "draft-executor.jsonl"),
    },
    windowsHide: true,
  });
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options.body === undefined ? options : {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(options.body),
  });
  return { status: response.status, payload: await response.json() };
}

async function waitForMail(base, id, predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await request(base, `/api/mail/${id}`);
    if (last.status === 200 && predicate(last.payload)) return last.payload;
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  throw new Error(`Mail ${id} did not reach the expected state. Last state: ${JSON.stringify(last?.payload?.draftState || last?.payload)}`);
}

function insertMail(db, id, { subject = `Fixture ${id}`, body = `Exact cached body for ${id}.`, replyState = "informational", actionWorkItemId = null } = {}) {
  const now = "2026-07-22T16:00:00.000Z";
  db.prepare(`INSERT INTO mail_messages(id,graph_id,conversation_id,subject,sender_name,sender_email,recipients_json,cc_json,received_at,preview,body_text,body_cached_at,company_slug,reply_state,reply_confidence,reply_reason,action_work_item_id,freshness,last_synced_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, `graph-${id}`, `conversation-${id}`, subject, "Fixture Sender", "sender@example.com",
      JSON.stringify([{ name: "Jake", email: "jake@example.com" }]), JSON.stringify([{ name: "Teammate", email: "teammate@example.com" }]),
      now, body.slice(0, 120), body, now, "govworx", replyState, 0.5, "Fixture scope includes every visible message.", actionWorkItemId, "cached", now, now, now,
    );
}

function maxObservedConcurrency(logText) {
  let active = 0;
  let maximum = 0;
  for (const line of logText.trim().split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line).event;
    if (event === "start") active += 1;
    if (event === "finish" || event === "error") active -= 1;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

test("Mail is cache-first and generates one bounded draft per visible source fingerprint", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "serent-mail-draft-first-"));
  const port = 46300 + Math.floor(Math.random() * 300);
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner({ dataDir, port, delayMs: 180 });
  t.after(async () => { await stopRunner(runner); await rm(dataDir, { recursive: true, force: true }); });
  await waitFor(`${base}/api/health`);

  const databasePath = path.join(dataDir, "serent-tend.sqlite");
  const db = new DatabaseSync(databasePath);
  const now = "2026-07-22T16:00:00.000Z";
  db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,status,suggested_action,source_provider,source_key,decision_state,resolution,resolved_at,created_at,updated_at)
    VALUES('dismissed-mail-card','email','govworx','Old dismissed obligation','Fixture only.','Fixture only.','dismissed','Do not navigate here.','outlook','fixture-dismissed','accepted','Not needed.',?,?,?)`).run(now, now, now);
  db.prepare(`INSERT INTO notes(id,title,body,type,origin,state,company_slug,created_at,updated_at)
    VALUES('fixture-mail-note','Pricing context','Use only the confirmed workplan facts.','decision','manual','active','govworx',?,?)`).run(now, now);
  db.prepare(`INSERT INTO preference_rules(id,title,rationale,instruction,scope_type,scope_value,category,status,evidence_json,created_at,updated_at)
    VALUES('fixture-mail-rule','Keep it concise','Fixture preference.','Use a concise, direct tone.','skill','draft-executive-email','draft_style','accepted','[]',?,?)`).run(now, now);
  insertMail(db, "mail-one", { subject: "Workplan review", body: "Can you confirm the pricing workplan?", replyState: "needs_reply", actionWorkItemId: "dismissed-mail-card" });
  insertMail(db, "mail-two", { subject: "Informational update", body: "Sharing the latest information for awareness.", replyState: "informational" });
  insertMail(db, "mail-three", { subject: "Already answered", body: "Thanks for the reply you sent.", replyState: "responded" });
  insertMail(db, "mail-four", { subject: "No obligation gate", body: "A visible Mail row is enough to draft.", replyState: "informational" });
  db.prepare("INSERT INTO mail_note_links(mail_message_id,note_id) VALUES('mail-one','fixture-mail-note')").run();
  const businessBefore = db.prepare("SELECT status,resolution,resolved_at,updated_at FROM work_items WHERE id='dismissed-mail-card'").get();
  db.close();

  const startedAt = Date.now();
  const list = await request(base, "/api/mail?view=all");
  assert.equal(list.status, 200);
  assert.ok(Date.now() - startedAt < 500, "Mail list must render from cache without waiting for draft generation");
  assert.equal(list.payload.items.length, 4);
  await Promise.all([request(base, "/api/mail?view=all"), request(base, "/api/mail/mail-one"), request(base, "/api/mail/mail-one")]);

  const ready = await Promise.all(["mail-one", "mail-two", "mail-three", "mail-four"].map((id) => waitForMail(base, id, (mail) => mail.draftState === "ready")));
  assert.ok(ready.every((mail) => mail.draft?.currentBody.includes("[fixture ")));
  assert.ok(ready.every((mail) => mail.draft?.skillId === "draft-executive-email"));
  assert.equal(ready.find((mail) => mail.id === "mail-one").actionWorkItemStatus, "dismissed");

  const verify = new DatabaseSync(databasePath);
  assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version=15").get());
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_generations").get().count, 4);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_drafts").get().count, 4);
  const prompt = verify.prepare("SELECT prompt_text FROM mail_draft_generations WHERE mail_message_id='mail-one'").get().prompt_text;
  for (const evidence of ["$draft-executive-email", "Can you confirm the pricing workplan?", "Jake <jake@example.com>", "Teammate <teammate@example.com>", "Use a concise, direct tone.", "Use only the confirmed workplan facts."]) assert.match(prompt, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /Do not send email, create an Outlook draft/);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE scope='mail_draft'").get().count, 0);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM external_actions").get().count, 0);
  assert.deepEqual(verify.prepare("SELECT status,resolution,resolved_at,updated_at FROM work_items WHERE id='dismissed-mail-card'").get(), businessBefore);
  assert.deepEqual(verify.prepare("PRAGMA foreign_key_check").all(), []);
  verify.close();

  const log = await readFile(path.join(dataDir, "draft-executor.jsonl"), "utf8");
  assert.ok(maxObservedConcurrency(log) <= 2, "the dedicated queue must enforce bounded concurrency");
  assert.equal(log.match(/"event":"start"/g)?.length, 4, "duplicate refresh/open events must reuse the same generation");
  assert.equal((await request(base, "/api/mail/mail-one/draft-request", { method: "POST", body: {} })).status, 410);
});

test("source changes and regeneration preserve Jake edits until he chooses a revision", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "serent-mail-draft-revision-"));
  const port = 46610 + Math.floor(Math.random() * 250);
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner({ dataDir, port, delayMs: 80 });
  t.after(async () => { await stopRunner(runner); await rm(dataDir, { recursive: true, force: true }); });
  await waitFor(`${base}/api/health`);
  const databasePath = path.join(dataDir, "serent-tend.sqlite");
  let db = new DatabaseSync(databasePath);
  insertMail(db, "mail-revision", { subject: "Revision fixture", body: "Original exact source body." });
  db.close();
  const first = await waitForMail(base, "mail-revision", (mail) => mail.draftState === "ready");
  const editedBody = `${first.draft.currentBody}\n\nJake's local edit must survive.`;
  const autosaved = await request(base, "/api/mail/mail-revision/draft", { method: "PATCH", body: { body: editedBody } });
  assert.equal(autosaved.payload.draft.currentBody, editedBody);
  assert.equal(autosaved.payload.draft.status, "edited");

  db = new DatabaseSync(databasePath);
  db.prepare("UPDATE mail_messages SET body_text='Materially changed exact source body.',body_cached_at=?,updated_at=? WHERE id='mail-revision'").run(new Date().toISOString(), new Date().toISOString());
  db.close();
  const changed = await waitForMail(base, "mail-revision", (mail) => mail.draftState === "revision_ready");
  assert.equal(changed.draft.currentBody, editedBody);
  assert.notEqual(changed.draft.pendingBody, editedBody);
  const accepted = await request(base, "/api/mail/mail-revision/draft/revision", { method: "POST", body: { action: "use", generationId: changed.draft.pendingGenerationId } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.draftState, "ready");
  assert.equal(accepted.payload.draft.currentBody, changed.draft.pendingBody);

  const secondEdit = `${accepted.payload.draft.currentBody}\nKeep this manual ending.`;
  await request(base, "/api/mail/mail-revision/draft", { method: "PATCH", body: { body: secondEdit } });
  const [regenerate, duplicate] = await Promise.all([
    request(base, "/api/mail/mail-revision/draft", { method: "POST", body: { feedback: "Make it even shorter." } }),
    request(base, "/api/mail/mail-revision/draft", { method: "POST", body: { feedback: "Make it even shorter." } }),
  ]);
  assert.equal(regenerate.status, 202);
  assert.equal(duplicate.status, 202);
  assert.equal(regenerate.payload.generationId, duplicate.payload.generationId);
  const regenerated = await waitForMail(base, "mail-revision", (mail) => mail.draftState === "revision_ready" && mail.draft.pendingGenerationId === regenerate.payload.generationId);
  assert.equal(regenerated.draft.currentBody, secondEdit);
  const kept = await request(base, "/api/mail/mail-revision/draft/revision", { method: "POST", body: { action: "keep", generationId: regenerated.draft.pendingGenerationId } });
  assert.equal(kept.payload.draft.currentBody, secondEdit);
  assert.equal(kept.payload.draft.status, "edited");

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_generations WHERE mail_message_id='mail-revision'").get().count, 3);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_revisions WHERE origin='manual'").get().count, 2);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_generations WHERE status IN ('queued','working')").get().count, 0);
  verify.close();
});

test("failed generation retries the same fingerprint and restart recovery reuses the interrupted row", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "serent-mail-draft-recovery-"));
  const failFile = path.join(dataDir, "fail-state.txt");
  const port = 46900 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  let runner = startRunner({ dataDir, port, delayMs: 80, failFile });
  t.after(async () => { await stopRunner(runner); await rm(dataDir, { recursive: true, force: true }); });
  await waitFor(`${base}/api/health`);
  const databasePath = path.join(dataDir, "serent-tend.sqlite");
  let db = new DatabaseSync(databasePath);
  insertMail(db, "mail-failure", { subject: "Failure fixture", body: "Retry this exact source." });
  db.close();
  await writeFile(failFile, "fail", "utf8");
  const failed = await waitForMail(base, "mail-failure", (mail) => mail.draftState === "error");
  const failedGenerationId = failed.draftGeneration.id;
  assert.match(failed.draftGeneration.error, /failed by request/i);
  await writeFile(failFile, "pass", "utf8");
  const retry = await request(base, "/api/mail/mail-failure/draft/retry", { method: "POST", body: {} });
  assert.equal(retry.payload.generationId, failedGenerationId);
  const recovered = await waitForMail(base, "mail-failure", (mail) => mail.draftState === "ready");
  assert.equal(recovered.draftGeneration.id, failedGenerationId);
  assert.equal(recovered.draftGeneration.attempt, 2);

  await stopRunner(runner);
  runner = startRunner({ dataDir, port, delayMs: 1500, failFile });
  await waitFor(`${base}/api/health`);
  insertMail((db = new DatabaseSync(databasePath)), "mail-interrupted", { subject: "Restart fixture", body: "Recover this generation after restart." });
  db.close();
  await request(base, "/api/mail/mail-interrupted");
  await waitForMail(base, "mail-interrupted", (mail) => mail.draftState === "working");
  const beforeRestartDb = new DatabaseSync(databasePath, { readOnly: true });
  const beforeRestart = beforeRestartDb.prepare("SELECT id FROM mail_draft_generations WHERE mail_message_id='mail-interrupted'").get();
  beforeRestartDb.close();
  await stopRunner(runner);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  runner = startRunner({ dataDir, port, delayMs: 20, failFile });
  await waitFor(`${base}/api/health`);
  const afterRestart = await waitForMail(base, "mail-interrupted", (mail) => mail.draftState === "ready");
  assert.equal(afterRestart.draftGeneration.id, beforeRestart.id);
  assert.equal(afterRestart.draftGeneration.attempt, 2);
  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_generations WHERE mail_message_id='mail-interrupted'").get().count, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_generation_events WHERE generation_id=? AND type='restart_requeued'").get(beforeRestart.id).count, 1);
  verify.close();
});

test("Mail UI exposes honest draft-first, accessible review states without card routing", async () => {
  const [source, styles, runner, contract] = await Promise.all([
    readFile(new URL("../app/mail-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-control-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/command-center-capability-contract-v2.md", import.meta.url), "utf8"),
  ]);
  for (const label of ["Every visible message gets a source-grounded proposed reply", "Drafting", "Retry", "Regenerate", "Use new draft", "Keep my draft", "Copy reply", "Promote to Open Work"]) assert.match(source, new RegExp(label));
  assert.match(source, /aria-label="Proposed reply draft"/);
  assert.match(source, /aria-live="polite"/);
  assert.doesNotMatch(source, /Request CEO draft|Copy drafting request|cannot invoke the native CEO \/ PM task|Draft proposed reply/);
  const regenerateBlock = source.slice(source.indexOf("const regenerateDraft"), source.indexOf("const retryDraft"));
  assert.match(regenerateBlock, /\/draft/);
  assert.doesNotMatch(regenerateBlock, /onOpenWorkItem|promote/);
  assert.match(styles, /\.mail-draft-progress/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  const isolatedBlock = runner.slice(runner.indexOf("async function enqueueMailDraftGeneration"), runner.indexOf("function projectDateAtEndOfDay"));
  assert.doesNotMatch(isolatedBlock, /launchAgentRun|agent_runs|external_actions|promoteMailToOpenWork|sendMail|Outlook draft/);
  assert.match(contract, /Bounded review-only generative utilities/);
  assert.match(contract, /draft-first/);
});
