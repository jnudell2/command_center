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

  for (const label of ["Current read", "Your next move", "Why now", "Evidence &amp; related work", "Working notes", "Card details", "Activity and technical receipts"]) {
    assert.match(page, new RegExp(label, "i"));
  }
  for (const control of ["Card due date", "Card business status", "Edit waiting dependency", "Add evidence", "Not needed"]) {
    assert.match(page, new RegExp(control, "i"));
  }
  assert.match(page, /<details className="card-section card-history activity-receipts">/);
  assert.doesNotMatch(page, /<details className="card-section optional-workspace" open/);
  assert.match(page, /executiveRead\.evidence\.map/);
  assert.match(page, /selected\.events\.map/);
  assert.match(page, /selected\.assignments\.map/);
  assert.match(page, /nextAction\(item\)/);
  assert.match(page, /showPriority\(item\.priority\)/);
  assert.doesNotMatch(page, /statusMeta\[item\.status\]/);
  assert.doesNotMatch(page, /CardActionComposer|AssignmentReceiptList|CardResultPanel/);
  const cardStart = page.indexOf("const renderCard");
  const cardEnd = page.indexOf('<section className="inbox-view">', cardStart);
  const collapsedCard = page.slice(cardStart, cardEnd);
  assert.match(collapsedCard, /<article className=/);
  assert.match(collapsedCard, /className="issue-completion"/);
  assert.match(collapsedCard, /type="button" aria-label=\{`Mark \$\{item\.title\} done`\}/);
  assert.match(collapsedCard, /event\.stopPropagation\(\); onMarkDone\(item\)/);
  assert.match(collapsedCard, /className="issue-card-open"[\s\S]*onClick=\{\(\) => setSelectedId\(item\.id\)\}/);
  assert.doesNotMatch(collapsedCard, /className="issue-card-open"[^>]*>[\s\S]*<button/);
  assert.match(page, /instruction: "Mark this done"/);
  assert.match(page, /result\.updated\.status !== "done" \|\| !result\.undoToken/);
  assert.match(page, /api\/card-commands\/\$\{encodeURIComponent\(pending\.token\)\}\/undo/);
  assert.match(page, /className="completion-undo" role="status" aria-live="polite"/);
  assert.match(page, />Undo<\/button>/);

  assert.match(workView, /if \(\["done", "dismissed"\]\.includes\(item\.status\)\) return "done";\s*return "open";/s);
  assert.doesNotMatch(workView, /codex_working/);
  for (const typeLabel of ["Draft reply", "Meeting agenda", "Deck outline", "Scheduling note", "Working notes"]) assert.match(cardView, new RegExp(typeLabel, "i"));
  for (const stateLabel of ["Waiting on", "With .* PM", "Ready to review", "Needs attention", "Open"]) assert.match(cardView, new RegExp(stateLabel, "i"));
  assert.match(transcripts, /Meeting follow-through/i);
  assert.match(page, /MEETING TO ACTIONS/i);
  assert.match(page, /I downloaded it — find transcript/i);
  assert.match(runner, /zoom-transcript-router/);
  assert.match(runner, /await launchMeetingProcessing\(workflow, event, sourcePath\)/);
  assert.doesNotMatch(runner, /The transcript was found, but Command Center no longer launches a worker/);
  assert.doesNotMatch(runner, /thread\/resume|thread\/start|turn\/start|app-server|thread\/read/);
  assert.match(editor, /contentType:\s*["']markdown["']/);
  assert.match(editor, /TaskList/);
  assert.match(styles, /html, body \{ max-width: 100%; overflow-x: hidden; \}/);
  assert.match(styles, /@media \(max-width: 1024px\)/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /\.issue-completion:focus-visible/);
  assert.match(styles, /\.completion-undo\s*\{/);
});

test("defines deterministic autonomy, CEO intelligence shadow, and the UI system", async () => {
  const [page, styles, runner, cardView, executiveRead, ceoRead, uiLab, capabilityContract, checkpoint] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-control-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/card-view-model.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/executive-card-read.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/ceo-read.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ui-lab.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/command-center-capability-contract-v2.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/checkpoints/intelligence-autonomy-ui-system-2026-07-21.md", import.meta.url), "utf8"),
  ]);

  for (const capabilityClass of ["Direct user controls", "Deterministic sensing and maintenance", "CEO / PM intelligence", "Gated external actions"]) assert.match(capabilityContract, new RegExp(capabilityClass.replace("/", "\\/"), "i"));
  assert.match(capabilityContract, /Technical completion may add evidence[\s\S]*may not set a work item to Done, Ready to review, Waiting, or Working/i);
  assert.match(checkpoint, /additive schema version 13/i);
  for (const table of ["deterministic_mutations", "work_item_relationships", "intelligence_reviews", "reconciliation_packets"]) assert.match(runner, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  for (const route of ["/api/intelligence/reconciliation", "/api/intelligence/reviews", "/api/reconciliation-packets", "deterministic-mutations"]) assert.match(runner, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(runner, /ensureColumn\("work_items", "waiting_on"/);
  assert.match(runner, /ensureColumn\("work_items", "follow_up_at"/);
  assert.doesNotMatch(cardView, /item\.assignments\?\.some\(\(assignment\) => assignment\.status === "completed"\)/);
  assert.match(cardView, /legacy technical status must be reconciled/i);

  for (const label of ["CURRENT READ", "Your next move", "Owner / dependency", "Done when", "Connected work", "Evidence and freshness", "Last reconciled"]) assert.match(ceoRead, new RegExp(label, "i"));
  assert.match(ceoRead, /if \(!review\) return null/);
  assert.doesNotMatch(page, /<CEORead review=/);
  assert.match(executiveRead, /buildExecutiveCardRead/);
  assert.match(executiveRead, /Card says .*newer evidence proposes/);
  assert.match(page, /className="reconciliation-alert"/);
  assert.match(page, /className="reconciliation-queue"/);
  assert.match(page, /className="insight-indicator"/);
  assert.match(page, /Committed task captured locally\. No agent was involved\./);
  assert.match(page, /api\/work-items\/\$\{encodeURIComponent\(selected\.id\)\}\/mutations/);
  assert.match(page, /api\/deterministic-mutations\/\$\{encodeURIComponent\(pending\.mutationId\)\}\/undo/);
  assert.match(page, /className="deterministic-undo" role="status" aria-live="polite"/);
  assert.match(page, /const selectedPool = view === "inbox" \? filteredItems : items/);
  assert.match(page, /Card owner/);
  assert.match(page, /Card business status/);
  assert.match(page, /waitingFollowUp/);
  assert.match(page, /addEvidenceLink/);
  assert.match(page, /linkCanonicalDuplicate/);

  for (const galleryArea of ["Foundations", "Collapsed commitments", "Direct controls", "Semantic states", "Current read and connected evidence", "System states", "Workspace navigation", "Expanded-card hierarchy"]) assert.match(uiLab, new RegExp(galleryArea, "i"));
  for (const workspace of ["Mail", "Calendar", "Projects", "Documents", "Transcripts", "Notes", "Companies", "Search", "Learning & sources"]) assert.match(uiLab, new RegExp(workspace, "i"));
  assert.match(styles, /--cc-space-1:/);
  assert.match(styles, /--cc-reconcile:/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.issue-completion, \.issue-completion-static \{ height: 40px; width: 40px; \}/);
  assert.match(styles, /\.workspace-switcher > button[\s\S]*min-height: 40px/);
  assert.match(styles, /\.ui-lab\s*\{/);
  assert.match(styles, /\.ceo-read\s*\{/);
  assert.match(styles, /\.decision-header\s*\{/);
  assert.match(styles, /\.reconciliation-alert\s*\{/);
  assert.match(styles, /\.reconciliation-queue\s*\{/);
});
