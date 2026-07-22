import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("keeps CEO mail drafting local, idempotent, capability-bound, and separate from Open Work", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "serent-mail-draft-request-"));
  const port = 46300 + Math.floor(Math.random() * 400);
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

  const databasePath = path.join(dataDir, "serent-tend.sqlite");
  const db = new DatabaseSync(databasePath);
  const now = "2026-07-21T20:00:00.000Z";
  db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,status,suggested_action,source_provider,source_key,decision_state,resolution,resolved_at,created_at,updated_at)
    VALUES('dismissed-mail-card','email','govworx','Reply to fixture sender','Fixture mail obligation.','Fixture only.','dismissed','Reply to the fixture sender.','outlook','fixture-graph','accepted','Not needed in fixture.',?,?,?)`).run(now, now, now);
  db.prepare(`INSERT INTO mail_messages(id,graph_id,subject,sender_name,sender_email,received_at,preview,body_text,body_cached_at,company_slug,reply_state,reply_confidence,reply_reason,action_work_item_id,freshness,last_synced_at,created_at,updated_at)
    VALUES('mail-fixture','fixture-graph','Re: Fixture pricing workplan review','Fixture Sender','sender@example.com',?,'Can you confirm the workplan?','Jake, can you confirm the workplan and next steps?',?,'govworx','needs_reply',.94,'The sender asked Jake to confirm.','dismissed-mail-card','live',?,?,?)`).run(now, now, now, now, now);
  const businessBefore = db.prepare("SELECT status,resolution,resolved_at,updated_at FROM work_items WHERE id='dismissed-mail-card'").get();
  db.close();

  const request = async (pathname, options = {}) => {
    const response = await fetch(`${base}${pathname}`, options.body === undefined ? options : { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) }, body: JSON.stringify(options.body) });
    return { status: response.status, payload: await response.json() };
  };

  const first = await request("/api/mail/mail-fixture/draft-request", { method: "POST", body: {} });
  assert.equal(first.status, 201);
  assert.equal(first.payload.reused, false);
  assert.equal(first.payload.mail.id, "mail-fixture");
  assert.equal(first.payload.mail.draftRequestState, "requested");
  assert.equal(first.payload.mail.actionWorkItemStatus, "dismissed");
  assert.match(first.payload.packet.packetText, /Message ID: mail-fixture/);
  assert.match(first.payload.packet.packetText, /Fixture Sender/);
  assert.match(first.payload.packet.packetText, /POST http:\/\/127\.0\.0\.1:/);
  assert.match(first.payload.packet.packetText, /This does not send email or create an Outlook draft/);

  const duplicate = await request("/api/mail/mail-fixture/draft-request", { method: "POST", body: {} });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.payload.reused, true);
  assert.equal(duplicate.payload.request.id, first.payload.request.id);

  const packet = await request(`/api/mail-draft-requests/${first.payload.request.id}/packet`, { method: "POST", body: {} });
  assert.equal(packet.status, 200);
  assert.match(packet.payload.packetText, /active rules/i);
  const invalidWriteback = await request(`/api/mail-draft-requests/${first.payload.request.id}/writeback`, { method: "POST", body: { revisionId: "ceo-revision-1", body: "Thanks. I will confirm the workplan shortly." } });
  assert.equal(invalidWriteback.status, 403);

  const writebackBody = { revisionId: "ceo-revision-1", body: "Thanks. I will confirm the workplan and next steps shortly.", provenance: "Command Center CEO / PM", sourceBasis: ["mail-fixture", "accepted rules"], sourceFreshness: "Fixture mail verified on 2026-07-21" };
  const writeback = await request(`/api/mail-draft-requests/${first.payload.request.id}/writeback`, { method: "POST", headers: { authorization: `Bearer ${first.payload.packet.capability}` }, body: writebackBody });
  assert.equal(writeback.status, 200);
  assert.equal(writeback.payload.replayed, false);
  assert.equal(writeback.payload.request.status, "draft_ready");
  assert.equal(writeback.payload.mail.draft.currentBody, writebackBody.body);
  assert.equal(writeback.payload.mail.draftRequest.provenance, "Command Center CEO / PM");
  assert.equal(writeback.payload.mail.draftRequest.sourceFreshness, "Fixture mail verified on 2026-07-21");

  const replay = await request(`/api/mail-draft-requests/${first.payload.request.id}/writeback`, { method: "POST", headers: { authorization: `Bearer ${first.payload.packet.capability}` }, body: { ...writebackBody, body: "A replay must not replace the accepted body." } });
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.mail.draft.currentBody, writebackBody.body);

  const editedBody = `${writebackBody.body} I will follow up tomorrow.`;
  const autosaved = await request("/api/mail/mail-fixture/draft", { method: "PATCH", body: { body: editedBody } });
  assert.equal(autosaved.payload.draft.currentBody, editedBody);
  assert.equal(autosaved.payload.draft.status, "edited");
  const feedback = await request("/api/feedback-events", { method: "POST", body: { eventType: "draft_copied", mailMessageId: "mail-fixture", skillId: "draft-executive-email", detail: "Fixture copy only." } });
  assert.equal(feedback.status, 201);

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version=14").get());
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_requests WHERE mail_message_id='mail-fixture'").get().count, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_writebacks WHERE request_id=? AND revision_key='ceo-revision-1'").get(first.payload.request.id).count, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_revisions WHERE mail_draft_id=? AND origin='ceo_pm'").get(writeback.payload.mail.draft.id).count, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM mail_draft_revisions WHERE mail_draft_id=? AND origin='manual'").get(writeback.payload.mail.draft.id).count, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE scope='mail_draft'").get().count, 0);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM external_actions").get().count, 0);
  assert.deepEqual(verify.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(verify.prepare("SELECT status,resolution,resolved_at,updated_at FROM work_items WHERE id='dismissed-mail-card'").get(), businessBefore);
  assert.equal(verify.prepare("SELECT action_work_item_id FROM mail_messages WHERE id='mail-fixture'").get().action_work_item_id, "dismissed-mail-card");
  verify.close();

  const retired = await request("/api/mail/mail-fixture/draft", { method: "POST", body: {} });
  assert.equal(retired.status, 410);
  const promoted = await request("/api/mail/mail-fixture", { method: "PATCH", body: { promote: true, detail: "Fixture explicit promotion." } });
  assert.equal(promoted.payload.actionWorkItemId, "dismissed-mail-card");
  assert.equal(promoted.payload.actionWorkItemStatus, "to_review");
});

test("Mail UI keeps drafting and Open Work promotion as separate accessible controls", async () => {
  const [source, styles, runner] = await Promise.all([
    readFile(new URL("../app/mail-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-control-server.mjs", import.meta.url), "utf8"),
  ]);
  const requestBlock = source.slice(source.indexOf("const requestDraft"), source.indexOf("const copyDraftRequest"));
  assert.match(requestBlock, /\/draft-request/);
  assert.doesNotMatch(requestBlock, /onOpenWorkItem|promote/);
  assert.doesNotMatch(source, /generateDraft|Draft proposed reply|Using<\/span><strong>Executive Email Draft/);
  for (const label of ["Request CEO draft", "Copy drafting request", "Promote to Open Work", "Open in Open Work", "Not requested", "Requested", "Draft ready", "Needs attention", "Copy reply"]) assert.match(source, new RegExp(label));
  assert.match(source, /cannot invoke the native CEO \/ PM task because Codex exposes no host bridge/i);
  assert.match(source, /aria-label="Proposed reply draft"/);
  assert.doesNotMatch(source, /^\s*void refresh\(false\);/m, "opening Mail must remain cache-first during read-only navigation");
  assert.match(styles, /\.mail-draft-workspace \.mail-actions button[\s\S]*min-height: 40px/);
  assert.doesNotMatch(runner, /function launchMailDraft/);
  assert.match(runner, /Command Center cannot launch a Codex draft worker/);
});
