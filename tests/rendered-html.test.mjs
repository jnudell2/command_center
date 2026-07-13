import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the local Serent Command Center shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Serent Command Center<\/title>/i);
  assert.match(html, /Opening your cached work home/i);
  assert.doesNotMatch(html, /Your site is taking shape|Codex is building the first version/i);
});

test("defines the inbox, workbench, notes, and review-only contracts", async () => {
  const [page, runner] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-control-server.mjs", import.meta.url), "utf8"),
  ]);
  for (const label of ["Today", "Calendar", "Mail", "Companies", "Documents", "Codex work", "Search"]) assert.match(page, new RegExp(label, "i"));
  assert.match(page, /Learning &(?:amp;)? sources/i);
  for (const endpoint of ["/api/bootstrap", "/api/work-items", "/api/calendar", "/api/calendar/refresh", "/api/mail", "/api/notes", "/api/agent-runs", "/api/delegation-preview", "/api/source-refresh", "/api/approvals", "/api/feedback-events", "/api/policies", "/api/search"]) assert.match(runner, new RegExp(endpoint.replaceAll("/", "\\/")));
  const calendar = await readFile(new URL("../app/calendar-workspace.tsx", import.meta.url), "utf8");
  for (const label of ["Day ahead", "Meetings", "Work blocks", "Add to plan"]) assert.match(calendar, new RegExp(label, "i"));
  assert.match(calendar, /does not create or move Outlook events/i);
  assert.match(runner, /DatabaseSync/);
  assert.match(runner, /read-only/);
  assert.match(runner, /zoom-transcript-router/);
  assert.match(runner, /draft-executive-email/);
  assert.match(page, /No external action was executed/i);
  assert.match(page, /Ask Codex to edit this document/i);
  assert.match(page, /Done in ClickUp/i);
  assert.match(page, /Return the result to this card/i);
  assert.match(page, /Open a separate Codex task/i);
  for (const label of ["Needs Me", "My Work", "Codex Working", "Waiting", "Done"]) assert.match(page, new RegExp(label, "i"));
  for (const label of ["Working on", "Returns to", "External actions"]) assert.match(page, new RegExp(label, "i"));
  for (const label of ["Draft reply", "Meeting agenda", "Deck outline", "Scheduling note", "Working notes"]) assert.match(page, new RegExp(label, "i"));
  assert.match(page, /It is not a Codex instruction and is not sent anywhere/i);
  for (const label of ["Committed", "Accepted", "Likely owed", "Suggested"]) assert.match(page, new RegExp(label, "i"));
  assert.match(runner, /complete-clickup/);
  assert.match(runner, /codex-task/);
  assert.match(runner, /reconcilePersistentTasks/);
  assert.match(runner, /Relevant transcript summaries/);
  assert.match(runner, /thread\/read/);
  assert.match(runner, /POST http:\/\/127\.0\.0\.1:4318\/api\/notes/);
  assert.match(runner, /event\.id<20/);
  assert.match(runner, /note_edit_proposals/);
  assert.match(runner, /status_repaired/);
});
