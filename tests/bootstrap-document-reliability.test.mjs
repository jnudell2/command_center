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

test("scopes bootstrap work and protects document revisions", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "serent-bootstrap-document-"));
  const port = 46300 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const runner = spawn(process.execPath, [fileURLToPath(new URL("../scripts/local-control-server.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
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
    if (runner.exitCode === null) {
      const exited = once(runner, "exit");
      runner.kill();
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitFor(`${base}/api/health`);

  const request = async (pathname, options = {}) => {
    const response = await fetch(`${base}${pathname}`, options.body === undefined ? options : {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      body: JSON.stringify(options.body),
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* no payload */ }
    return { status: response.status, payload };
  };

  const open = (await request("/api/work-items", { method: "POST", body: { title: "Open scoped fixture", companySlug: "firm", sourceKey: "fixture:scope:open" } })).payload;
  const resolved = (await request("/api/work-items", { method: "POST", body: { title: "Resolved scoped fixture", companySlug: "firm", sourceKey: "fixture:scope:resolved" } })).payload;
  const databasePath = path.join(dataDir, "serent-tend.sqlite");
  const db = new DatabaseSync(databasePath);
  db.prepare("UPDATE work_items SET status='done',resolved_at=?,updated_at=? WHERE id=?").run(new Date().toISOString(), new Date().toISOString(), resolved.id);

  const openBootstrap = await request("/api/bootstrap?workView=open");
  assert.equal(openBootstrap.status, 200);
  assert.equal(openBootstrap.payload.items.some((item) => item.id === open.id), true);
  assert.equal(openBootstrap.payload.items.some((item) => item.id === resolved.id), false);
  const openSummary = openBootstrap.payload.items.find((item) => item.id === open.id);
  assert.equal(openSummary.detailLoaded, false);
  assert.deepEqual(openSummary.events, []);
  assert.deepEqual(openSummary.relationships, []);

  const openDetail = await request(`/api/work-items/${open.id}`);
  assert.equal(openDetail.status, 200);
  assert.equal(openDetail.payload.id, open.id);
  assert.equal(openDetail.payload.detailLoaded, undefined);
  assert.equal(Array.isArray(openDetail.payload.events), true);
  assert.equal(Array.isArray(openDetail.payload.relationships), true);

  const doneBootstrap = await request("/api/bootstrap?workView=done");
  assert.equal(doneBootstrap.status, 200);
  assert.equal(doneBootstrap.payload.items.some((item) => item.id === resolved.id), true);
  assert.equal(doneBootstrap.payload.items.some((item) => item.id === open.id), false);
  assert.equal(doneBootstrap.payload.companyWorkViewCounts.firm.open >= 1, true);
  assert.equal(doneBootstrap.payload.companyWorkViewCounts.firm.done >= 1, true);

  const note = (await request("/api/notes", { method: "POST", body: { title: "Revision fixture", body: "One", type: "project" } })).payload;
  const firstSave = await request(`/api/notes/${note.id}`, {
    method: "PATCH",
    body: { title: note.title, body: "Two", expectedUpdatedAt: note.updatedAt },
  });
  assert.equal(firstSave.status, 200);
  assert.equal(firstSave.payload.body, "Two");

  const staleSave = await request(`/api/notes/${note.id}`, {
    method: "PATCH",
    body: { title: note.title, body: "Stale overwrite", expectedUpdatedAt: note.updatedAt },
  });
  assert.equal(staleSave.status, 409);
  const unchanged = (await request("/api/notes")).payload.find((candidate) => candidate.id === note.id);
  assert.equal(unchanged.body, "Two");
  db.close();
});
