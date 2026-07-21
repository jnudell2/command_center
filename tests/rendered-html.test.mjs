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
  assert.doesNotMatch(html, /C:\/Users\/JakeNudell/i);
});

test("defines the inbox, project plan, workbench, notes, and review-only contracts", async () => {
  const [page, runner, editor, styles, mailWorkspace, projectWorkspace, pmWorkspace, workViewModel] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-control-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/markdown-editor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/mail-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/project-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/pm-agent-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/work-view.ts", import.meta.url), "utf8"),
  ]);
  for (const label of ["My work", "Projects", "PM agent", "Calendar", "Mail", "Companies", "Documents", "Codex work", "Search"]) assert.match(page, new RegExp(label, "i"));
  assert.match(page, /Learning &(?:amp;)? sources/i);
  for (const endpoint of ["/api/bootstrap", "/api/work-items", "/api/projects", "/api/projects/ingest", "/api/pm-agent", "/api/pm-agent/chat/open", "/api/calendar", "/api/calendar/refresh", "/api/mail", "/api/notes", "/api/agent-runs", "/api/delegation-preview", "/api/source-refresh", "/api/approvals", "/api/feedback-events", "/api/policies", "/api/search"]) assert.match(runner, new RegExp(endpoint.replaceAll("/", "\\/")));
  assert.match(runner, /card-commands/);
  for (const label of ["Your orchestration partner", "Control-plane observer", "Actually running", "Recent Codex radar", "Connections to confirm", "Ready to delegate", "Run PM check", "Open PM conversation in Codex", "Open in Codex"]) assert.match(pmWorkspace, new RegExp(label, "i"));
  for (const contract of ["pm_agent_config", "pm_runs", "pm_thread_observations", "pm_recommendations", "pm_thread_links", "thread/resume", "maybeRunPmAgent"]) assert.match(runner, new RegExp(contract.replaceAll("/", "\\/"), "i"));
  assert.doesNotMatch(runner, /thread\/read/);
  assert.match(styles, /\.pm-workspace\s*\{/);
  assert.match(runner, /project-plan-items/);
  for (const contract of ["project_phases", "project_milestones", "project_plan_items", "project_action_links", "reconcileProject"]) assert.match(runner, new RegExp(contract, "i"));
  for (const label of ["Stay ahead", "Execution guidance", "Do now", "Waiting for", "Up next", "Current phase", "Next decision", "Project health", "Decision roadmap", "Full workplan", "Open action"]) assert.match(projectWorkspace, new RegExp(label, "i"));
  for (const contract of ["depends_on", "execution_mode", "follow_up_days", "projectExecutionGuidance", "upsertSourceProjects"]) assert.match(runner, new RegExp(contract, "i"));
  assert.match(projectWorkspace, /Command Center is the execution source of truth/i);
  assert.match(page, /projectContext/);
  assert.match(styles, /\.project-workspace\s*\{/);
  const calendar = await readFile(new URL("../app/calendar-workspace.tsx", import.meta.url), "utf8");
  for (const label of ["Day ahead", "Meetings", "Work blocks", "Day timeline", "Unscheduled work", "Add to plan", "Drag a card"]) assert.match(calendar, new RegExp(label, "i"));
  assert.match(calendar, /does not create or move Outlook events/i);
  assert.match(calendar, /draggable/);
  assert.match(calendar, /dropOnTimeline/);
  assert.match(calendar, /beginResize/);
  assert.match(calendar, /15 minute increments/i);
  assert.match(runner, /DatabaseSync/);
  assert.match(runner, /read-only/);
  assert.match(runner, /zoom-transcript-router/);
  assert.match(runner, /draft-executive-email/);
  assert.match(runner, /No external action was executed/i);
  assert.match(page, /Ask Codex to edit this document/i);
  assert.match(page, /Done in ClickUp/i);
  assert.match(page, /Change this card or ask Codex to work on it/i);
  assert.match(page, /Smart: update card or open Codex task/i);
  assert.match(page, /Always open a separate Codex task/i);
  assert.match(page, /Card instruction/i);
  assert.match(page, /undoCardCommand/);
  assert.match(page, /work-items\/\$\{encodeURIComponent\(selected\.id\)\}\/command/);
  for (const contract of ["card_commands", "parseCardCommand", "agent_run_reused", "repairMisroutedTranscriptRuns", "repairPreparedCodexTaskStates", "verified native Codex task ID"]) assert.match(runner, new RegExp(contract, "i"));
  for (const label of ["Ready to open in Codex", "No Codex task is running yet", "Prepared only; no task is running", "Accepted by Codex; waiting to start", "verified native task callback"]) assert.match(page, new RegExp(label, "i"));
  assert.match(page, /Always open a separate Codex task/i);
  assert.match(page, /work-items\/\$\{encodeURIComponent\(selected\.id\)\}\/codex-task/);
  assert.doesNotMatch(page, /codex-task-link/);
  assert.doesNotMatch(page, /window\.location\.assign\(launch\.deepLink\)/);
  assert.doesNotMatch(page, /window\.prompt/);
  for (const label of ["Open Work", "Codex Working", "Done"]) assert.match(workViewModel, new RegExp(label, "i"));
  assert.doesNotMatch(workViewModel, /\{ id: "waiting", label: "Waiting" \}/);
  assert.match(workViewModel, /waiting_external[\s\S]*return "open"|return "open"/);
  assert.match(page, /import \{ workViewFor, workViews, type WorkView \} from "\.\/work-view"/);
  assert.match(page, /including work waiting on someone else/i);
  assert.match(page, /waiting_external" \? "feed-state feed-state-waiting"/);
  assert.match(page, /setStatusFilter\(workViewFor\(target\)\)/);
  for (const label of ["Filter by company", "All companies", "Filter by priority", "Filter by source", "Filter by work type"]) assert.match(page, new RegExp(label, "i"));
  for (const label of ["Overdue", "Today", "Tomorrow", "This week", "Later", "No due date"]) assert.match(page, new RegExp(label, "i"));
  assert.match(page, /Everything still outstanding, including work waiting on someone else, ordered by when it needs to happen/i);
  assert.match(page, /dueBucketFor/);
  assert.match(styles, /\.due-group-heading\s*\{/);
  assert.match(styles, /\.due-chip\.due-overdue\s*\{/);
  for (const label of ["Working on", "Returns to", "External actions"]) assert.match(page, new RegExp(label, "i"));
  for (const label of ["Draft reply", "Meeting agenda", "Deck outline", "Scheduling note", "Working notes"]) assert.match(page, new RegExp(label, "i"));
  assert.match(page, /It is not a Codex instruction and is not sent anywhere/i);
  assert.match(page, /Card company assignment/i);
  for (const label of ["Card due date", "Clear due date", "Jake set the due date", "Jake cleared the due date"]) assert.match(page, new RegExp(label, "i"));
  assert.match(page, /dueDateEndOfLocalDayIso/);
  assert.match(styles, /\.due-date-field\s*\{/);
  assert.match(page, /data-company=\{item\.companySlug \|\| "unassigned"\}/);
  assert.match(mailWorkspace, /data-company=\{item\.companySlug \|\| "unassigned"\}/);
  assert.match(projectWorkspace, /data-company=\{project\.companySlug\}/);
  for (const company of ["avionte", "edulog", "govworx", "firm", "stockiq"]) assert.match(styles, new RegExp(`\\[data-company="${company}"\\]`));
  assert.match(styles, /\.company-badge\s*\{/);
  assert.match(styles, /\.feed-card\s*\{[^}]*var\(--company-accent\)/s);
  for (const label of ["Meeting to actions", "I downloaded it", "No transcript was recorded", "Review the follow-ups", "Finish meeting review"]) assert.match(page, new RegExp(label, "i"));
  for (const contract of ["meeting_workflows", "meeting_action_suggestions", "meeting-workflows", "waiting_for_transcript", "candidate_review"]) assert.match(runner, new RegExp(contract.replaceAll("/", "\\/"), "i"));
  assert.match(page, /Nothing is being sent or written to ClickUp/i);
  for (const label of ["Committed", "Accepted", "Likely owed", "Suggested"]) assert.match(page, new RegExp(label, "i"));
  assert.match(runner, /complete-clickup/);
  assert.match(runner, /codex-task/);
  assert.match(runner, /codex-task-link/);
  assert.match(runner, /codex-tasks\/\(\[\^\/\]\+\)\\\/callback|codex-tasks/);
  assert.match(runner, /codex:\/\/threads\/new/);
  assert.match(runner, /explorer\.exe/);
  assert.match(runner, /codex:\/\/threads\/\$\{threadId\}/);
  assert.match(runner, /thread\/name\/set/);
  assert.match(runner, /reconcilePersistentTasks/);
  assert.doesNotMatch(runner, /thread\/read/);
  assert.doesNotMatch(runner, /function launchPersistentCodexTask/);
  assert.match(runner, /codex_task_heartbeat_missed/);
  assert.match(runner, /ownership_released/);
  assert.match(runner, /note_edit_proposals/);
  assert.match(runner, /status_repaired/);
  assert.match(runner, /Request origin is not allowed/);
  assert.match(runner, /verified\?\.verified === true/);
  assert.match(page, /noteSaveVersion/);
  assert.match(page, /selectedMessageId/);
  assert.match(page, /view-\$\{view\}/);
  assert.match(page, /MarkdownEditor/);
  assert.match(editor, /contentType:\s*["']markdown["']/);
  assert.match(editor, /getMarkdown\(\)/);
  assert.match(editor, /raw Markdown/i);
  assert.match(editor, /TaskList/);
  assert.match(styles, /\.app-shell\.view-inbox/);
  assert.match(styles, /\.notes-layout\s*\{[^}]*300px minmax\(0,1fr\)/s);
  assert.match(styles, /\.note-page\s*\{[^}]*max-width:\s*860px/s);
  assert.match(styles, /\.codex-composer\s*\{[^}]*position:\s*sticky/s);
  assert.doesNotMatch(styles, /\.codex-composer\s*\{[^}]*position:\s*fixed/s);
  for (const selector of ["calendar-planner", "day-timeline", "outlook-event-block", "local-work-block", "resize-handle"]) assert.match(styles, new RegExp(`\\.${selector}\\s*\\{`));
  assert.match(styles, /@media \(max-width:\s*1024px\)/);
  assert.match(page, /window\.innerWidth <= 1024/);
  assert.doesNotMatch(page, /window\.innerWidth <= 860/);
  for (const contract of ["Command menu", "Ctrl K", "Workspace / My work", "List", "Board", "issue-row", "issue-board"]) assert.match(page, new RegExp(contract.replaceAll("/", "\\/"), "i"));
  assert.match(styles, /\.command-overlay\s*\{/);
  assert.match(styles, /\.feed-card\.issue-row\s*\{/);
  assert.match(styles, /\.feed-list\.issue-board\s*\{/);
  assert.doesNotMatch(page, /aria-haspopup="menu"/);
  assert.ok(mailWorkspace.indexOf("Recommended next step") < mailWorkspace.indexOf("Proposed reply"));
  assert.ok(mailWorkspace.indexOf("Proposed reply") < mailWorkspace.indexOf("Incoming message"));
});
