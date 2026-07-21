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
  assert.doesNotMatch(html, /C:\/Users\/JakeNudell/i);
});

test("defines the connective-tissue navigation and simplified card contract", async () => {
  const [page, styles, workView, cardView, transcripts, runner, editor] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/work-view.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/card-view-model.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/transcript-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-control-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/markdown-editor.tsx", import.meta.url), "utf8"),
  ]);

  for (const label of ["Open Work", "Mail", "Calendar", "Projects", "Documents", "Transcripts", "Notes", "Search"]) {
    assert.match(page, new RegExp(`\\[\"[^\"]+\", \"${label}\\"\\]`, "i"));
  }
  for (const removed of ["PM agent", "Codex work", "Ask Codex · Return here", "Prepare separate task", "Card instruction"]) {
    assert.doesNotMatch(page, new RegExp(removed, "i"));
  }

  for (const label of ["What needs to happen", "Why it matters", "Current state", "Relevant context", "Working area", "Audit trail and receipts"]) {
    assert.match(page, new RegExp(label, "i"));
  }
  for (const control of ["Done", "Card due date", "Waiting on…", "Ready to review", "Not needed"]) {
    assert.match(page, new RegExp(control, "i"));
  }
  assert.match(page, /<details className="card-section card-history">/);
  assert.doesNotMatch(page, /<details className="card-section card-history" open/);
  assert.match(page, /selected\.sources\.slice\(0, 3\)/);
  assert.match(page, /selected\.events\.map/);
  assert.match(page, /selected\.assignments\.map/);
  assert.match(page, /nextAction\(item\)/);
  assert.match(page, /showPriority\(item\.priority\)/);
  assert.doesNotMatch(page, /statusMeta\[item\.status\]/);
  assert.doesNotMatch(page, /CardActionComposer|AssignmentReceiptList|CardResultPanel/);

  assert.match(workView, /if \(\["done", "dismissed"\]\.includes\(item\.status\)\) return "done";\s*return "open";/s);
  assert.doesNotMatch(workView, /codex_working/);
  for (const typeLabel of ["Draft reply", "Meeting agenda", "Deck outline", "Scheduling note", "Working notes"]) assert.match(cardView, new RegExp(typeLabel, "i"));
  for (const stateLabel of ["Waiting on", "With .* PM", "Ready to review", "Needs attention", "Open"]) assert.match(cardView, new RegExp(stateLabel, "i"));
  assert.match(transcripts, /Meeting follow-through/i);
  assert.match(page, /MEETING TO ACTIONS/i);
  assert.match(page, /I downloaded it — find transcript/i);
  assert.match(runner, /zoom-transcript-router/);
  assert.doesNotMatch(runner, /thread\/resume|thread\/start|turn\/start|app-server|thread\/read/);
  assert.match(editor, /contentType:\s*["']markdown["']/);
  assert.match(editor, /TaskList/);
  assert.match(styles, /html, body \{ max-width: 100%; overflow-x: hidden; \}/);
  assert.match(styles, /@media \(max-width: 1024px\)/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});
