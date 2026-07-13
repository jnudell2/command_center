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
  assert.deepEqual(bootstrap.mailCounts, { all: 0, needs_reply: 0, unread: 0, drafts: 0, snoozed: 0 });
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
  assert.equal(captured.decisionState, "committed");
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
  db.prepare(`INSERT INTO mail_messages(id,graph_id,subject,sender_name,sender_email,received_at,preview,body_text,body_cached_at,company_slug,reply_state,reply_confidence,reply_reason,last_synced_at,created_at,updated_at)
    VALUES('test-mail','graph-test','Need your feedback','Test Sender','sender@example.com',?,'Could you review this?','Could you review the attached proposal and send your reaction?',?,'stockiq','needs_reply',0.9,'The message asks Jake for feedback.',?,?,?)`).run(now, now, now, now, now);
  db.prepare(`INSERT INTO mail_messages(id,graph_id,subject,sender_name,sender_email,received_at,preview,company_slug,reply_state,reply_confidence,reply_reason,last_synced_at,created_at,updated_at)
    VALUES('newest-mail','graph-newest','Newest informational message','Recent Sender','recent@example.com',?,'Most recent message.',NULL,'informational',0.9,'Informational.',?,?,?)`).run(new Date(Date.now()+1000).toISOString(),now,now,now);
  db.prepare(`INSERT INTO mail_drafts(id,mail_message_id,generated_body,current_body,status,skill_id,source_basis,created_at,updated_at)
    VALUES('test-draft','test-mail','Thanks for sending this. I will review the attached proposal carefully and share my detailed thoughts shortly.','Thanks. I will review and send thoughts shortly.','edited','draft-executive-email','{}',?,?)`).run(now, now);
  db.close();

  const allMail = await (await fetch(`http://127.0.0.1:${port}/api/mail?view=all`)).json();
  assert.equal(allMail.items[0].id, "newest-mail");

  const feedback = await fetch(`http://127.0.0.1:${port}/api/feedback-events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventType: "draft_copied", mailMessageId: "test-mail", skillId: "draft-executive-email" }) });
  assert.equal(feedback.status, 201);
  const proposed = await (await fetch(`http://127.0.0.1:${port}/api/policies`)).json();
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].status, "proposed");

  const accepted = await (await fetch(`http://127.0.0.1:${port}/api/policies/${proposed[0].id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "accepted" }) })).json();
  assert.equal(accepted.status, "accepted");
  const mailDetail = await (await fetch(`http://127.0.0.1:${port}/api/mail/test-mail`)).json();
  assert.equal(mailDetail.body.length > 0, true);
  assert.equal(mailDetail.activeRules.length, 1);
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

  const waiting = await (await fetch(`http://127.0.0.1:${port}/api/agent-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workItemId: item.id, scope: "item", skillId: "zoom-transcript-router", intent: "Process the kickoff transcript." }) })).json();
  assert.equal(waiting.status, "waiting_on_user");
  assert.equal(waiting.executorType, "allowlisted_local_workflow");

  const invalidOverride = await fetch(`http://127.0.0.1:${port}/api/delegation-preview?workItemId=${item.id}&skillId=arbitrary-shell`);
  assert.equal(invalidOverride.status, 400);

  const unlinkedClickUp = await fetch(`http://127.0.0.1:${port}/api/work-items/stockiq-transcript/complete-clickup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unlinkedClickUp.status, 400);
});
