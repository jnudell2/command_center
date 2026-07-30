import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const runnerScript = fileURLToPath(new URL("../scripts/local-control-server.mjs", import.meta.url));
const jsonHeaders = { "content-type": "application/json", "x-serent-command-center": "1" };

async function waitFor(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return; } catch { /* runner is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Runner did not become ready at ${url}`);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

test("manual calendar blocks are local, idempotent, editable, reversible, and audited", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "serent-calendar-blocks-"));
  const port = 46900 + Math.floor(Math.random() * 300);
  const base = `http://127.0.0.1:${port}`;
  const runner = spawn(process.execPath, [runnerScript], {
    cwd: appRoot,
    env: {
      ...process.env,
      SERENT_TEND_DATA_DIR: dataDir,
      SERENT_TEND_PORT: String(port),
      SERENT_TEND_DISABLE_LOCAL_WORKFLOWS: "1",
      SERENT_TEND_DISABLE_MAIL_DRAFTS: "1",
    },
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

  const source = {
    requestKey: "calendar-block-qa-1",
    title: "Deep work on pricing narrative",
    startAt: "2026-07-30T16:00:00.000Z",
    endAt: "2026-07-30T17:00:00.000Z",
  };
  const created = await request(`${base}/api/calendar/work-blocks`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(source) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.title, source.title);
  assert.equal(created.body.state, "active");

  const replay = await request(`${base}/api/calendar/work-blocks`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(source) });
  assert.equal(replay.response.status, 201);
  assert.equal(replay.body.id, created.body.id);

  const day = await request(`${base}/api/calendar?start=2026-07-30T00:00:00.000Z&end=2026-07-31T00:00:00.000Z`);
  assert.equal(day.response.status, 200);
  assert.deepEqual(day.body.workBlocks.map((block) => block.id), [created.body.id]);

  const updated = await request(`${base}/api/calendar/work-blocks/${created.body.id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({
      title: "Deep work on final pricing narrative",
      startAt: "2026-07-30T16:15:00.000Z",
      endAt: "2026-07-30T17:45:00.000Z",
      expectedUpdatedAt: created.body.updatedAt,
    }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.title, "Deep work on final pricing narrative");

  const stale = await request(`${base}/api/calendar/work-blocks/${created.body.id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ title: "Stale edit", expectedUpdatedAt: created.body.updatedAt }),
  });
  assert.equal(stale.response.status, 409);

  const removed = await request(`${base}/api/calendar/work-blocks/${created.body.id}`, { method: "DELETE", headers: jsonHeaders });
  assert.equal(removed.body.state, "cancelled");
  const repeatedRemove = await request(`${base}/api/calendar/work-blocks/${created.body.id}`, { method: "DELETE", headers: jsonHeaders });
  assert.equal(repeatedRemove.body.updatedAt, removed.body.updatedAt);
  const withoutRemoved = await request(`${base}/api/calendar?start=2026-07-30T00:00:00.000Z&end=2026-07-31T00:00:00.000Z`);
  assert.deepEqual(withoutRemoved.body.workBlocks, []);

  const restored = await request(`${base}/api/calendar/work-blocks/${created.body.id}/restore`, { method: "POST", headers: jsonHeaders, body: "{}" });
  assert.equal(restored.body.state, "active");
  const repeatedRestore = await request(`${base}/api/calendar/work-blocks/${created.body.id}/restore`, { method: "POST", headers: jsonHeaders, body: "{}" });
  assert.equal(repeatedRestore.body.updatedAt, restored.body.updatedAt);

  const history = await request(`${base}/api/calendar/work-blocks/${created.body.id}/history`);
  assert.deepEqual(history.body.map((event) => event.type).sort(), ["created", "removed", "restored", "updated"].sort());

  const invalid = await request(`${base}/api/calendar/work-blocks`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ requestKey: "invalid-cross-day", title: "Too long", startAt: "2026-07-30T23:45:00-07:00", endAt: "2026-07-31T00:15:00-07:00" }),
  });
  assert.equal(invalid.response.status, 400);

  const db = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM calendar_work_blocks").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM calendar_work_block_events").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM calendar_events").get().count, 0);
  assert.ok(db.prepare("SELECT version FROM schema_migrations WHERE version=16").get());
  db.close();
});

test("calendar UI exposes accessible manual planning without implying Outlook writes", async () => {
  const [calendar, styles] = await Promise.all([
    readFile(new URL("../app/calendar-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(calendar, />Add work block</);
  assert.match(calendar, /Standalone block/);
  assert.match(calendar, /Use an Open Work card/);
  assert.match(calendar, /Saved locally in Command Center\. Outlook is not changed\./);
  assert.match(calendar, /aria-label=\{`Edit \$\{block\.title\}`\}/);
  assert.match(calendar, /aria-label=\{`Remove \$\{block\.title\} from the calendar`\}/);
  assert.match(calendar, /Resize \$\{block\.title\}\. Use up and down arrow keys/);
  assert.match(calendar, /calendarUndo[\s\S]*>Undo<\/button>/);
  assert.match(calendar, /method: "DELETE"/);
  assert.match(calendar, /\/restore/);
  assert.doesNotMatch(calendar, /Outlook.*(?:create|write|move).*fetch/i);
  assert.match(styles, /\.manual-work-block-form/);
  assert.match(styles, /\.manual-calendar-block/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.manual-work-block-form \{ grid-template-columns: 1fr/);
});
