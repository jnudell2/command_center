import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { clearSerentTokenCache, fetchActiveMail, fetchCalendarEvents, fetchMailAttachments, fetchMailBody, htmlToText } from "./graph-mail.mjs";
import { isDirectlyAddressedToJake, isLikelyAutomatedMail, normalizedSubject } from "./mail-triage.mjs";
import { isAllowedTranscriptPath, isEligibleCompletedMeeting, normalizeMeetingAction, safeMeetingName, scoreTranscriptCandidate } from "./meeting-workflow.mjs";
import { buildPmSnapshot, isPmThreadActive } from "./pm-orchestrator.mjs";
import { classifyProjectPlanItem, parseDependencies, projectExecutionGuidance, projectFollowUpBucket } from "./project-execution.mjs";
import { parseCardCommand } from "./card-command.mjs";
import {
  activeAssignmentStates,
  assignmentScopeHash,
  createAssignmentIdentity,
  createCallbackCapability,
  legacyAssignmentState,
  normalizeAssignmentDestination,
  normalizeAssignmentEvent,
  transitionAssignment,
  verifyCallbackCapability,
  workItemStatusForAssignment,
} from "./assignment-lifecycle.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const dataDir = process.env.SERENT_TEND_DATA_DIR || path.join(appRoot, "data");
const databasePath = path.join(dataDir, "serent-tend.sqlite");
const legacyJobsDir = path.join(dataDir, "jobs");
const documentsDir = path.join(dataDir, "workspace");
const aiOsRoot = path.resolve(appRoot, "../../..");
const port = Number(process.env.SERENT_TEND_PORT || 4318);
const host = "127.0.0.1";
const allowedOrigin = "http://localhost:3000";
const activeProcesses = new Map();
let mailRefreshPromise = null;
let calendarRefreshPromise = null;
let pmRunPromise = null;
const localWorkflowsEnabled = process.env.SERENT_TEND_DISABLE_LOCAL_WORKFLOWS !== "1";
const transcriptRoot = path.join(homedir(), "Projects", "ai-operating-system-transcripts");
const transcriptInbox = path.join(transcriptRoot, "inbox");
const downloadsDir = path.join(homedir(), "Downloads");
const transcriptStageScript = path.resolve(appRoot, "../../../06_workflows/scripts/stage_zoom_transcripts_from_downloads.ps1");
const transcriptProcessScript = path.resolve(appRoot, "../../../06_workflows/scripts/process_zoom_transcript_inbox.ps1");

await mkdir(dataDir, { recursive: true });
await mkdir(documentsDir, { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS companies (
    slug TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    ai_os_path TEXT NOT NULL DEFAULT '',
    box_folder TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    company_slug TEXT REFERENCES companies(slug),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    why_now TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    confidence REAL NOT NULL DEFAULT 0.7,
    status TEXT NOT NULL DEFAULT 'to_review',
    suggested_action TEXT NOT NULL DEFAULT '',
    draft TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT 'Jake',
    due_at TEXT,
    source_provider TEXT NOT NULL DEFAULT 'manual',
    source_key TEXT NOT NULL DEFAULT '',
    resolution TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS work_items_source_identity
    ON work_items(source_provider, source_key) WHERE source_key <> ''`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    company_slug TEXT NOT NULL REFERENCES companies(slug),
    title TEXT NOT NULL,
    objective TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    start_date TEXT,
    target_date TEXT,
    source_provider TEXT NOT NULL DEFAULT 'box',
    source_id TEXT NOT NULL DEFAULT '',
    source_label TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    approved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_phases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_milestones (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    scheduled_date TEXT,
    decision TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'upcoming',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_plan_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phase_id TEXT REFERENCES project_phases(id) ON DELETE SET NULL,
    workstream TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_label TEXT NOT NULL DEFAULT 'Jake',
    start_date TEXT,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    suggested_action TEXT NOT NULL DEFAULT '',
    why_now TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    create_action INTEGER NOT NULL DEFAULT 0,
    surface_days INTEGER NOT NULL DEFAULT 21,
    dedupe_terms TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_action_links (
    project_plan_item_id TEXT NOT NULL REFERENCES project_plan_items(id) ON DELETE CASCADE,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'executes',
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_plan_item_id, work_item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS project_plan_due_idx ON project_plan_items(project_id, due_date, status)`,
  `CREATE TABLE IF NOT EXISTS source_references (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    source_id TEXT NOT NULL DEFAULT '',
    source_path TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    retrieved_at TEXT NOT NULL,
    freshness TEXT NOT NULL DEFAULT 'cached'
  )`,
  `CREATE TABLE IF NOT EXISTS work_item_events (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS card_commands (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    instruction TEXT NOT NULL,
    previous_json TEXT NOT NULL,
    next_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied',
    created_at TEXT NOT NULL,
    undone_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'scratch',
    origin TEXT NOT NULL DEFAULT 'manual',
    state TEXT NOT NULL DEFAULT 'active',
    company_slug TEXT REFERENCES companies(slug),
    meeting_id TEXT,
    project_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS note_links (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    PRIMARY KEY(note_id, work_item_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    company_slug TEXT REFERENCES companies(slug),
    scope TEXT NOT NULL,
    intent TEXT NOT NULL,
    title TEXT NOT NULL,
    allowed_sources TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued',
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    revision_of TEXT,
    input_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    action_type TEXT NOT NULL,
    destination TEXT NOT NULL DEFAULT '',
    payload_summary TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'approved_locally',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_receipts (
    source TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS policy_suggestions (
    id TEXT PRIMARY KEY,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    proposed_rule TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mail_messages (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL DEFAULT '',
    internet_message_id TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT '',
    sender_email TEXT NOT NULL DEFAULT '',
    recipients_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    received_at TEXT NOT NULL,
    preview TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    body_cached_at TEXT,
    web_link TEXT NOT NULL DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    importance TEXT NOT NULL DEFAULT 'normal',
    company_slug TEXT REFERENCES companies(slug),
    reply_state TEXT NOT NULL DEFAULT 'informational',
    reply_override TEXT NOT NULL DEFAULT '',
    reply_confidence REAL NOT NULL DEFAULT 0.5,
    reply_reason TEXT NOT NULL DEFAULT '',
    review_state TEXT NOT NULL DEFAULT 'unreviewed',
    snoozed_until TEXT,
    draft_state TEXT NOT NULL DEFAULT 'none',
    action_work_item_id TEXT,
    freshness TEXT NOT NULL DEFAULT 'cached',
    last_synced_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS mail_received_idx ON mail_messages(received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS mail_reply_idx ON mail_messages(reply_state, received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL DEFAULT '',
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    is_all_day INTEGER NOT NULL DEFAULT 0,
    organizer_name TEXT NOT NULL DEFAULT '',
    organizer_email TEXT NOT NULL DEFAULT '',
    attendees_json TEXT NOT NULL DEFAULT '[]',
    location TEXT NOT NULL DEFAULT '',
    web_link TEXT NOT NULL DEFAULT '',
    freshness TEXT NOT NULL DEFAULT 'cached',
    last_synced_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS calendar_start_idx ON calendar_events(start_at ASC)`,
  `CREATE TABLE IF NOT EXISTS meeting_workflows (
    id TEXT PRIMARY KEY,
    calendar_event_id TEXT NOT NULL UNIQUE REFERENCES calendar_events(id) ON DELETE CASCADE,
    work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'waiting_for_transcript',
    candidate_path TEXT NOT NULL DEFAULT '',
    transcript_path TEXT NOT NULL DEFAULT '',
    note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
    agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meeting_action_suggestions (
    id TEXT PRIMARY KEY,
    meeting_workflow_id TEXT NOT NULL REFERENCES meeting_workflows(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    company_slug TEXT REFERENCES companies(slug),
    type TEXT NOT NULL DEFAULT 'follow_up',
    priority TEXT NOT NULL DEFAULT 'normal',
    owner_state TEXT NOT NULL DEFAULT 'jake',
    suggested_action TEXT NOT NULL DEFAULT '',
    evidence_timestamp TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    existing_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    decision TEXT NOT NULL DEFAULT 'proposed',
    created_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mail_drafts (
    id TEXT PRIMARY KEY,
    mail_message_id TEXT NOT NULL UNIQUE REFERENCES mail_messages(id) ON DELETE CASCADE,
    generated_body TEXT NOT NULL DEFAULT '',
    current_body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    origin_mode TEXT NOT NULL DEFAULT 'manual',
    skill_id TEXT NOT NULL DEFAULT 'draft-executive-email',
    source_basis TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mail_draft_revisions (
    id TEXT PRIMARY KEY,
    mail_draft_id TEXT NOT NULL REFERENCES mail_drafts(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mail_note_links (
    mail_message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    PRIMARY KEY(mail_message_id, note_id)
  )`,
  `CREATE TABLE IF NOT EXISTS feedback_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    work_item_id TEXT,
    mail_message_id TEXT,
    company_slug TEXT,
    skill_id TEXT,
    detail TEXT NOT NULL DEFAULT '',
    before_value TEXT NOT NULL DEFAULT '',
    after_value TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS preference_rules (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    instruction TEXT NOT NULL,
    scope_type TEXT NOT NULL DEFAULT 'global',
    scope_value TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'routing',
    status TEXT NOT NULL DEFAULT 'proposed',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS skill_routes (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    description TEXT NOT NULL,
    executor_type TEXT NOT NULL,
    work_types TEXT NOT NULL DEFAULT '[]',
    expected_output TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS note_revisions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'manual',
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS note_edit_proposals (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    instruction TEXT NOT NULL,
    proposed_title TEXT NOT NULL DEFAULT '',
    proposed_body TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'working',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS external_actions (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    receipt TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS codex_tasks (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    instruction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    assignment_key TEXT NOT NULL UNIQUE,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    destination TEXT NOT NULL CHECK(destination IN ('card','separate_task')),
    title TEXT NOT NULL,
    instruction TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    attempt INTEGER NOT NULL DEFAULT 1,
    prior_work_item_status TEXT NOT NULL DEFAULT 'to_review',
    owner_type TEXT NOT NULL DEFAULT 'native_codex',
    owner_id TEXT NOT NULL DEFAULT '',
    callback_capability_hash TEXT NOT NULL,
    capability_generation INTEGER NOT NULL DEFAULT 1,
    allowed_sources TEXT NOT NULL DEFAULT '[]',
    context_manifest TEXT NOT NULL DEFAULT '{}',
    external_action_boundary TEXT NOT NULL DEFAULT 'No external writes without Jake''s separate approval.',
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    revision_of TEXT REFERENCES assignments(id) ON DELETE SET NULL,
    accepted_at TEXT,
    started_at TEXT,
    heartbeat_at TEXT,
    needs_input_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    released_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assignment_events (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL DEFAULT 1,
    event_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    owner_id TEXT NOT NULL DEFAULT '',
    occurred_at TEXT,
    received_at TEXT NOT NULL,
    previous_status TEXT NOT NULL,
    next_status TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    applied INTEGER NOT NULL DEFAULT 1,
    rejection_reason TEXT NOT NULL DEFAULT '',
    UNIQUE(assignment_id, attempt, event_key)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS assignments_active_work_item_idx
    ON assignments(work_item_id)
    WHERE status IN ('prepared','accepted','working','needs_input','needs_attention')`,
  `CREATE INDEX IF NOT EXISTS assignments_work_item_updated_idx ON assignments(work_item_id,updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS assignment_events_assignment_idx ON assignment_events(assignment_id,received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS pm_agent_config (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'observer',
    enabled INTEGER NOT NULL DEFAULT 1,
    morning_time TEXT NOT NULL DEFAULT '08:00',
    pulse_minutes INTEGER NOT NULL DEFAULT 30,
    max_concurrent INTEGER NOT NULL DEFAULT 2,
    last_run_at TEXT,
    last_morning_date TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pm_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'working',
    summary TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    thread_count INTEGER NOT NULL DEFAULT 0,
    recommendation_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS pm_thread_observations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES pm_runs(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    preview TEXT NOT NULL DEFAULT '',
    thread_status TEXT NOT NULL DEFAULT 'unknown',
    company_slug TEXT REFERENCES companies(slug),
    linked_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    linked_work_item_title TEXT NOT NULL DEFAULT '',
    match_type TEXT NOT NULL DEFAULT 'unmatched',
    confidence REAL NOT NULL DEFAULT 0,
    rationale TEXT NOT NULL DEFAULT '',
    thread_updated_at TEXT,
    cwd TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pm_recommendations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES pm_runs(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    work_item_title TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    thread_title TEXT NOT NULL DEFAULT '',
    company_slug TEXT REFERENCES companies(slug),
    rationale TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'proposed',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pm_thread_links (
    thread_id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];
for (const statement of schemaStatements) db.prepare(statement).run();

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("agent_runs", "skill_id", "TEXT NOT NULL DEFAULT 'generic-codex'");
ensureColumn("agent_runs", "executor_type", "TEXT NOT NULL DEFAULT 'codex_readonly'");
ensureColumn("agent_runs", "context_manifest", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("agent_runs", "mail_message_id", "TEXT");
ensureColumn("agent_runs", "waiting_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("notes", "file_path", "TEXT NOT NULL DEFAULT ''");
ensureColumn("work_items", "decision_state", "TEXT NOT NULL DEFAULT 'proposed'");
ensureColumn("work_items", "planned_at", "TEXT");
ensureColumn("work_items", "planned_minutes", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("work_items", "preparation_mode", "TEXT NOT NULL DEFAULT 'manual'");
ensureColumn("work_items", "preparation_skill", "TEXT NOT NULL DEFAULT ''");
ensureColumn("work_items", "preparation_instruction", "TEXT NOT NULL DEFAULT ''");
ensureColumn("codex_tasks", "last_checked_at", "TEXT");
ensureColumn("codex_tasks", "resume_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("codex_tasks", "heartbeat_at", "TEXT");
ensureColumn("pm_agent_config", "chat_thread_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("pm_agent_config", "chat_status", "TEXT NOT NULL DEFAULT 'not_created'");
ensureColumn("pm_agent_config", "chat_updated_at", "TEXT");
ensureColumn("pm_agent_config", "chat_error", "TEXT NOT NULL DEFAULT ''");
ensureColumn("mail_messages", "reply_override", "TEXT NOT NULL DEFAULT ''");
ensureColumn("mail_drafts", "origin_mode", "TEXT NOT NULL DEFAULT 'manual'");
ensureColumn("project_plan_items", "depends_on", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("project_plan_items", "execution_mode", "TEXT NOT NULL DEFAULT 'auto'");
ensureColumn("project_plan_items", "follow_up_days", "INTEGER NOT NULL DEFAULT 3");
db.prepare("UPDATE work_items SET decision_state='committed' WHERE source_provider='clickup' AND decision_state='proposed'").run();
db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,datetime('now'))").run();
db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(4,datetime('now'))").run();
db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(5,datetime('now'))").run();
db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(6,datetime('now'))").run();
db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(7,datetime('now'))").run();
db.prepare(`INSERT OR IGNORE INTO pm_agent_config(id,mode,enabled,morning_time,pulse_minutes,max_concurrent,created_at,updated_at)
  VALUES('default','observer',1,'08:00',30,2,datetime('now'),datetime('now'))`).run();
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=8").get()) {
  db.prepare("UPDATE pm_agent_config SET mode='autonomous_prep',updated_at=datetime('now') WHERE id='default'").run();
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(8,datetime('now'))").run();
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=9").get()) {
  db.prepare(`UPDATE work_items SET preparation_mode='auto',preparation_skill='draft-executive-email',
    preparation_instruction='Draft a concise deal-team update summarizing the completed kickoff deck, confirmed kickoff timing, and immediate next steps. Draft only; do not send.',updated_at=datetime('now')
    WHERE company_slug='govworx' AND title='Send the GovWorX kickoff update to the deal team' AND preparation_mode='manual'`).run();
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(9,datetime('now'))").run();
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=10").get()) {
  db.prepare(`UPDATE work_items SET preparation_mode='auto',preparation_skill='draft-executive-email',
    preparation_instruction='Draft a concise deal-team update summarizing the completed kickoff deck, confirmed kickoff timing, and immediate next steps. Draft only; do not send.',updated_at=datetime('now')
    WHERE company_slug='govworx' AND lower(title)=lower('Send the GovWorx kickoff update to the deal team') AND preparation_mode='manual'`).run();
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(10,datetime('now'))").run();
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=11").get()) {
  db.prepare("UPDATE pm_agent_config SET mode='observer',updated_at=datetime('now') WHERE id='default'").run();
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(11,datetime('now'))").run();
}

const nowIso = () => new Date().toISOString();
const localDateKey = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

function defaultPreparationPolicy({ type = "", title = "", suggestedAction = "", preparationMode, preparationSkill, preparationInstruction } = {}) {
  const normalizedType = String(type).trim().toLowerCase();
  const explicitMode = ["manual", "auto", "none"].includes(preparationMode) ? preparationMode : "";
  const autoTypes = new Set(["artifact", "analysis", "deck", "email", "outreach", "meeting_prep", "agenda", "memo", "draft"]);
  const mode = explicitMode || (autoTypes.has(normalizedType) ? "auto" : "manual");
  const skill = String(preparationSkill || (/[\s_-]*(email|outreach|reply)/i.test(normalizedType) ? "draft-executive-email" : "")).trim().slice(0, 120);
  const fallback = String(suggestedAction || title || "Prepare this deliverable for Jake to review.").trim();
  const instruction = String(preparationInstruction || (mode === "auto" ? `${fallback}\n\nPrepare the deliverable only. Do not send messages or write to shared systems.` : "")).trim().slice(0, 4000);
  return { mode, skill, instruction };
}

function seedDatabase() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM companies").get().count;
  if (count > 0) return;
  const now = nowIso();
  const companies = [
    ["avionte", "Avionté", "Packaging, monetization, and implementation work", "05_projects/avionte.md", "Growth Team / 32. Pricing / 00 Projects"],
    ["stockiq", "StockIQ", "Packaging, ROI, and product marketing VCI", "05_projects/stockiq-2026.md", "Growth Team / 32. Pricing / 00 Projects"],
    ["govworx", "GovWorx", "Pricing scope and workplan development", "05_projects/govworx-2026.md", "Growth Team / 32. Pricing / 00 Projects"],
    ["firm", "Serent / Firm", "Internal Pricing CoE and portfolio-wide work", "02_work_context/role_and_context.md", "Growth Team / 32. Pricing"],
  ];
  const insertCompany = db.prepare(`INSERT INTO companies
    (slug, display_name, description, ai_os_path, box_folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const company of companies) insertCompany.run(...company, now, now);

  const items = [
    {
      id: "avionte-cm",
      type: "decision",
      company: "avionte",
      title: "CM proposal needs the final decision set",
      summary: "Scope and implementation treatment are ready for a focused decision pass.",
      why: "This is the clearest immediate commitment and is blocking the next proposal step.",
      priority: "high",
      confidence: 0.92,
      action: "Review the remaining scope choices and implementation treatment.",
      provider: "clickup",
      key: "avionte-cm-proposal",
      due: now,
      sourceLabel: "ClickUp + Avionté project context",
    },
    {
      id: "stockiq-transcript",
      type: "meeting",
      company: "stockiq",
      title: "Kickoff follow-through is waiting on the transcript",
      summary: "The meeting finished, but the transcript has not reached the routed project repository.",
      why: "Decisions and follow-ups cannot be reconciled until the transcript is downloaded.",
      priority: "high",
      confidence: 0.88,
      action: "Download the Zoom transcript, then extract decisions and follow-through.",
      provider: "transcripts",
      key: "stockiq-kickoff-transcript",
      due: now,
      sourceLabel: "Calendar + transcript router",
    },
    {
      id: "firm-vci",
      type: "email",
      company: "firm",
      title: "VCI tracker refresh likely needs a reply",
      summary: "A refresh was requested and the cached mail comparison did not show a matching response.",
      why: "The requested timing is today or tomorrow.",
      priority: "normal",
      confidence: 0.78,
      action: "Confirm timing and prepare the refresh before the GP update.",
      provider: "outlook",
      key: "firm-vci-tracker-refresh",
      due: null,
      sourceLabel: "Outlook Inbox + Sent Items",
    },
    {
      id: "govworx-scope",
      type: "artifact",
      company: "govworx",
      title: "Scope and workplan synthesis is ready to begin",
      summary: "Source materials are available and no analysis is currently running.",
      why: "A compact scope will convert received materials into an executable engagement plan.",
      priority: "normal",
      confidence: 0.84,
      action: "Queue a source-backed scope and workplan synthesis.",
      provider: "box",
      key: "govworx-scope-materials",
      due: null,
      sourceLabel: "Box + GovWorx project context",
    },
  ];
  const insertItem = db.prepare(`INSERT INTO work_items
    (id, type, company_slug, title, summary, why_now, priority, confidence, status,
     suggested_action, due_at, source_provider, source_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'to_review', ?, ?, ?, ?, ?, ?)`);
  const insertSource = db.prepare(`INSERT INTO source_references
    (id, work_item_id, provider, label, source_id, source_path, source_url, retrieved_at, freshness)
    VALUES (?, ?, ?, ?, '', '', '', ?, 'cached')`);
  const insertEvent = db.prepare(`INSERT INTO work_item_events
    (id, work_item_id, event_type, detail, created_at) VALUES (?, ?, 'created', ?, ?)`);
  for (const item of items) {
    insertItem.run(item.id, item.type, item.company, item.title, item.summary, item.why, item.priority, item.confidence, item.action, item.due, item.provider, item.key, now, now);
    insertSource.run(randomUUID(), item.id, item.provider, item.sourceLabel, now);
    insertEvent.run(randomUUID(), item.id, "Seeded from the validated Serent command-center context.", now);
  }
  db.prepare("UPDATE work_items SET decision_state='committed' WHERE source_provider='clickup'").run();
  for (const source of ["outlook", "calendar", "clickup", "transcripts", "box"]) {
    db.prepare(`INSERT INTO source_receipts(source, status, checked_at, detail)
      VALUES (?, 'cached', ?, 'Cached snapshot available; refresh independently.')`).run(source, now);
  }
}

function seedProjectPlans() {
  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO projects
    (id,company_slug,title,objective,status,start_date,target_date,source_provider,source_id,source_label,source_url,approved_at,created_at,updated_at)
    VALUES('stockiq-2026-vci','stockiq','StockIQ 2026 Pricing, Packaging, and Product Marketing VCI',
    'Improve new-logo conversion and value capture while defining the monetization path for Edison, API/MCP, and StockIQ 2.0.',
    'active','2026-07-06','2026-09-21','box','2316599730929','StockIQ_2026_P&P_VCI_Kickoff.pptx',
    'https://app.box.com/file/2316599730929',?,?,?)`).run(now, now, now);

  const phases = [
    ['stockiq-phase-1','Phase 1 · Internal information gathering','Build the fact base, identify buyer friction, and define viable pricing and packaging concepts.','2026-07-06','2026-08-02','active',1],
    ['stockiq-phase-2','Phase 2 · Market research','Test pricing and packaging concepts with the market and synthesize willingness-to-pay and usability evidence.','2026-08-03','2026-09-06','planned',2],
    ['stockiq-phase-3','Phase 3 · Recommendation and implementation','Align on the recommendation, define the pilot, and prepare rollout and enablement.','2026-09-07','2026-09-21','planned',3],
  ];
  const insertPhase = db.prepare(`INSERT OR IGNORE INTO project_phases
    (id,project_id,title,summary,start_date,end_date,status,sort_order,created_at,updated_at)
    VALUES(?,'stockiq-2026-vci',?,?,?,?,?,?,?,?)`);
  for (const phase of phases) insertPhase.run(...phase, now, now);

  const milestones = [
    ['stockiq-kickoff','Kickoff','2026-07-06','Confirm the workplan and scope.','complete',1],
    ['stockiq-steerco-1','SteerCo 1','2026-08-03','Align on the concepts to test in research.','upcoming',2],
    ['stockiq-steerco-2','SteerCo 2','2026-09-07','Align on the recommended pricing and packaging direction.','upcoming',3],
    ['stockiq-steerco-3','SteerCo 3','2026-09-21','Align on the pilot and rollout plan.','upcoming',4],
  ];
  const insertMilestone = db.prepare(`INSERT OR IGNORE INTO project_milestones
    (id,project_id,title,scheduled_date,decision,status,sort_order,created_at,updated_at)
    VALUES(?,'stockiq-2026-vci',?,?,?,?,?,?,?)`);
  for (const milestone of milestones) insertMilestone.run(...milestone, now, now);

  const items = [
    ['stockiq-inputs','stockiq-phase-1','Project kickoff and fact base','Get the outstanding StockIQ data, product demo, credentials, and source access','The initial data request, demo, and access package were expected after kickoff.','StockIQ team','2026-07-06','2026-07-10','blocked','Follow up with Kyle on the missing data request, demo, and required access.','The planned inputs are overdue and block the internal analyses.','high',1,30,['kyle','data request','credential','product demo'],1],
    ['stockiq-interviews','stockiq-phase-1','Project kickoff and fact base','Schedule internal interviews','Schedule sales, customer success, product, engineering, finance, RevOps, and API/MCP interviews.','Jake + StockIQ team','2026-07-13','2026-07-17','active','Identify the interview owners and put the first working sessions on the calendar.','The kickoff workplan calls for interviews during the current fact-base phase.','high',1,21,['internal interview','working session'],2],
    ['stockiq-steerco-schedule','stockiq-phase-1','Project governance','Schedule SteerCo 1','Confirm the SteerCo 1 date, audience, and decisions required.','Jake + Kavya','2026-07-13','2026-07-24','active','Coordinate a SteerCo 1 meeting for the week of August 3.','The next decision milestone needs a confirmed audience and calendar date.','high',1,21,['steerco 1','steerco #1'],3],
    ['stockiq-data-review','stockiq-phase-1','Project kickoff and fact base','Review customer, pricing, funnel, and usage data','Build the customer, pricing, funnel, and product-usage fact base once the requested inputs arrive.','Jake','2026-07-13','2026-07-24','blocked','Begin the fact-base review as each usable data source arrives.','The analysis cannot be completed until StockIQ provides the planned inputs.','normal',0,21,['customer data','funnel data','usage data'],4],
    ['stockiq-analysis-setup','stockiq-phase-1','Project kickoff and fact base','Prepare the StockIQ analysis workspace','Set up the input checklist, file map, validation checks, and analysis templates so each source can be processed as soon as it arrives.','Jake + Codex','2026-07-14','2026-07-17','active','Create the data-receipt checklist and the sales-friction, outcomes, and product-usage analysis templates.','This work can begin before the remaining StockIQ data arrives and shortens the path from receipt to analysis.','high',1,21,['analysis workspace','data receipt checklist','analysis template'],5],
    ['stockiq-competitive-proof','stockiq-phase-1','Outcomes pricing and value proof','Reconcile Atomic and Netstock pricing evidence','Resolve the inconsistent Atomic pricing ranges and obtain written support for the current Netstock quote.','Jake + Codex','2026-07-14','2026-07-17','active','Reconcile the Atomic evidence and secure a source-backed Netstock pricing reference.','The competitive evidence can advance now and is needed for the SteerCo 1 concept story.','high',1,21,['atomic pricing','netstock quote','competitive evidence'],6],
    ['stockiq-product-benchmark','stockiq-phase-1','Product monetization and package concepting','Benchmark StockIQ execution and entitlements','Benchmark scenario speed, data cadence, integration and write-back, Edison jobs, and StockIQ 2.0 entitlements.','Jake + Codex','2026-07-14','2026-07-20','active','Build a source-backed benchmark of the capabilities and entitlement boundaries that matter for packaging.','Product monetization concepts need a clear fact base before SteerCo 1.','high',1,21,['scenario speed','data cadence','write-back','2.0 entitlements'],7],
    ['stockiq-friction','stockiq-phase-1','Outcomes pricing and value proof','Assess sales friction and no-decision drivers','Analyze closed-lost reasons, funnel stalls, objections, discounts, and exceptions.','Jake','2026-07-20','2026-07-31','planned','Prepare the sales-friction analysis needed to define concepts for SteerCo 1.','SteerCo 1 must decide which concepts are credible enough to test.','normal',1,14,['sales friction','no-decision','closed-lost'],5],
    ['stockiq-outcomes','stockiq-phase-1','Outcomes pricing and value proof','Identify outcome metrics and ROI proof points','Evaluate measurable customer outcomes and score them for materiality, attribution, auditability, and buyer trust.','Jake','2026-07-20','2026-07-31','planned','Build an outcome-metric feasibility scorecard and select the strongest ROI proof points.','Outcome-linked pricing should not advance without measurable and defensible outcomes.','normal',0,14,['outcome metric','roi proof'],6],
    ['stockiq-monetization','stockiq-phase-1','Product monetization and package concepting','Review Edison, API/MCP readiness, and cost drivers','Understand target users, access patterns, beta usage, support requirements, and cost drivers.','Jake + StockIQ team','2026-07-20','2026-07-31','planned','Collect and synthesize the product evidence needed for Edison and API/MCP monetization.','The next milestone needs concepts that are commercially and operationally feasible.','normal',0,14,['edison','api/mcp','mcp access'],7],
    ['stockiq-steerco-story','stockiq-phase-1','Product monetization and package concepting','Build the SteerCo 1 concept story','Turn the competitive evidence and internal fact base into clear concepts to test.','Jake + Codex','2026-07-20','2026-07-31','active','Develop the SteerCo 1 storyline, decision slides, and concepts to take into research.','SteerCo 1 is the next major decision gate in the approved workplan.','high',1,21,['steerco 1 story','competitive perspective','concepts to test'],8],
    ['stockiq-research-design','stockiq-phase-2','Market validation and concept testing','Finalize the market-validation design','Align the research objectives, audience, method, and final pricing and packaging concepts.','Jake + SteerCo','2026-08-03','2026-08-10','planned','Convert the SteerCo 1 decisions into a fieldable research design.','This begins after SteerCo 1 approves the concepts to test.','normal',1,14,['market validation','research design'],9],
    ['stockiq-field-research','stockiq-phase-2','Market validation and concept testing','Field market-validation research','Test the approved concepts and capture willingness-to-pay, preference, and sales-usability evidence.','Jake + research team','2026-08-10','2026-08-31','planned','Launch and manage the approved market-validation research.','This is the primary evidence source for the recommended direction.','normal',0,14,['field research','willingness to pay'],10],
    ['stockiq-recommendation','stockiq-phase-3','Initial answer, pilot design, and rollout','Align on the initial pricing and packaging direction','Synthesize the evidence into a recommended pricing, packaging, and monetization direction.','Jake + SteerCo','2026-08-31','2026-09-07','planned','Prepare the SteerCo 2 recommendation and decision materials.','SteerCo 2 is the recommendation decision gate.','high',1,14,['steerco 2','pricing direction','packaging direction'],11],
    ['stockiq-pilot','stockiq-phase-3','Initial answer, pilot design, and rollout','Define the pilot and rollout plan','Define eligibility, guardrails, success metrics, enablement, and rollout implications.','Jake + StockIQ team','2026-09-07','2026-09-21','planned','Prepare the pilot design, rollout plan, and final recommendation for SteerCo 3.','The final milestone requires an executable implementation path.','normal',1,14,['pilot design','rollout plan','steerco 3'],12],
  ];
  const insertItem = db.prepare(`INSERT OR IGNORE INTO project_plan_items
    (id,project_id,phase_id,workstream,title,description,owner_label,start_date,due_date,status,suggested_action,why_now,priority,create_action,surface_days,dedupe_terms,sort_order,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const item of items) {
    const values = [...item];
    values[14] = JSON.stringify(values[14]);
    insertItem.run(values[0], 'stockiq-2026-vci', ...values.slice(1), now, now);
  }
  db.prepare(`UPDATE project_plan_items SET description=?,suggested_action=?,why_now=?,execution_mode='auto',updated_at=? WHERE id='stockiq-inputs'`).run(
    "Obtain and verify the CRM funnel export, Attention recordings, customer census and billing data, SKU and price book, Planhat or usage export, Edison/API/MCP/2.0 materials, customer outcome data, and Hugo competitive archive.",
    "Check the complete data-request checklist, identify what is still missing, and follow up with Kyle and Mark on the gaps.",
    "The input package is overdue and blocks the customer, sales-friction, outcomes, usage, and monetization analyses.",now,
  );
  const stockiqSortOrder = ["stockiq-inputs","stockiq-analysis-setup","stockiq-interviews","stockiq-steerco-schedule","stockiq-data-review","stockiq-competitive-proof","stockiq-product-benchmark","stockiq-friction","stockiq-outcomes","stockiq-monetization","stockiq-steerco-story","stockiq-research-design","stockiq-field-research","stockiq-recommendation","stockiq-pilot"];
  for (const [index,id] of stockiqSortOrder.entries()) db.prepare("UPDATE project_plan_items SET sort_order=? WHERE id=?").run(index+1,id);
  const stockiqDependencies = {
    "stockiq-data-review": ["stockiq-inputs"],
    "stockiq-friction": ["stockiq-data-review"],
    "stockiq-outcomes": ["stockiq-data-review"],
    "stockiq-monetization": ["stockiq-inputs"],
    "stockiq-research-design": ["stockiq-steerco-story"],
    "stockiq-field-research": ["stockiq-research-design"],
    "stockiq-recommendation": ["stockiq-field-research"],
    "stockiq-pilot": ["stockiq-recommendation"],
  };
  for (const [id, dependencies] of Object.entries(stockiqDependencies)) {
    db.prepare("UPDATE project_plan_items SET depends_on=?,execution_mode='auto' WHERE id=?").run(JSON.stringify(dependencies),id);
  }

  db.prepare(`INSERT OR IGNORE INTO projects
    (id,company_slug,title,objective,status,start_date,target_date,source_provider,source_id,source_label,source_url,approved_at,created_at,updated_at)
    VALUES('govworx-2026-vci','govworx','GovWorx 2026 Pricing and Packaging VCI',
    'Create a future-state packaging architecture, pricing metric and tier recommendations, and a practical implementation roadmap for GovWorx.',
    'active','2026-07-13','2026-09-18','box','2345257521399','GovWorx_2026_Pricing_Packaging_VCI_Kickoff_v3.pptx',
    'https://app.box.com/file/2345257521399',?,?,?)`).run(now,now,now);

  const govworxPhases = [
    ['govworx-phase-a','A · Build the fact base and diagnose the current state','Align the decisions and data needs, collect the evidence, interview the team, and diagnose the current commercial architecture.','2026-07-13','2026-08-09','active',1],
    ['govworx-phase-b','B · Develop and align on future-state options','Set design principles and compare packaging architectures, upgrade paths, pricing metrics, tiers, and bands.','2026-07-27','2026-08-09','planned',2],
    ['govworx-phase-c','C · Validate and refine the preferred direction','Validate the preferred direction with targeted customers and prospects, then pressure-test the implications.','2026-08-10','2026-09-06','planned',3],
    ['govworx-phase-d','D · Finalize recommendation and implementation priorities','Finalize the architecture, metrics, tiers, upgrade paths, migration priorities, and enablement plan.','2026-09-07','2026-09-18','planned',4],
  ];
  const insertGovworxPhase = db.prepare(`INSERT OR IGNORE INTO project_phases
    (id,project_id,title,summary,start_date,end_date,status,sort_order,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (const phase of govworxPhases) insertGovworxPhase.run(phase[0],'govworx-2026-vci',...phase.slice(1),now,now);

  const govworxMilestones = [
    ['govworx-kickoff','govworx-2026-vci','Kickoff','2026-07-17','Confirm the scope, decisions, and data needs.','upcoming',1],
    ['govworx-steerco-1','govworx-2026-vci','SteerCo 1','2026-08-10','Choose the preferred direction and validation scope.','upcoming',2],
    ['govworx-steerco-2','govworx-2026-vci','SteerCo 2','2026-09-14','Align on the final recommendation and implementation priorities.','upcoming',3],
  ];
  const insertGovworxMilestone = db.prepare(`INSERT OR IGNORE INTO project_milestones
    (id,project_id,title,scheduled_date,decision,status,sort_order,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const milestone of govworxMilestones) insertGovworxMilestone.run(...milestone,now,now);

  const govworxItems = [
    ['govworx-kickoff-deck','govworx-2026-vci','govworx-phase-a','Project kickoff','Finalize the kickoff plan and deck','Review the v3 kickoff deck, confirm the final scope, decision owner, data owner, attendees, and timeline-driving milestone.','Jake','2026-07-13','2026-07-17','active','Review the v3 plan with the final attendee names, owners, scope, and timeline before kickoff.','The kickoff decision gate is this week and establishes the operating baseline for the VCI.','high',1,21,['kickoff deck','kickoff plan'],1],
    ['govworx-kickoff-meeting','govworx-2026-vci','govworx-phase-a','Project kickoff','Schedule and hold the GovWorx kickoff','Coordinate the kickoff with Kevin, Scott, Kavya, and the required working-team leaders.','Jake + GovWorx','2026-07-13','2026-07-17','active','Reply to Kevin with the kickoff timing once the deck is ready, then schedule the meeting.','The workplan begins with a kickoff decision gate during the current week.','high',1,21,['kickoff meeting','schedule a govworx kickoff','schedule govworx kickoff'],2],
    ['govworx-product-demo','govworx-2026-vci','govworx-phase-a','Build the fact base and diagnose the current state','Obtain the GovWorx product demo','Receive a live product demo or an existing recording covering the current and upcoming product set.','GovWorx','2026-07-13','2026-07-17','active','Ask Kevin to provide or schedule the product demo before the fact-base analysis begins.','The product map and future-state architecture depend on understanding the actual workflows and dependencies.','normal',1,21,['product demo','demo recording'],3],
    ['govworx-interview-roster','govworx-2026-vci','govworx-phase-a','Build the fact base and diagnose the current state','Confirm the working team and interview roster','Confirm the product and sales leads plus the names and availability of the leaders to interview.','GovWorx','2026-07-13','2026-07-17','active','Get the interview roster and availability from Kevin and schedule the first sessions.','The deck still contains placeholders for the product and sales leads.','high',1,21,['leaders to interview','interview roster','product lead','sales lead'],4],
    ['govworx-data-request','govworx-2026-vci','govworx-phase-a','Build the fact base and diagnose the current state','Collect the initial GovWorx data request','Collect customer ARR, packages, contracted pricing, volume, deals, usage, contracts, quotes, cost-to-serve, outcomes, and competitive evidence.','GovWorx','2026-07-20','2026-07-24','planned','Send or confirm the data request with Kevin and track unavailable inputs explicitly.','The fact base and pricing architecture cannot be completed without customer-level commercial and usage evidence.','high',1,21,['requested data','data request','customer-level arr','pricing support'],5],
    ['govworx-interviews','govworx-2026-vci','govworx-phase-a','Build the fact base and diagnose the current state','Conduct management interviews','Assess sales, quoting, product, implementation, and expansion workflows with the working team.','Jake','2026-07-20','2026-07-31','planned','Conduct the prioritized interviews and capture decisions, friction points, and source gaps.','Interview evidence is needed before setting the future-state design principles.','normal',1,14,['management interview','working team interview'],6],
    ['govworx-current-map','govworx-2026-vci','govworx-phase-a','Build the fact base and diagnose the current state','Map the current product and commercial architecture','Map CommsCoach, TRAIN, ASSIST, HIRE, CAPTURE, PRR, Research, Media Index, Flock, and MedAssist across packages, metrics, tiers, prices, and roadmap roles.','Jake + Codex','2026-07-20','2026-08-03','planned','Build the current-state product, package, metric, tier, and roadmap map from the received evidence.','The design work needs a shared current-state architecture and explicit product roles.','high',1,21,['product map','package map','commercial architecture'],7],
    ['govworx-price-realization','govworx-2026-vci','govworx-phase-a','Build the fact base and diagnose the current state','Analyze price realization and customer patterns','Reconcile commercial, initiative, grant, channel, contracted, and standard prices and analyze customer and usage patterns.','Jake + Codex','2026-07-27','2026-08-07','planned','Compare list, quoted, and contracted pricing and identify discounts, exceptions, band cliffs, and common product combinations.','The preferred architecture should address observed leakage and buying behavior rather than theory alone.','normal',0,14,['price realization','contracted pricing','pricing reconciliation'],8],
    ['govworx-future-options','govworx-2026-vci','govworx-phase-b','Develop and align on future-state options','Develop future-state packaging and pricing options','Create and compare two to three architectures covering core packages, add-ons, upgrade paths, pricing metrics, tiers, and bands.','Jake + Codex','2026-07-27','2026-08-07','planned','Develop the SteerCo 1 option set and decision materials using the fact base and relevant market analogies.','SteerCo 1 must select the preferred direction and validation scope.','high',1,21,['future-state options','packaging architecture','steerco 1'],9],
    ['govworx-validation-design','govworx-2026-vci','govworx-phase-c','Validate and refine the preferred direction','Finalize the validation design','Confirm the research questions, concepts, participants, method, and timing after SteerCo 1.','Jake + SteerCo','2026-08-10','2026-08-14','planned','Translate the SteerCo 1 decision into a targeted customer and prospect validation plan.','The deck expects a three-to-four-week validation period whose exact scope is set at SteerCo 1.','normal',1,14,['validation design','research questions','validation scope'],10],
    ['govworx-field-validation','govworx-2026-vci','govworx-phase-c','Validate and refine the preferred direction','Conduct customer and prospect validation','Test the preferred architecture, pricing logic, and upgrade paths with the agreed customers and prospects.','Jake + research team','2026-08-17','2026-09-04','planned','Run the targeted validation and synthesize buying, usability, and willingness-to-pay evidence.','Validation is the primary external pressure test before the final recommendation.','normal',0,14,['customer validation','prospect validation'],11],
    ['govworx-final-recommendation','govworx-2026-vci','govworx-phase-d','Finalize recommendation and implementation priorities','Finalize the recommendation and implementation priorities','Finalize the architecture, metric, tiers, upgrade paths, rollout priorities, migration approach, and enablement needs.','Jake + SteerCo','2026-09-07','2026-09-14','planned','Prepare the SteerCo 2 recommendation and implementation-priority decision materials.','SteerCo 2 is the final decision gate in the approved VCI plan.','high',1,14,['steerco 2','final recommendation','implementation priorities'],12],
  ];
  const insertGovworxItem = db.prepare(`INSERT OR IGNORE INTO project_plan_items
    (id,project_id,phase_id,workstream,title,description,owner_label,start_date,due_date,status,suggested_action,why_now,priority,create_action,surface_days,dedupe_terms,sort_order,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const item of govworxItems) {
    const values = [...item];
    values[15] = JSON.stringify(values[15]);
    insertGovworxItem.run(...values,now,now);
  }
  const govworxDependencies = {
    "govworx-current-map": ["govworx-product-demo"],
    "govworx-price-realization": ["govworx-data-request"],
    "govworx-future-options": ["govworx-current-map", "govworx-price-realization"],
    "govworx-validation-design": ["govworx-future-options"],
    "govworx-field-validation": ["govworx-validation-design"],
    "govworx-final-recommendation": ["govworx-field-validation"],
  };
  for (const [id, dependencies] of Object.entries(govworxDependencies)) {
    db.prepare("UPDATE project_plan_items SET depends_on=?,execution_mode='auto' WHERE id=?").run(JSON.stringify(dependencies),id);
  }
}

async function importLegacyReceipts() {
  try {
    const entries = await readdir(legacyJobsDir, { withFileTypes: true });
    const insert = db.prepare(`INSERT OR IGNORE INTO agent_runs
      (id, work_item_id, company_slug, scope, intent, title, allowed_sources, status,
       result, error, input_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(path.join(legacyJobsDir, entry.name), "utf8"));
        const item = db.prepare("SELECT company_slug FROM work_items WHERE id = ?").get(job.target);
        const status = job.status === "review" ? "review" : job.status === "error" ? "error" : "error";
        insert.run(job.id, item ? job.target : null, item?.company_slug ?? null, "legacy", "Imported legacy runner receipt", job.title || "Legacy agent run", status, job.result || "", job.error || (status === "error" ? "Legacy run was interrupted." : ""), job.inputHash || "legacy", job.createdAt || nowIso(), job.updatedAt || nowIso());
      } catch {
        // One malformed legacy receipt should not block the app.
      }
    }
  } catch {
    // Legacy receipts are optional.
  }
}

seedDatabase();
db.prepare(`INSERT OR IGNORE INTO companies(slug,display_name,description,ai_os_path,box_folder,active,created_at,updated_at)
  VALUES('edulog','Edulog','Pricing, quoting tools, and ongoing VCI work','04_company_context/edulog.md','Growth Team / 32. Pricing / 00 Projects',1,?,?)`).run(nowIso(),nowIso());
seedProjectPlans();
await importLegacyReceipts();

function seedAdaptiveSystem() {
  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO source_receipts(source,status,checked_at,detail,result,error)
    VALUES('mail','cached',?,'Cached mail is ready; live refresh has not run yet.','','')`).run(now);
  const routes = [
    ["zoom-transcript-router", "Zoom Transcript Router", "Route a downloaded transcript into Jake's local transcript repository.", "allowlisted_local_workflow", JSON.stringify(["transcript", "meeting_transcript"]), "Routed transcript, summary, decisions, and follow-ups"],
    ["draft-executive-email", "Executive Email Draft", "Draft a concise reply using Jake's approved writing patterns and relevant work context.", "codex_readonly", JSON.stringify(["email", "email_reply"]), "Editable proposed reply with source basis"],
    ["morning-briefing", "Morning Briefing", "Create Jake's daily operating read from current authorized sources.", "codex_readonly", JSON.stringify(["daily_priority", "morning_briefing"]), "Prioritized daily operating read"],
    ["generic-codex", "Scoped Codex Agent", "Investigate, compare, draft, or build within the selected read-only context.", "codex_readonly", JSON.stringify(["*"]), "Concise, source-backed result"],
  ];
  const insert = db.prepare(`INSERT INTO skill_routes(id,label,description,executor_type,work_types,expected_output,enabled,created_at,updated_at)
    VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,description=excluded.description,
    executor_type=excluded.executor_type,work_types=excluded.work_types,expected_output=excluded.expected_output,enabled=1,updated_at=excluded.updated_at`);
  for (const route of routes) insert.run(...route, now, now);

  const legacy = db.prepare("SELECT * FROM policy_suggestions").all();
  const migrate = db.prepare(`INSERT OR IGNORE INTO preference_rules(id,title,rationale,instruction,scope_type,scope_value,category,status,evidence_json,created_at,updated_at)
    VALUES(?,?,?,?,'work_type','', 'routing', ?, ?, ?, ?)`);
  for (const item of legacy) {
    migrate.run(item.id, item.title, item.rationale, item.proposed_rule, item.status === "accepted" ? "accepted" : "proposed", JSON.stringify([{ workItemId: item.work_item_id }]), item.created_at, item.updated_at);
  }
}

seedAdaptiveSystem();
db.prepare("UPDATE companies SET ai_os_path='05_projects/stockiq-packaging-product-marketing-vci.md',updated_at=? WHERE slug='stockiq'").run(nowIso());
await persistAllNotes();

function repairPreparedCodexTaskStates() {
  const prepared = db.prepare(`SELECT t.id AS task_id,t.work_item_id,w.status
    FROM codex_tasks t JOIN work_items w ON w.id=t.work_item_id
    WHERE t.status='waiting_on_user' AND t.thread_id='' AND w.status IN ('queued','working')`).all();
  const repairedAt = nowIso();
  for (const receipt of prepared) {
    const hasPriorResult = db.prepare("SELECT 1 FROM agent_runs WHERE work_item_id=? AND status IN ('review','error') LIMIT 1").get(receipt.work_item_id);
    const restoredStatus = hasPriorResult ? "back_for_review" : "to_review";
    db.prepare("UPDATE work_items SET status=?,updated_at=? WHERE id=?").run(restoredStatus, repairedAt, receipt.work_item_id);
    eventFor(receipt.work_item_id, "codex_task_state_repaired", "The prepared native Codex task has not started. This card remains in Open Work until a verified task reports that it started.");
  }
}

function recoverInterruptedRuns() {
  const interrupted = db.prepare("SELECT * FROM agent_runs WHERE status IN ('queued','working')").all();
  const now = nowIso();
  for (const run of interrupted) {
    db.prepare("UPDATE agent_runs SET status='error',error='The local runner restarted before this assignment finished.',updated_at=? WHERE id=?").run(now, run.id);
    if (run.work_item_id) db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(now, run.work_item_id);
    if (run.mail_message_id) {
      db.prepare("UPDATE mail_drafts SET status='error',updated_at=? WHERE mail_message_id=?").run(now, run.mail_message_id);
      db.prepare("UPDATE mail_messages SET draft_state='error',updated_at=? WHERE id=?").run(now, run.mail_message_id);
    }
  }
  db.prepare("UPDATE source_receipts SET status='error',detail='The prior refresh was interrupted; cached data was preserved.',error='Runner restarted during refresh.',checked_at=? WHERE status='working'").run(now);
  db.prepare("UPDATE note_edit_proposals SET status='error',error='The runner restarted during this proposed edit.',updated_at=? WHERE status='working'").run(now);
  db.prepare("UPDATE external_actions SET status='error',error='The runner restarted before the external action was verified.',updated_at=? WHERE status IN ('queued','working')").run(now);
  const staleWorkingItems = db.prepare(`SELECT w.id FROM work_items w
    WHERE w.status IN ('queued','working')
      AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.work_item_id=w.id AND r.status IN ('queued','working'))
      AND NOT EXISTS (SELECT 1 FROM codex_tasks t WHERE t.work_item_id=w.id AND t.status IN ('starting','working'))
      AND NOT EXISTS (SELECT 1 FROM external_actions e WHERE e.work_item_id=w.id AND e.status IN ('queued','working'))`).all();
  for (const item of staleWorkingItems) {
    db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(now, item.id);
    eventFor(item.id, "status_repaired", "Working status was cleared because no active process remained.");
  }
}

repairPreparedCodexTaskStates();
recoverInterruptedRuns();

function repairMisroutedTranscriptRuns() {
  const candidates = db.prepare(`SELECT r.id,r.work_item_id,w.type,w.title,w.source_provider
    FROM agent_runs r
    JOIN work_items w ON w.id=r.work_item_id
    WHERE r.skill_id='zoom-transcript-router' AND r.status='waiting_on_user'`).all();
  const repairedAt = nowIso();
  for (const candidate of candidates) {
    if (resolveSkillRoute({ item: candidate }).id === "zoom-transcript-router") continue;
    const detail = "This card was incorrectly routed to transcript processing. No transcript is required for this assignment.";
    db.prepare("UPDATE agent_runs SET status='error',error=?,updated_at=? WHERE id=?").run(detail, repairedAt, candidate.id);
    const stillActive = db.prepare("SELECT 1 FROM agent_runs WHERE work_item_id=? AND id<>? AND status IN ('queued','working','waiting_on_user') LIMIT 1").get(candidate.work_item_id, candidate.id);
    if (!stillActive) db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(repairedAt, candidate.work_item_id);
    eventFor(candidate.work_item_id, "skill_route_repaired", detail);
  }
}

repairMisroutedTranscriptRuns();

function migrateLegacyAssignments() {
  if (db.prepare("SELECT version FROM schema_migrations WHERE version=12").get()) return;
  const activeLegacyOwners = db.prepare(`SELECT id,work_item_id,thread_id,status FROM codex_tasks
    WHERE status IN ('accepted','starting','working','needs_input','needs_attention') AND thread_id<>''`).all();
  if (activeLegacyOwners.length) {
    throw new Error(`Assignment migration paused: ${activeLegacyOwners.length} legacy native Codex owner(s) are still active.`);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const importedAt = nowIso();
    const insertAssignment = db.prepare(`INSERT OR IGNORE INTO assignments
      (id,assignment_key,work_item_id,destination,title,instruction,scope_hash,status,attempt,prior_work_item_status,
       owner_type,owner_id,callback_capability_hash,capability_generation,allowed_sources,context_manifest,
       external_action_boundary,result,error,revision_of,accepted_at,started_at,heartbeat_at,needs_input_at,
       completed_at,failed_at,released_at,cancelled_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertEvent = db.prepare(`INSERT OR IGNORE INTO assignment_events
      (id,assignment_id,attempt,event_key,event_type,owner_id,occurred_at,received_at,previous_status,next_status,payload_json,applied,rejection_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,'')`);
    const activeByWorkItem = new Set();
    const legacyTasks = db.prepare(`SELECT t.*,w.status AS work_item_status FROM codex_tasks t
      JOIN work_items w ON w.id=t.work_item_id ORDER BY t.created_at DESC`).all();
    for (const task of legacyTasks) {
      let status = legacyAssignmentState(task);
      if (activeAssignmentStates.has(status)) {
        if (activeByWorkItem.has(task.work_item_id)) status = "cancelled";
        else activeByWorkItem.add(task.work_item_id);
      }
      const capability = createCallbackCapability();
      const ownerId = task.thread_id || "";
      const terminalAt = task.updated_at || task.created_at;
      insertAssignment.run(
        task.id,
        `legacy-codex-task:${task.id}`,
        task.work_item_id,
        "separate_task",
        task.title,
        task.instruction,
        assignmentScopeHash({ workItemId: task.work_item_id, destination: "separate_task", instruction: task.instruction }),
        status,
        1,
        task.work_item_status || "to_review",
        "legacy_native_codex",
        ownerId,
        capability.hash,
        0,
        "[]",
        JSON.stringify({ legacyCodexTaskId: task.id }),
        "No external writes without Jake's separate approval.",
        task.result || "",
        task.error || "",
        null,
        ["accepted", "working", "needs_input", "needs_attention", "completed", "failed", "ownership_released"].includes(status) ? task.created_at : null,
        ["working", "needs_input", "needs_attention", "completed", "failed", "ownership_released"].includes(status) ? task.created_at : null,
        task.heartbeat_at || null,
        status === "needs_input" ? terminalAt : null,
        status === "completed" ? terminalAt : null,
        status === "failed" ? terminalAt : null,
        status === "ownership_released" ? terminalAt : null,
        status === "cancelled" ? terminalAt : null,
        task.created_at,
        terminalAt,
      );
      insertEvent.run(
        randomUUID(),
        task.id,
        1,
        `legacy-import:${task.id}`,
        "legacy_imported",
        ownerId,
        terminalAt,
        importedAt,
        status,
        status,
        JSON.stringify({ legacyStatus: task.status, legacyCodexTaskId: task.id }),
      );
    }

    const legacyRuns = db.prepare(`SELECT r.*,w.status AS work_item_status FROM agent_runs r
      JOIN work_items w ON w.id=r.work_item_id WHERE r.status IN ('review','error') ORDER BY r.created_at`).all();
    for (const run of legacyRuns) {
      const id = `agent-run:${run.id}`;
      const status = run.status === "review" ? "completed" : "failed";
      const capability = createCallbackCapability();
      insertAssignment.run(
        id,
        `legacy-agent-run:${run.id}`,
        run.work_item_id,
        "card",
        run.title,
        run.intent,
        assignmentScopeHash({ workItemId: run.work_item_id, destination: "card", instruction: run.intent }),
        status,
        1,
        run.work_item_status || "to_review",
        "legacy_local_runner",
        `legacy-agent-run:${run.id}`,
        capability.hash,
        0,
        run.allowed_sources || "[]",
        run.context_manifest || "{}",
        "No external writes were authorized.",
        run.result || "",
        run.error || "",
        null,
        run.created_at,
        run.created_at,
        null,
        null,
        status === "completed" ? run.updated_at : null,
        status === "failed" ? run.updated_at : null,
        null,
        null,
        run.created_at,
        run.updated_at,
      );
      insertEvent.run(
        randomUUID(),
        id,
        1,
        `legacy-import:${run.id}`,
        "legacy_imported",
        `legacy-agent-run:${run.id}`,
        run.updated_at,
        importedAt,
        status,
        status,
        JSON.stringify({ legacyStatus: run.status, legacyAgentRunId: run.id }),
      );
    }
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(12,?)").run(importedAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

migrateLegacyAssignments();

function responseJson(response, status, payload) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "content-type,x-serent-command-center",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 128_000) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function eventFor(workItemId, eventType, detail) {
  db.prepare(`INSERT INTO work_item_events(id, work_item_id, event_type, detail, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), workItemId, eventType, detail || "", nowIso());
}

const cardCommandFields = ["title", "due_at", "priority", "company_slug", "status", "resolution", "resolved_at"];

function cardCommandSnapshot(row, fields = cardCommandFields) {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
}

function applyCardCommandPatch(workItemId, patch) {
  const entries = Object.entries(patch).filter(([field]) => cardCommandFields.includes(field));
  if (!entries.length) return;
  const assignments = entries.map(([field]) => `${field}=?`).join(",");
  db.prepare(`UPDATE work_items SET ${assignments},updated_at=? WHERE id=?`).run(...entries.map(([, value]) => value), nowIso(), workItemId);
}

function workItemById(id) {
  const row = db.prepare(`SELECT w.*,c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(id);
  return row ? hydrateWorkItem(row) : null;
}

function safeSegment(value, fallback = "note") {
  const next = String(value || "").normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return (next || fallback).slice(0, 80);
}

async function persistNoteFile(row) {
  if (!row) return "";
  let relative = row.file_path;
  if (!relative) {
    relative = path.join(safeSegment(row.company_slug || "unfiled"), safeSegment(row.type || "notes"), `${safeSegment(row.title)}-${safeSegment(row.id).slice(-12)}.md`);
    db.prepare("UPDATE notes SET file_path=? WHERE id=?").run(relative, row.id);
  }
  const absolute = path.join(documentsDir, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  await writeFile(temporary, `# ${row.title}\n\n${row.body || ""}\n`, "utf8");
  await rename(temporary, absolute);
  return absolute;
}

async function persistAllNotes() {
  for (const row of db.prepare("SELECT * FROM notes").all()) await persistNoteFile(row);
}

function ensureDailyNote() {
  const day = localDateKey();
  const id = `daily-${day}`;
  const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  if (existing) return mapNote(existing);
  const now = nowIso();
  db.prepare(`INSERT INTO notes(id, title, body, type, origin, state, created_at, updated_at)
    VALUES (?, ?, '', 'daily', 'manual', 'active', ?, ?)`).run(id, `Daily note · ${day}`, now, now);
  const created = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  void persistNoteFile(created);
  return mapNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
}

function mapCompany(row) {
  return {
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    aiOsPath: row.ai_os_path,
    boxFolder: row.box_folder,
  };
}

function mapNote(row) {
  if (!row) return null;
  const links = db.prepare("SELECT work_item_id FROM note_links WHERE note_id = ?").all(row.id).map((link) => link.work_item_id);
  const proposal = db.prepare("SELECT * FROM note_edit_proposals WHERE note_id=? ORDER BY created_at DESC LIMIT 1").get(row.id);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: row.type,
    origin: row.origin,
    state: row.state,
    companySlug: row.company_slug,
    meetingId: row.meeting_id,
    projectRef: row.project_ref,
    filePath: row.file_path ? path.join(documentsDir, row.file_path) : "",
    latestProposal: proposal ? {
      id: proposal.id,
      instruction: proposal.instruction,
      proposedTitle: proposal.proposed_title,
      proposedBody: proposal.proposed_body,
      summary: proposal.summary,
      status: proposal.status,
      error: proposal.error,
      createdAt: proposal.created_at,
      updatedAt: proposal.updated_at,
    } : null,
    workItemIds: links,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row) {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    companySlug: row.company_slug,
    scope: row.scope,
    intent: row.intent,
    title: row.title,
    allowedSources: JSON.parse(row.allowed_sources || "[]"),
    status: row.status,
    result: row.result,
    error: row.error,
    revisionOf: row.revision_of,
    skillId: row.skill_id || "generic-codex",
    executorType: row.executor_type || "codex_readonly",
    contextManifest: JSON.parse(row.context_manifest || "{}"),
    mailMessageId: row.mail_message_id || null,
    waitingReason: row.waiting_reason || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignment(row, { includeEvents = false } = {}) {
  if (!row) return null;
  const events = includeEvents ? db.prepare(`SELECT id,event_key,event_type,owner_id,occurred_at,received_at,
      previous_status,next_status,payload_json,applied,rejection_reason FROM assignment_events
      WHERE assignment_id=? ORDER BY received_at DESC,id DESC LIMIT 50`).all(row.id).map((event) => ({
        id: event.id,
        eventKey: event.event_key,
        type: event.event_type,
        ownerId: event.owner_id,
        occurredAt: event.occurred_at,
        receivedAt: event.received_at,
        previousStatus: event.previous_status,
        nextStatus: event.next_status,
        payload: JSON.parse(event.payload_json || "{}"),
        applied: Boolean(event.applied),
        rejectionReason: event.rejection_reason,
      })) : [];
  return {
    id: row.id,
    assignmentKey: row.assignment_key,
    workItemId: row.work_item_id,
    destination: row.destination,
    title: row.title,
    instruction: row.instruction,
    status: row.status,
    attempt: Number(row.attempt || 1),
    priorWorkItemStatus: row.prior_work_item_status,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    capabilityGeneration: Number(row.capability_generation || 1),
    allowedSources: JSON.parse(row.allowed_sources || "[]"),
    contextManifest: JSON.parse(row.context_manifest || "{}"),
    externalActionBoundary: row.external_action_boundary,
    result: row.result,
    error: row.error,
    revisionOf: row.revision_of,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    needsInputAt: row.needs_input_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    releasedAt: row.released_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    events,
  };
}

function mapRule(row) {
  return {
    id: row.id,
    title: row.title,
    rationale: row.rationale,
    instruction: row.instruction,
    scopeType: row.scope_type,
    scopeValue: row.scope_value,
    category: row.category,
    status: row.status,
    evidence: JSON.parse(row.evidence_json || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function activeRules({ companySlug = null, source = "", workType = "", skillId = "" } = {}) {
  return db.prepare("SELECT * FROM preference_rules WHERE status='accepted' ORDER BY updated_at DESC").all()
    .filter((rule) => {
      if (rule.scope_type === "global") return true;
      if (rule.scope_type === "company") return Boolean(companySlug && rule.scope_value === companySlug);
      if (rule.scope_type === "source") return Boolean(source && rule.scope_value === source);
      if (rule.scope_type === "work_type") return Boolean(workType && (!rule.scope_value || rule.scope_value === workType));
      if (rule.scope_type === "skill") return Boolean(skillId && rule.scope_value === skillId);
      return false;
    }).map(mapRule);
}

function recordFeedback({ eventType, workItemId = null, mailMessageId = null, companySlug = null, skillId = null, detail = "", beforeValue = "", afterValue = "" }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO feedback_events(id,event_type,work_item_id,mail_message_id,company_slug,skill_id,detail,before_value,after_value,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, eventType, workItemId, mailMessageId, companySlug, skillId, detail, beforeValue, afterValue, nowIso());
  return id;
}

function proposeCompanyRoutingRule(mail, companySlug) {
  if (!mail?.sender_email || !companySlug) return null;
  const company = db.prepare("SELECT display_name FROM companies WHERE slug=? AND active=1").get(companySlug);
  if (!company) return null;
  const senderEmail = String(mail.sender_email).toLowerCase();
  const duplicate = db.prepare("SELECT id FROM preference_rules WHERE category='company_routing' AND status IN ('proposed','accepted') AND evidence_json LIKE ? AND evidence_json LIKE ? LIMIT 1")
    .get(`%${senderEmail.replaceAll("%", "")}%`, `%${companySlug.replaceAll("%", "")}%`);
  if (duplicate) return duplicate.id;
  const id = randomUUID(); const now = nowIso();
  db.prepare(`INSERT INTO preference_rules(id,title,rationale,instruction,scope_type,scope_value,category,status,evidence_json,created_at,updated_at)
    VALUES(?,?,?,?, 'source','outlook','company_routing','proposed',?,?,?)`)
    .run(id, `Route ${mail.sender_name || senderEmail} mail to ${company.display_name}`, `Jake corrected the company on “${mail.subject}.”`, `When Outlook mail is from ${senderEmail}, assign it to ${company.display_name}.`, JSON.stringify([{ senderEmail, companySlug, mailMessageId: mail.id }]), now, now);
  return id;
}

function mailNotes(mailMessageId, companySlug) {
  const linked = db.prepare(`SELECT n.* FROM notes n JOIN mail_note_links l ON l.note_id=n.id WHERE l.mail_message_id=?`).all(mailMessageId);
  const contextual = companySlug ? db.prepare("SELECT * FROM notes WHERE company_slug=? AND type IN ('project','decision') ORDER BY updated_at DESC LIMIT 12").all(companySlug) : [];
  return [...new Map([...linked, ...contextual].map((note) => [note.id, note])).values()].map(mapNote);
}

function mapMail(row, includeBody = false) {
  const draft = row.draft_id ? {
    id: row.draft_id,
    generatedBody: row.generated_body || "",
    currentBody: row.current_body || "",
    status: row.mail_draft_status || row.draft_state || "none",
    skillId: row.mail_draft_skill || "draft-executive-email",
    sourceBasis: row.source_basis || "",
    updatedAt: row.mail_draft_updated_at || row.updated_at,
  } : null;
  const rules = activeRules({ companySlug: row.company_slug, source: "outlook", workType: "email", skillId: "draft-executive-email" });
  return {
    id: row.id,
    graphId: row.graph_id,
    subject: row.subject,
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    recipients: JSON.parse(row.recipients_json || "[]"),
    cc: JSON.parse(row.cc_json || "[]"),
    receivedAt: row.received_at,
    preview: row.preview,
    body: includeBody ? row.body_text : "",
    bodyCachedAt: row.body_cached_at,
    webLink: row.web_link,
    isRead: row.is_read < 0 ? null : Boolean(row.is_read),
    hasAttachments: Boolean(row.has_attachments),
    attachments: JSON.parse(row.attachments_json || "[]"),
    importance: row.importance,
    companySlug: row.company_slug,
    replyState: row.reply_state,
    replyConfidence: row.reply_confidence,
    replyReason: row.reply_reason,
    reviewState: row.review_state,
    snoozedUntil: row.snoozed_until,
    draftState: row.draft_state,
    actionWorkItemId: row.action_work_item_id,
    freshness: row.freshness,
    lastSyncedAt: row.last_synced_at,
    draft,
    activeRules: rules,
    notes: includeBody ? mailNotes(row.id, row.company_slug) : [],
  };
}

const mailSelect = `SELECT m.*,d.id AS draft_id,d.generated_body,d.current_body,d.status AS mail_draft_status,
  d.skill_id AS mail_draft_skill,d.source_basis,d.updated_at AS mail_draft_updated_at
  FROM mail_messages m LEFT JOIN mail_drafts d ON d.mail_message_id=m.id`;

function hydrateWorkItem(row) {
  const sources = db.prepare("SELECT * FROM source_references WHERE work_item_id = ? ORDER BY retrieved_at DESC").all(row.id).map((source) => ({
    id: source.id,
    provider: source.provider,
    label: source.label,
    sourceId: source.source_id,
    sourcePath: source.source_path,
    sourceUrl: source.source_url,
    retrievedAt: source.retrieved_at,
    freshness: source.freshness,
  }));
  const events = db.prepare("SELECT * FROM work_item_events WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 30").all(row.id).map((event) => ({
    id: event.id,
    type: event.event_type,
    detail: event.detail,
    createdAt: event.created_at,
  }));
  const notes = db.prepare(`SELECT n.* FROM notes n JOIN note_links l ON l.note_id = n.id
    WHERE l.work_item_id = ? ORDER BY n.updated_at DESC`).all(row.id).map(mapNote);
  const runs = db.prepare("SELECT * FROM agent_runs WHERE work_item_id = ? ORDER BY created_at DESC").all(row.id).map(mapRun);
  const externalActions = db.prepare("SELECT * FROM external_actions WHERE work_item_id=? ORDER BY created_at DESC LIMIT 10").all(row.id).map((action) => ({
    id: action.id, provider: action.provider, actionType: action.action_type, targetId: action.target_id,
    status: action.status, receipt: action.receipt, error: action.error, createdAt: action.created_at, updatedAt: action.updated_at,
  }));
  const codexTasks = db.prepare("SELECT * FROM codex_tasks WHERE work_item_id=? ORDER BY created_at DESC LIMIT 10").all(row.id).map((task) => ({
    id: task.id, threadId: task.thread_id, title: task.title, instruction: task.instruction,
    status: task.status, result: task.result, error: task.error, createdAt: task.created_at, updatedAt: task.updated_at,
  }));
  const assignments = db.prepare("SELECT * FROM assignments WHERE work_item_id=? ORDER BY updated_at DESC,created_at DESC LIMIT 20").all(row.id).map((assignment) => mapAssignment(assignment));
  const projectContextRow = db.prepare(`SELECT p.id AS project_id,p.title AS project_title,pi.id AS plan_item_id,
      pi.title AS plan_item_title,pi.workstream,pi.due_date,ph.title AS phase_title
    FROM project_action_links l
    JOIN project_plan_items pi ON pi.id=l.project_plan_item_id
    JOIN projects p ON p.id=pi.project_id
    LEFT JOIN project_phases ph ON ph.id=pi.phase_id
    WHERE l.work_item_id=? ORDER BY pi.due_date LIMIT 1`).get(row.id);
  const projectContext = projectContextRow ? {
    projectId: projectContextRow.project_id,
    projectTitle: projectContextRow.project_title,
    planItemId: projectContextRow.plan_item_id,
    planItemTitle: projectContextRow.plan_item_title,
    workstream: projectContextRow.workstream,
    phaseTitle: projectContextRow.phase_title || "",
    dueDate: projectContextRow.due_date,
  } : null;
  const rules = activeRules({ companySlug: row.company_slug, source: row.source_provider, workType: row.type });
  return {
    id: row.id,
    type: row.type,
    companySlug: row.company_slug,
    companyName: row.company_name || "Unassigned",
    title: row.title,
    summary: row.summary,
    whyNow: row.why_now,
    priority: row.priority,
    confidence: row.confidence,
    status: row.status,
    suggestedAction: row.suggested_action,
    draft: row.draft,
    owner: row.owner,
    dueAt: row.due_at,
    plannedAt: row.planned_at || null,
    plannedMinutes: Number(row.planned_minutes || 0),
    preparationMode: row.preparation_mode || "manual",
    preparationSkill: row.preparation_skill || "",
    preparationInstruction: row.preparation_instruction || "",
    resolution: row.resolution,
    decisionState: row.decision_state || (row.source_provider === "clickup" ? "committed" : "proposed"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    sources,
    events,
    notes,
    agentRuns: runs,
    externalActions,
    codexTasks,
    assignments,
    projectContext,
    activeRules: rules,
  };
}

function queryWorkItems(filters = {}) {
  const clauses = ["1 = 1"];
  const params = [];
  if (filters.company && filters.company !== "all") {
    clauses.push("w.company_slug = ?");
    params.push(filters.company);
  }
  if (filters.status && filters.status !== "all") {
    clauses.push("w.status = ?");
    params.push(filters.status);
  }
  if (filters.type && filters.type !== "all") {
    clauses.push("w.type = ?");
    params.push(filters.type);
  }
  if (filters.source && filters.source !== "all") {
    clauses.push("w.source_provider = ?");
    params.push(filters.source);
  }
  if (filters.priority && filters.priority !== "all") {
    clauses.push("w.priority = ?");
    params.push(filters.priority);
  }
  if (filters.today === "true") clauses.push("w.due_at IS NOT NULL AND date(w.due_at) <= date('now', 'localtime')");
  if (filters.search) {
    clauses.push("(w.title LIKE ? OR w.summary LIKE ? OR w.why_now LIKE ? OR c.display_name LIKE ?)");
    const term = `%${filters.search}%`;
    params.push(term, term, term, term);
  }
  const rows = db.prepare(`SELECT w.*, c.display_name AS company_name
    FROM work_items w LEFT JOIN companies c ON c.slug = w.company_slug
    WHERE ${clauses.join(" AND ")}
    ORDER BY CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             CASE w.status WHEN 'back_for_review' THEN 0 WHEN 'to_review' THEN 1 WHEN 'working' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
             COALESCE(w.due_at, w.updated_at) ASC`).all(...params);
  return rows.map(hydrateWorkItem);
}

function addresses(recipients) {
  return (Array.isArray(recipients) ? recipients : []).map((item) => ({
    name: item?.emailAddress?.name || "",
    email: item?.emailAddress?.address || "",
  }));
}

function inferCompany(message) {
  const haystack = `${message.subject || ""} ${message.bodyPreview || ""} ${message.from?.emailAddress?.address || ""}`.toLowerCase();
  const senderEmail = String(message.from?.emailAddress?.address || "").toLowerCase();
  if (senderEmail) {
    const rules = db.prepare("SELECT evidence_json FROM preference_rules WHERE status='accepted' AND category='company_routing' ORDER BY updated_at DESC").all();
    for (const rule of rules) {
      try {
        const evidence = JSON.parse(rule.evidence_json || "[]");
        const match = evidence.find((item) => String(item.senderEmail || "").toLowerCase() === senderEmail && db.prepare("SELECT slug FROM companies WHERE slug=? AND active=1").get(item.companySlug));
        if (match) return match.companySlug;
      } catch { /* Ignore malformed rule evidence. */ }
    }
  }
  const candidates = [
    ["avionte", ["aviont", "avionte"]],
    ["stockiq", ["stockiq", "stock iq"]],
    ["govworx", ["govworx"]],
    ["edulog", ["edulog"]],
  ];
  return candidates.find(([, keys]) => keys.some((key) => haystack.includes(key)))?.[0] || null;
}

function classifyMail(message, sentByConversation, sentBySubject, companySlug = null, directRecipientRuleEnabled = false) {
  const subject = String(message.subject || "");
  const preview = String(message.bodyPreview || "");
  const text = `${subject}\n${preview}`.toLowerCase();
  const inboundAt = Date.parse(message.receivedDateTime || 0);
  const laterSent = Math.max(sentByConversation.get(message.conversationId) || 0, sentBySubject.get(normalizedSubject(subject)) || 0);
  const automatic = isLikelyAutomatedMail(message);
  const question = /could you|can you|would you|please (review|send|confirm|share|let|advise)|let me know|your thoughts|your feedback|need your|are you able|when can|do you have|your reaction|please opine|please respond/.test(text);
  const directlyAddressed = directRecipientRuleEnabled && isDirectlyAddressedToJake(message);
  const blocking = /urgent|today|tomorrow|deadline|blocked|need (this|your|an answer)|waiting on|approval|sign[- ]?off|decision/.test(text);
  const responded = laterSent > inboundAt;
  const needsReply = !automatic && (question || directlyAddressed) && !responded;
  const ageHours = Math.max(0, (Date.now() - inboundAt) / 3_600_000);
  const confidence = responded ? 0.98 : needsReply ? Math.min(0.96, (directlyAddressed ? 0.86 : 0.72) + (blocking ? 0.08 : 0) + (message.importance === "high" ? 0.06 : 0)) : automatic ? 0.95 : 0.67;
  const reason = responded
    ? "A later message from Jake appears in Sent Items on this conversation or subject."
    : needsReply
      ? `${directlyAddressed ? "The message is addressed directly to Jake." : "The message asks Jake for a response or decision."}${blocking ? " Timing or dependency language raises its urgency." : ""}`
      : automatic
        ? "The message looks automated or informational."
        : "No clear response request was detected.";
  const highImpact = needsReply && (blocking || message.importance === "high" || (Boolean(companySlug) && ageHours >= 36));
  return { replyState: responded ? "responded" : needsReply ? "needs_reply" : "informational", confidence, reason, highImpact };
}

function dismissAutomaticMailAction(mailId) {
  const mail = db.prepare("SELECT * FROM mail_messages WHERE id=?").get(mailId);
  if (!mail?.action_work_item_id) return;
  const automatic = db.prepare("SELECT id FROM work_item_events WHERE work_item_id=? AND detail LIKE 'Promoted from Mail because%' LIMIT 1").get(mail.action_work_item_id);
  if (!automatic) return;
  const item = db.prepare("SELECT status FROM work_items WHERE id=?").get(mail.action_work_item_id);
  if (item && !["done", "dismissed"].includes(item.status)) {
    db.prepare("UPDATE work_items SET status='dismissed',resolution='Mail triage no longer considers this a high-impact reply obligation.',resolved_at=?,updated_at=? WHERE id=?").run(nowIso(), nowIso(), mail.action_work_item_id);
    eventFor(mail.action_work_item_id, "dismissed", "Removed after the mail triage signal was refined.");
  }
  db.prepare("UPDATE mail_messages SET action_work_item_id=NULL,updated_at=? WHERE id=?").run(nowIso(), mailId);
}

function discardUnneededAutomaticDraft(mailId) {
  const draft = db.prepare("SELECT * FROM mail_drafts WHERE mail_message_id=?").get(mailId);
  if (!draft || draft.origin_mode !== "automatic" || draft.current_body !== draft.generated_body) return;
  const manual = db.prepare("SELECT id FROM mail_draft_revisions WHERE mail_draft_id=? AND origin='manual' LIMIT 1").get(draft.id);
  if (manual) return;
  db.prepare("DELETE FROM mail_drafts WHERE id=?").run(draft.id);
  db.prepare("UPDATE mail_messages SET draft_state='none',updated_at=? WHERE id=?").run(nowIso(), mailId);
}

function ensureMailAction(mailId, classification) {
  const mail = db.prepare("SELECT * FROM mail_messages WHERE id=?").get(mailId);
  if (!mail || !classification.highImpact) return null;
  const existing = db.prepare("SELECT id FROM work_items WHERE source_provider='outlook' AND source_key=?").get(mail.graph_id);
  const id = existing?.id || randomUUID();
  const priority = mail.importance === "high" ? "urgent" : "high";
  const now = nowIso();
  if (existing) {
    db.prepare(`UPDATE work_items SET company_slug=?,title=?,summary=?,why_now=?,priority=?,confidence=?,suggested_action=?,updated_at=? WHERE id=?`).run(
      mail.company_slug, `Reply to ${mail.sender_name || mail.sender_email}: ${mail.subject}`, mail.preview, mail.reply_reason, priority, mail.reply_confidence,
      "Review Command Center's proposed reply, edit it, then copy it into Outlook.", now, id);
  } else {
    db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,source_provider,source_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'to_review',?,'outlook',?,?,?)`).run(id, "email", mail.company_slug, `Reply to ${mail.sender_name || mail.sender_email}: ${mail.subject}`, mail.preview, mail.reply_reason, priority, mail.reply_confidence, "Review Command Center's proposed reply, edit it, then copy it into Outlook.", mail.graph_id, now, now);
    eventFor(id, "created", "Promoted from Mail because the reply obligation is urgent or consequential.");
    db.prepare(`INSERT INTO source_references(id,work_item_id,provider,label,source_id,source_url,retrieved_at,freshness)
      VALUES(?,?, 'outlook', ?, ?, ?, ?, 'live')`).run(randomUUID(), id, mail.subject, mail.graph_id, mail.web_link, now);
  }
  const snoozed = mail.snoozed_until && Date.parse(mail.snoozed_until) > Date.now();
  const currentStatus = db.prepare("SELECT status FROM work_items WHERE id=?").get(id)?.status;
  if (snoozed && !["done", "dismissed"].includes(currentStatus)) {
    db.prepare("UPDATE work_items SET status='waiting_external',updated_at=? WHERE id=?").run(now, id);
  } else if (!snoozed && currentStatus === "waiting_external") {
    db.prepare("UPDATE work_items SET status='to_review',updated_at=? WHERE id=?").run(now, id);
  }
  db.prepare("UPDATE mail_messages SET action_work_item_id=?,updated_at=? WHERE id=?").run(id, now, mailId);
  return id;
}

async function runSerentTokenRefresh() {
  await new Promise((resolve, reject) => {
    const child = spawn("schtasks.exe", ["/Run", "/TN", "SerentCodexTokenRefresh"], { windowsHide: true });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { error = `${error}${chunk}`.slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error || `Token refresh task returned ${code}.`)));
  });
  await new Promise((resolve) => setTimeout(resolve, 8_000));
}

async function syncMail() {
  const started = nowIso();
  db.prepare(`INSERT INTO source_receipts(source,status,checked_at,detail,result,error) VALUES('mail','working',?,'Refreshing active Outlook mail.','','')
    ON CONFLICT(source) DO UPDATE SET status='working',checked_at=excluded.checked_at,detail=excluded.detail,result='',error=''`).run(started);
  try {
    const sinceIso = new Date(Date.now() - 30 * 86400000).toISOString();
    let payload;
    try {
      payload = await fetchActiveMail({ sinceIso });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/token|bearer|401|refresh/i.test(message)) throw error;
      await runSerentTokenRefresh();
      clearSerentTokenCache();
      payload = await fetchActiveMail({ sinceIso });
    }
    const sentByConversation = new Map();
    const sentBySubject = new Map();
    for (const sent of payload.sent) {
      const sentAt = Date.parse(sent.sentDateTime || sent.receivedDateTime || 0);
      if (sent.conversationId) sentByConversation.set(sent.conversationId, Math.max(sentByConversation.get(sent.conversationId) || 0, sentAt));
      const subject = normalizedSubject(sent.subject);
      if (subject) sentBySubject.set(subject, Math.max(sentBySubject.get(subject) || 0, sentAt));
    }
    const upsert = db.prepare(`INSERT INTO mail_messages(id,graph_id,conversation_id,internet_message_id,subject,sender_name,sender_email,recipients_json,cc_json,received_at,preview,web_link,is_read,has_attachments,importance,company_slug,reply_state,reply_confidence,reply_reason,review_state,draft_state,freshness,last_synced_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'unreviewed','none','live',?,?,?)
      ON CONFLICT(graph_id) DO UPDATE SET conversation_id=excluded.conversation_id,internet_message_id=excluded.internet_message_id,subject=excluded.subject,
      sender_name=excluded.sender_name,sender_email=excluded.sender_email,recipients_json=excluded.recipients_json,cc_json=excluded.cc_json,
      received_at=excluded.received_at,preview=excluded.preview,web_link=excluded.web_link,is_read=excluded.is_read,has_attachments=excluded.has_attachments,
       importance=excluded.importance,company_slug=COALESCE(mail_messages.company_slug,excluded.company_slug),
       reply_state=CASE WHEN mail_messages.reply_override<>'' THEN mail_messages.reply_override ELSE excluded.reply_state END,
      reply_confidence=excluded.reply_confidence,reply_reason=excluded.reply_reason,freshness='live',last_synced_at=excluded.last_synced_at,updated_at=excluded.updated_at`);
    const draftCandidates = [];
    const directRecipientRuleEnabled = Boolean(db.prepare("SELECT id FROM preference_rules WHERE status='accepted' AND category='mail_direct_recipient' LIMIT 1").get());
    for (const message of payload.inbox) {
      const companySlug = inferCompany(message);
      const classification = classifyMail(message, sentByConversation, sentBySubject, companySlug, directRecipientRuleEnabled);
      const existing = db.prepare("SELECT id FROM mail_messages WHERE graph_id=?").get(message.id);
      const id = existing?.id || randomUUID();
      const now = nowIso();
      const sender = message.from?.emailAddress || {};
      upsert.run(id, message.id, message.conversationId || "", message.internetMessageId || "", message.subject || "(No subject)", sender.name || "", sender.address || "", JSON.stringify(addresses(message.toRecipients)), JSON.stringify(addresses(message.ccRecipients)), message.receivedDateTime || now, message.bodyPreview || "", message.webLink || "", message.isRead === null || message.isRead === undefined ? -1 : message.isRead ? 1 : 0, message.hasAttachments ? 1 : 0, message.importance || "normal", companySlug, classification.replyState, classification.confidence, classification.reason, now, now, now);
      const persisted = db.prepare("SELECT reply_state FROM mail_messages WHERE id=?").get(id);
      const effectiveNeedsReply = persisted?.reply_state === "needs_reply";
      if (classification.highImpact && effectiveNeedsReply) ensureMailAction(id, classification); else dismissAutomaticMailAction(id);
      if (!effectiveNeedsReply) discardUnneededAutomaticDraft(id);
      const hasDraft = db.prepare("SELECT id FROM mail_drafts WHERE mail_message_id=?").get(id);
      if (effectiveNeedsReply && !hasDraft) draftCandidates.push(id);
    }
     db.prepare("UPDATE mail_messages SET freshness='cached' WHERE last_synced_at < ?").run(started);
     for (const stale of db.prepare("SELECT id FROM mail_messages WHERE freshness='cached' AND action_work_item_id IS NOT NULL").all()) dismissAutomaticMailAction(stale.id);
    db.prepare("UPDATE mail_messages SET body_text='',body_cached_at=NULL WHERE body_cached_at IS NOT NULL AND body_cached_at < datetime('now','-30 days')").run();
    const coverage = payload.coverage.complete ? "complete" : "partial";
    const detail = `${payload.inbox.length} active messages synchronized across ${payload.coverage.pages} page${payload.coverage.pages === 1 ? "" : "s"}; coverage ${coverage}.`;
    db.prepare("UPDATE source_receipts SET status=?,checked_at=?,detail=?,result=?,error='' WHERE source='mail'").run(payload.coverage.complete ? "ready" : "partial", nowIso(), detail, JSON.stringify({ messages: payload.inbox.length, pages: payload.coverage.pages, complete: payload.coverage.complete }));
    for (const id of draftCandidates.slice(0, 2)) {
      if (activeProcesses.size >= 3) break;
      void launchMailDraft(id, { automatic: true }).catch(() => {});
    }
    return { status: payload.coverage.complete ? "ready" : "partial", messages: payload.inbox.length, draftCandidates: draftCandidates.length, coverage: payload.coverage };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mail refresh failed.";
    db.prepare(`INSERT INTO source_receipts(source,status,checked_at,detail,result,error) VALUES('mail','error',?,'Mail refresh failed without clearing cached mail.','',?)
      ON CONFLICT(source) DO UPDATE SET status='error',checked_at=excluded.checked_at,detail=excluded.detail,error=excluded.error`).run(nowIso(), message);
    throw error;
  }
}

function calendarIso(value) {
  const raw = String(value || "");
  const zoned = /Z$|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(zoned);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : nowIso();
}

function mapCalendarEvent(row) {
  return {
    id: row.id, graphId: row.graph_id, subject: row.subject, startAt: row.start_at, endAt: row.end_at,
    isAllDay: Boolean(row.is_all_day), organizer: { name: row.organizer_name, email: row.organizer_email },
    attendees: JSON.parse(row.attendees_json || "[]"), location: row.location, webLink: row.web_link,
    freshness: row.freshness, lastSyncedAt: row.last_synced_at,
  };
}

async function syncCalendar() {
  const started = nowIso();
  db.prepare(`INSERT INTO source_receipts(source,status,checked_at,detail,result,error) VALUES('calendar','working',?,'Refreshing the next 14 days of Outlook calendar.','','')
    ON CONFLICT(source) DO UPDATE SET status='working',checked_at=excluded.checked_at,detail=excluded.detail,result='',error=''`).run(started);
  const startIso = new Date(Date.now() - 86400000).toISOString();
  const endIso = new Date(Date.now() + 14 * 86400000).toISOString();
  try {
    let events;
    try { events = await fetchCalendarEvents({ startIso, endIso }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/token|bearer|401|refresh/i.test(message)) throw error;
      await runSerentTokenRefresh(); clearSerentTokenCache();
      events = await fetchCalendarEvents({ startIso, endIso });
    }
    const now = nowIso();
    const upsert = db.prepare(`INSERT INTO calendar_events(id,graph_id,subject,start_at,end_at,is_all_day,organizer_name,organizer_email,attendees_json,location,web_link,freshness,last_synced_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'live',?,?,?)
      ON CONFLICT(graph_id) DO UPDATE SET subject=excluded.subject,start_at=excluded.start_at,end_at=excluded.end_at,is_all_day=excluded.is_all_day,
      organizer_name=excluded.organizer_name,organizer_email=excluded.organizer_email,attendees_json=excluded.attendees_json,location=excluded.location,
      web_link=excluded.web_link,freshness='live',last_synced_at=excluded.last_synced_at,updated_at=excluded.updated_at`);
    for (const event of events) {
      const startAt = calendarIso(event.start); const endAt = calendarIso(event.end);
      const duration = Date.parse(endAt) - Date.parse(startAt);
      const isAllDay = Boolean(event.is_all_day ?? event.isAllDay) || (startAt.endsWith("T00:00:00.000Z") && endAt.endsWith("T00:00:00.000Z") && duration >= 86400000);
      const existing = db.prepare("SELECT id FROM calendar_events WHERE graph_id=?").get(event.id);
      const id = existing?.id || randomUUID();
      upsert.run(id,event.id,String(event.subject||"(No title)").slice(0,500),startAt,endAt,isAllDay?1:0,String(event.organizer?.name||""),String(event.organizer?.email||""),JSON.stringify(event.attendees||[]),String(event.location?.display_name||event.location?.address||""),String(event.web_link||""),now,now,now);
    }
    db.prepare("UPDATE calendar_events SET freshness='cached' WHERE last_synced_at < ?").run(started);
    ensureCompletedMeetingCards();
    db.prepare("UPDATE source_receipts SET status='ready',checked_at=?,detail=?,result=?,error='' WHERE source='calendar'").run(now,`${events.length} calendar events synchronized for the next 14 days.`,JSON.stringify({events:events.length,startIso,endIso}));
    return { status: "ready", events: events.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calendar refresh failed.";
    db.prepare(`INSERT INTO source_receipts(source,status,checked_at,detail,result,error) VALUES('calendar','error',?,'Calendar refresh failed without clearing cached events.','',?)
      ON CONFLICT(source) DO UPDATE SET status='error',checked_at=excluded.checked_at,detail=excluded.detail,error=excluded.error`).run(nowIso(),message);
    throw error;
  }
}

function queryCalendar(filters = {}) {
  const start = calendarIso(filters.start || new Date().toISOString());
  const end = calendarIso(filters.end || new Date(Date.now()+7*86400000).toISOString());
  return db.prepare("SELECT * FROM calendar_events WHERE freshness='live' AND end_at>? AND start_at<? ORDER BY start_at").all(start,end).map(mapCalendarEvent);
}

function meetingCompany(subject = "") {
  const value = String(subject).toLowerCase();
  const aliases = [
    ["avionte", ["avionte"]],
    ["stockiq", ["stockiq", "stock iq"]],
    ["govworx", ["govworx", "gov works", "govworks"]],
  ];
  return aliases.find(([, terms]) => terms.some((term) => value.includes(term)))?.[0] || "firm";
}

function existingMeetingNoteFor(event) {
  const ignored = new Set(["meeting", "notes", "follow", "with", "team", "session", "pricing", "packaging", "weekly", "planning", "jake"]);
  const tokens = [...new Set(String(event.subject || "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !ignored.has(token)))];
  if (tokens.length < 2) return null;
  const earliest = new Date(Date.parse(event.start_at) - 2 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare("SELECT * FROM notes WHERE type='meeting' AND created_at>=? ORDER BY created_at DESC LIMIT 30").all(earliest);
  const scored = rows.map((note) => {
    const text = `${note.title} ${note.body.slice(0, 1000)}`.toLowerCase();
    return { note, score: tokens.filter((token) => text.includes(token)).length };
  }).sort((a,b) => b.score - a.score);
  return scored[0]?.score >= 2 ? scored[0].note : null;
}

function ensureCompletedMeetingCards() {
  const rows = db.prepare("SELECT * FROM calendar_events WHERE freshness='live' AND end_at <= ? AND end_at >= ? ORDER BY end_at DESC")
    .all(nowIso(), new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString());
  let created = 0;
  for (const event of rows) {
    const mapped = mapCalendarEvent(event);
    if (!isEligibleCompletedMeeting(mapped, { nowMs: Date.now(), graceMs: 10 * 60_000, lookbackMs: 8 * 60 * 60_000 })) continue;
    const existingWorkflow = db.prepare("SELECT * FROM meeting_workflows WHERE calendar_event_id=?").get(event.id);
    if (existingWorkflow) {
      if (["waiting_for_transcript", "candidate_review"].includes(existingWorkflow.state)) {
        const existingNote = existingMeetingNoteFor(event);
        if (existingWorkflow.note_id && existingWorkflow.note_id !== existingNote?.id) db.prepare("DELETE FROM note_links WHERE note_id=? AND work_item_id=?").run(existingWorkflow.note_id, existingWorkflow.work_item_id);
        if (existingWorkflow.note_id !== (existingNote?.id || null)) db.prepare("UPDATE meeting_workflows SET note_id=?,updated_at=? WHERE id=?").run(existingNote?.id || null, nowIso(), existingWorkflow.id);
        if (existingNote) {
          db.prepare("INSERT OR IGNORE INTO note_links(note_id,work_item_id) VALUES(?,?)").run(existingNote.id, existingWorkflow.work_item_id);
          db.prepare("UPDATE work_items SET summary='The meeting note is already saved. Process the transcript to extract reviewable follow-up actions.',suggested_action='Process the transcript, then review the proposed follow-ups.',updated_at=? WHERE id=?").run(nowIso(), existingWorkflow.work_item_id);
        } else {
          db.prepare("UPDATE work_items SET summary='Turn the completed meeting into a durable note and reviewable follow-up actions.',suggested_action='Download the transcript, then click Process transcript.',updated_at=? WHERE id=?").run(nowIso(), existingWorkflow.work_item_id);
        }
      }
      continue;
    }
    const now = nowIso();
    const workflowId = randomUUID();
    const workItemId = randomUUID();
    const companySlug = meetingCompany(event.subject);
    const existingNote = existingMeetingNoteFor(event);
    db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,owner,due_at,source_provider,source_key,decision_state,created_at,updated_at)
      VALUES(?, 'meeting_follow_up', ?, ?, ?, ?, 'normal', 0.98, 'waiting_on_user', ?, 'Jake', ?, 'calendar', ?, 'accepted', ?, ?)`)
      .run(workItemId, companySlug, `Process transcript: ${event.subject}`.slice(0, 240), `Turn the completed meeting into a durable note and reviewable follow-up actions.`, `The meeting ended ${relativeMeetingTime(event.end_at)}. Command Center is waiting for your downloaded transcript before it does anything.`, `Download the transcript, then click Process transcript.`, event.end_at, `post-meeting:${event.graph_id}`, now, now);
    db.prepare(`INSERT INTO source_references(id,work_item_id,provider,label,source_id,source_url,retrieved_at,freshness)
      VALUES(?,?, 'calendar', ?, ?, ?, ?, ?)`)
      .run(randomUUID(), workItemId, event.subject, event.graph_id, event.web_link, event.last_synced_at || now, event.freshness);
    db.prepare(`INSERT INTO meeting_workflows(id,calendar_event_id,work_item_id,state,note_id,created_at,updated_at)
      VALUES(?,?,?,'waiting_for_transcript',?,?,?)`).run(workflowId, event.id, workItemId, existingNote?.id || null, now, now);
    if (existingNote) {
      db.prepare("INSERT OR IGNORE INTO note_links(note_id,work_item_id) VALUES(?,?)").run(existingNote.id, workItemId);
      db.prepare("UPDATE work_items SET summary='The meeting note is already saved. Process the transcript to extract reviewable follow-up actions.',suggested_action='Process the transcript, then review the proposed follow-ups.',updated_at=? WHERE id=?").run(now, workItemId);
    }
    eventFor(workItemId, "meeting_finished", "The meeting ended. Download the transcript when it is available, then process it from this card.");
    created += 1;
  }
  return created;
}

function relativeMeetingTime(value) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function mapMeetingSuggestion(row) {
  return {
    id: row.id, title: row.title, summary: row.summary, companySlug: row.company_slug,
    type: row.type, priority: row.priority, ownerState: row.owner_state,
    suggestedAction: row.suggested_action, evidenceTimestamp: row.evidence_timestamp,
    dueAt: row.due_at, existingWorkItemId: row.existing_work_item_id,
    decision: row.decision, createdWorkItemId: row.created_work_item_id,
  };
}

async function transcriptCandidatesFor(event) {
  const candidates = [];
  for (const root of [downloadsDir, transcriptInbox]) {
    let entries = [];
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(vtt|srt|txt)$/i.test(entry.name)) continue;
      const filePath = path.join(root, entry.name);
      const details = await stat(filePath).catch(() => null);
      if (!details) continue;
      const match = scoreTranscriptCandidate({ name: entry.name, mtimeMs: details.mtimeMs }, mapCalendarEvent(event));
      if (match.score < 8) continue;
      candidates.push({ path: filePath, name: entry.name, modifiedAt: details.mtime.toISOString(), size: details.size, score: match.score, reasons: match.reasons });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)).slice(0, 8);
}

async function meetingWorkflowDetail(workItemId) {
  const row = db.prepare(`SELECT mw.*, ce.graph_id,ce.subject,ce.start_at,ce.end_at,ce.organizer_name,ce.organizer_email,ce.attendees_json,ce.location,ce.web_link,
      n.title AS note_title,n.file_path AS note_file_path
    FROM meeting_workflows mw JOIN calendar_events ce ON ce.id=mw.calendar_event_id
    LEFT JOIN notes n ON n.id=mw.note_id WHERE mw.work_item_id=?`).get(workItemId);
  if (!row) return null;
  const event = { id: row.calendar_event_id, graph_id: row.graph_id, subject: row.subject, start_at: row.start_at, end_at: row.end_at, organizer_name: row.organizer_name, organizer_email: row.organizer_email, attendees_json: row.attendees_json, location: row.location, web_link: row.web_link, freshness: "live", last_synced_at: row.updated_at, is_all_day: 0 };
  return {
    id: row.id, workItemId: row.work_item_id, state: row.state, candidatePath: row.candidate_path,
    transcriptPath: row.transcript_path, noteId: row.note_id, noteTitle: row.note_title || "",
    noteFilePath: row.note_file_path || "", agentRunId: row.agent_run_id, error: row.error,
    event: mapCalendarEvent(event), candidates: await transcriptCandidatesFor(event),
    suggestions: db.prepare("SELECT * FROM meeting_action_suggestions WHERE meeting_workflow_id=? ORDER BY created_at,id").all(row.id).map(mapMeetingSuggestion),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function queryMail(filters = {}) {
  const clauses = ["1=1"];
  const params = [];
  const view = filters.view || "needs_reply";
  if (view === "needs_reply") clauses.push("m.freshness='live' AND m.reply_state='needs_reply' AND m.review_state='unreviewed' AND (m.snoozed_until IS NULL OR datetime(m.snoozed_until) <= datetime('now'))");
  if (view === "unread") clauses.push("m.freshness='live' AND m.is_read=0");
  if (view === "drafts") clauses.push("d.id IS NOT NULL");
  if (view === "snoozed") clauses.push("datetime(m.snoozed_until) > datetime('now')");
  if (filters.company && filters.company !== "all") { clauses.push("m.company_slug=?"); params.push(filters.company); }
  if (filters.search) { clauses.push("(m.subject LIKE ? OR m.sender_name LIKE ? OR m.sender_email LIKE ? OR m.preview LIKE ?)"); const term = `%${String(filters.search).slice(0, 200)}%`; params.push(term, term, term, term); }
  const limit = Math.min(200, Math.max(1, Number(filters.limit || 100)));
  const orderBy = view === "all" || view === "unread"
    ? "m.received_at DESC"
    : view === "drafts"
      ? "d.updated_at DESC,m.received_at DESC"
      : view === "snoozed"
        ? "m.snoozed_until ASC,m.received_at DESC"
        : "CASE m.importance WHEN 'high' THEN 0 ELSE 1 END,m.received_at DESC";
  return db.prepare(`${mailSelect} WHERE ${clauses.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`).all(...params, limit).map((row) => mapMail(row));
}

async function mailDetail(id) {
  let row = db.prepare(`${mailSelect} WHERE m.id=?`).get(id);
  if (!row) throw new Error("Unknown mail message.");
  if (!row.body_text) {
    const full = await fetchMailBody(row.graph_id);
    const attachments = await fetchMailAttachments(row.graph_id).catch(() => []);
    const body = full.body?.contentType?.toLowerCase() === "html" ? htmlToText(full.body.content) : String(full.body?.content || "");
    db.prepare("UPDATE mail_messages SET body_text=?,body_cached_at=?,attachments_json=?,has_attachments=?,freshness='live',last_synced_at=?,updated_at=? WHERE id=?").run(body.slice(0, 150000), nowIso(), JSON.stringify(attachments.map((item) => ({ id: item.id, name: item.name, contentType: item.contentType, size: item.size, isInline: Boolean(item.isInline) }))), attachments.length ? 1 : 0, nowIso(), nowIso(), id);
    row = db.prepare(`${mailSelect} WHERE m.id=?`).get(id);
  }
  return mapMail(row, true);
}

function projectDateAtEndOfDay(value) {
  return value ? new Date(`${value}T17:00:00-07:00`).toISOString() : null;
}

function projectHealth(projectId) {
  const today = localDateKey();
  const rows = db.prepare("SELECT status,due_date FROM project_plan_items WHERE project_id=?").all(projectId);
  const incomplete = rows.filter((item) => item.status !== "complete");
  const blocked = incomplete.filter((item) => item.status === "blocked").length;
  const overdue = incomplete.filter((item) => item.due_date && item.due_date < today).length;
  if (blocked || overdue) {
    const parts = [];
    if (overdue) parts.push(`${overdue} overdue plan ${overdue === 1 ? "item" : "items"}`);
    if (blocked) parts.push(`${blocked} blocked`);
    return { status: "at_risk", label: "At risk", reason: `${parts.join(" and ")} need attention.` };
  }
  const next = db.prepare("SELECT * FROM project_milestones WHERE project_id=? AND status!='complete' ORDER BY scheduled_date LIMIT 1").get(projectId);
  if (!next) return { status: "complete", label: "Complete", reason: "All planned milestones are complete." };
  return { status: "on_track", label: "On track", reason: `The next decision gate is ${next.title} on ${next.scheduled_date}.` };
}

function findExistingPlanAction(planItem, project, relation = "executes") {
  const linked = db.prepare(`SELECT w.* FROM project_action_links l JOIN work_items w ON w.id=l.work_item_id
    WHERE l.project_plan_item_id=? AND l.relation=? ORDER BY w.updated_at DESC LIMIT 1`).get(planItem.id,relation);
  if (linked) return linked;
  if (relation !== "executes") return null;
  let terms = [];
  try { terms = JSON.parse(planItem.dedupe_terms || "[]"); } catch { terms = []; }
  if (!terms.length) return null;
  const candidates = db.prepare(`SELECT * FROM work_items WHERE company_slug=? AND status NOT IN ('dismissed')
    AND source_key NOT LIKE 'project-plan:%' ORDER BY updated_at DESC`).all(project.company_slug);
  return candidates.find((item) => {
    const text = `${item.title}\n${item.summary}\n${item.suggested_action}`.toLowerCase();
    return terms.some((term) => text.includes(String(term).toLowerCase()));
  }) || null;
}

function linkPlanAction(planItem, project, item, detail, relation = "executes") {
  const now = nowIso();
  db.prepare("INSERT OR IGNORE INTO project_action_links(project_plan_item_id,work_item_id,relation,created_at) VALUES(?,?,?,?)").run(planItem.id,item.id,relation,now);
  db.prepare(`INSERT OR IGNORE INTO source_references(id,work_item_id,provider,label,source_id,source_path,source_url,retrieved_at,freshness)
    SELECT ?,?,'project_plan',?,?, '',?,?, 'cached'
    WHERE NOT EXISTS (SELECT 1 FROM source_references WHERE work_item_id=? AND provider='project_plan' AND source_id=?)`)
    .run(randomUUID(),item.id,`${project.title} workplan`,planItem.id,project.source_url,now,item.id,planItem.id);
  eventFor(item.id,"project_plan_linked",detail);
}

function approvedPlanPreparation(planItem, project, execution) {
  const enabled = Boolean(project.approved_at) && planItem.execution_mode !== "manual" && execution.state === "do_now" && /codex/i.test(planItem.owner_label || "");
  const instruction = `${planItem.suggested_action || `Prepare ${planItem.title} for Jake to review.`}\n\nDefinition of done: ${planItem.description || planItem.title}. Use the approved project plan and linked local sources. Produce review-ready local work only. Do not send messages or write to shared systems.`.slice(0,4000);
  return { enabled, instruction, skill: "generic-codex" };
}

function createPlanExecutionAction(planItem, project, execution) {
  const id = randomUUID();
  const now = nowIso();
  const waiting = execution.state === "waiting";
  const status = waiting ? execution.ownerState === "external" ? "waiting_external" : "waiting_on_user" : "to_review";
  const owner = execution.ownerState === "external" ? "External" : planItem.owner_label;
  const preparation = approvedPlanPreparation(planItem,project,execution);
  db.prepare(`INSERT INTO work_items
    (id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,owner,due_at,source_provider,source_key,decision_state,preparation_mode,preparation_skill,preparation_instruction,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,waiting ? "project_input" : "project_action",project.company_slug,planItem.title,planItem.description,planItem.why_now || execution.reason,planItem.priority,0.95,status,planItem.suggested_action,owner,projectDateAtEndOfDay(planItem.due_date),"project_plan",`project-plan:${planItem.id}`,waiting || preparation.enabled ? "accepted" : "proposed",preparation.enabled ? "auto" : "manual",preparation.enabled ? preparation.skill : "",preparation.enabled ? preparation.instruction : "",now,now);
  linkPlanAction(planItem,project,{ id },`Surfaced by the execution engine: ${execution.reason}`);
  return db.prepare("SELECT * FROM work_items WHERE id=?").get(id);
}

function ensureProjectFollowUp(planItem, project, today) {
  const bucket = projectFollowUpBucket(planItem,today);
  if (bucket === null) return null;
  const canonical = findExistingPlanAction(planItem,project,"executes");
  if (canonical) return canonical;
  const sourceKey = `project-follow-up:${planItem.id}`;
  let item = db.prepare(`SELECT * FROM work_items WHERE source_provider='project_plan'
    AND (source_key=? OR source_key LIKE ?) ORDER BY updated_at DESC LIMIT 1`).get(sourceKey,`${sourceKey}:%`);
  if (item) return item;
  const id = randomUUID();
  const now = nowIso();
  db.prepare(`INSERT INTO work_items
    (id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,owner,due_at,source_provider,source_key,decision_state,created_at,updated_at)
    VALUES(?,'project_follow_up',?,?,?,?,?,0.98,'to_review',?,'Jake',?,'project_plan',?,'proposed',?,?)`)
    .run(id,project.company_slug,`Follow up: ${planItem.title}`,`The project is still waiting on ${planItem.owner_label}.`,`${planItem.title} was due ${planItem.due_date} and still blocks the approved plan.`,planItem.priority === "low" ? "normal" : planItem.priority,planItem.suggested_action || `Follow up with ${planItem.owner_label}.`,projectDateAtEndOfDay(today),sourceKey,now,now);
  linkPlanAction(planItem,project,{ id },`Created a dated follow-up because the external input is still outstanding.`,"follow_up");
  return db.prepare("SELECT * FROM work_items WHERE id=?").get(id);
}

function reconcileProject(projectId) {
  const project = db.prepare("SELECT * FROM projects WHERE id=? AND status='active'").get(projectId);
  if (!project) return null;
  const today = localDateKey();
  const planItems = db.prepare("SELECT * FROM project_plan_items WHERE project_id=? ORDER BY sort_order").all(projectId);
  for (const planItem of planItems) {
    const execution = classifyProjectPlanItem(planItem,planItems,today);
    let linked = findExistingPlanAction(planItem,project,"executes");
    if (linked && !db.prepare("SELECT 1 FROM project_action_links WHERE project_plan_item_id=? AND work_item_id=?").get(planItem.id,linked.id)) {
      linkPlanAction(planItem,project,linked,`Linked to ${project.title}: ${planItem.title}.`);
    }
    if (linked?.status === "done" && planItem.status !== "complete") {
      db.prepare("UPDATE project_plan_items SET status='complete',updated_at=? WHERE id=?").run(nowIso(),planItem.id);
      continue;
    }
    if (planItem.status === "complete") {
      const linkedActions = db.prepare(`SELECT w.* FROM project_action_links l JOIN work_items w ON w.id=l.work_item_id WHERE l.project_plan_item_id=?`).all(planItem.id);
      for (const linkedAction of linkedActions) if (!["done","dismissed"].includes(linkedAction.status)) {
        const now = nowIso();
        db.prepare("UPDATE work_items SET status='done',resolution=?,resolved_at=?,updated_at=? WHERE id=?")
          .run(`Completed through the ${project.title} project plan.`,now,now,linkedAction.id);
        eventFor(linkedAction.id,"project_plan_complete",`Marked complete from the project plan: ${planItem.title}.`);
      }
      continue;
    }
    if (["do_now","waiting"].includes(execution.state) && !linked) linked = createPlanExecutionAction(planItem,project,execution);
    if (linked && !linked.due_at && planItem.due_date) db.prepare("UPDATE work_items SET due_at=?,updated_at=? WHERE id=?").run(projectDateAtEndOfDay(planItem.due_date),nowIso(),linked.id);
    const preparation = approvedPlanPreparation(planItem,project,execution);
    if (linked && preparation.enabled && linked.source_provider === "project_plan" && !["done","dismissed","working","queued"].includes(linked.status) && (linked.decision_state !== "accepted" || linked.preparation_mode !== "auto")) {
      db.prepare("UPDATE work_items SET decision_state='accepted',preparation_mode='auto',preparation_skill=?,preparation_instruction=?,updated_at=? WHERE id=?").run(preparation.skill,preparation.instruction,nowIso(),linked.id);
      eventFor(linked.id,"pm_autonomy_enabled",`Approved project-plan preparation can start automatically: ${planItem.title}.`);
      linked = db.prepare("SELECT * FROM work_items WHERE id=?").get(linked.id);
    }
    if (linked && execution.state === "waiting" && execution.ownerState === "external" && linked.source_provider === "project_plan" && linked.status === "to_review" && linked.decision_state === "proposed") {
      db.prepare("UPDATE work_items SET status='waiting_external',decision_state='accepted',owner='External',updated_at=? WHERE id=?").run(nowIso(),linked.id);
      eventFor(linked.id,"waiting_external",`Waiting on ${planItem.owner_label} according to the approved project plan.`);
    }
    ensureProjectFollowUp(planItem,project,today);
  }
  return projectDetail(projectId,{ reconcile: false });
}

function projectDetail(projectId, options = {}) {
  if (options.reconcile !== false) reconcileProject(projectId);
  const project = db.prepare(`SELECT p.*,c.display_name AS company_name FROM projects p JOIN companies c ON c.slug=p.company_slug WHERE p.id=?`).get(projectId);
  if (!project) return null;
  const phases = db.prepare("SELECT * FROM project_phases WHERE project_id=? ORDER BY sort_order").all(projectId).map((phase) => ({
    id: phase.id, title: phase.title, summary: phase.summary, startDate: phase.start_date, endDate: phase.end_date, status: phase.status,
  }));
  const milestones = db.prepare("SELECT * FROM project_milestones WHERE project_id=? ORDER BY sort_order").all(projectId).map((milestone) => ({
    id: milestone.id, title: milestone.title, scheduledDate: milestone.scheduled_date, decision: milestone.decision, status: milestone.status,
  }));
  const rawPlanItems = db.prepare(`SELECT pi.*,ph.title AS phase_title FROM project_plan_items pi
    LEFT JOIN project_phases ph ON ph.id=pi.phase_id WHERE pi.project_id=? ORDER BY pi.sort_order`).all(projectId);
  const executionGuide = projectExecutionGuidance(rawPlanItems,localDateKey());
  const links = db.prepare(`SELECT l.project_plan_item_id,l.relation,w.id,w.status,w.decision_state,w.updated_at
    FROM project_action_links l JOIN work_items w ON w.id=l.work_item_id
    JOIN project_plan_items pi ON pi.id=l.project_plan_item_id WHERE pi.project_id=? ORDER BY w.updated_at DESC`).all(projectId);
  const planItems = executionGuide.items.map((item) => {
    const itemLinks = links.filter((link) => link.project_plan_item_id === item.id);
    const executionAction = itemLinks.find((link) => link.relation === "executes") || null;
    const linkedFollowUp = itemLinks.find((link) => link.relation === "follow_up" && !["done","dismissed"].includes(link.status)) || null;
    const followUpAction = linkedFollowUp || (projectFollowUpBucket(item,localDateKey()) !== null && executionAction && !["done","dismissed"].includes(executionAction.status) ? executionAction : null);
    return {
      id: item.id, phaseId: item.phase_id, phaseTitle: item.phase_title || "", workstream: item.workstream, title: item.title,
      description: item.description, owner: item.owner_label, startDate: item.start_date, dueDate: item.due_date, status: item.status,
      suggestedAction: item.suggested_action, whyNow: item.why_now, priority: item.priority, dependsOn: parseDependencies(item.depends_on),
      executionState: item.execution.state, executionReason: item.execution.reason, ownerState: item.execution.ownerState,
      blockedBy: item.execution.blockedBy, daysUntilDue: item.execution.daysUntilDue,
      workItemId: executionAction?.id || null, workItemStatus: executionAction?.status || null, workItemDecision: executionAction?.decision_state || null,
      followUpWorkItemId: followUpAction?.id || null,
    };
  });
  const activePhase = phases.find((phase) => phase.status === "active") || phases.find((phase) => phase.status !== "complete") || null;
  const nextMilestone = milestones.find((milestone) => milestone.status !== "complete") || null;
  const completed = planItems.filter((item) => item.status === "complete").length;
  const doNow = planItems.filter((item) => item.executionState === "do_now");
  for (const waitingItem of planItems.filter((item) => item.executionState === "waiting" && item.followUpWorkItemId)) {
    doNow.push({ ...waitingItem, guidanceKind: "follow_up", title: `Follow up: ${waitingItem.title}`, executionReason: `${waitingItem.title} is still outstanding and now needs a follow-up.`, workItemId: waitingItem.followUpWorkItemId });
  }
  const waiting = planItems.filter((item) => item.executionState === "waiting");
  const upNext = planItems.filter((item) => item.executionState === "up_next").sort((a,b) => String(a.startDate || a.dueDate || "9999").localeCompare(String(b.startDate || b.dueDate || "9999")));
  return {
    id: project.id, companySlug: project.company_slug, companyName: project.company_name, title: project.title, objective: project.objective,
    status: project.status, startDate: project.start_date, targetDate: project.target_date, source: { provider: project.source_provider, id: project.source_id, label: project.source_label, url: project.source_url },
    approvedAt: project.approved_at, health: projectHealth(project.id), activePhase, nextMilestone, phases, milestones, planItems,
    progress: { completed, total: planItems.length, percent: planItems.length ? Math.round((completed / planItems.length) * 100) : 0 },
    guidance: { doNow, waiting, upNext },
    stayAhead: [...doNow,...waiting].filter((item,index,array) => item.workItemId && array.findIndex((candidate) => candidate.id === item.id && candidate.workItemId === item.workItemId) === index),
  };
}

function queryProjects() {
  return db.prepare("SELECT id FROM projects WHERE status!='archived' ORDER BY target_date").all().map((row) => projectDetail(row.id));
}

function reconcileAllProjects() {
  for (const row of db.prepare("SELECT id FROM projects WHERE status='active'").all()) reconcileProject(row.id);
}

function sourceReceipts() {
  return db.prepare("SELECT * FROM source_receipts ORDER BY source").all().map((row) => ({
    source: row.source,
    status: row.status,
    checkedAt: row.checked_at,
    detail: row.detail,
    result: row.result,
    error: row.error,
  }));
}

function bootstrapPayload(filters = {}) {
  ensureCompletedMeetingCards();
  const companies = db.prepare("SELECT * FROM companies WHERE active = 1 ORDER BY display_name").all().map(mapCompany);
  const items = queryWorkItems(filters);
  const counts = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS count FROM work_items GROUP BY status").all().map((row) => [row.status, row.count]),
  );
  const companyCounts = Object.fromEntries(
    db.prepare("SELECT company_slug, COUNT(*) AS count FROM work_items WHERE status NOT IN ('done','dismissed') GROUP BY company_slug").all().map((row) => [row.company_slug, row.count]),
  );
  const mailCounts = {
    all: db.prepare("SELECT COUNT(*) AS count FROM mail_messages").get().count,
    needs_reply: db.prepare("SELECT COUNT(*) AS count FROM mail_messages WHERE freshness='live' AND reply_state='needs_reply' AND review_state='unreviewed' AND (snoozed_until IS NULL OR datetime(snoozed_until) <= datetime('now'))").get().count,
    unread: db.prepare("SELECT COUNT(*) AS count FROM mail_messages WHERE freshness='live' AND is_read=0").get().count,
    drafts: db.prepare("SELECT COUNT(*) AS count FROM mail_drafts").get().count,
    snoozed: db.prepare("SELECT COUNT(*) AS count FROM mail_messages WHERE datetime(snoozed_until) > datetime('now')").get().count,
  };
  return {
    generatedAt: nowIso(),
    companies,
    items,
    counts,
    companyCounts,
    mailCounts,
    sources: sourceReceipts(),
    dailyNote: ensureDailyNote(),
    runner: { status: "ready", activeJobs: activeProcesses.size },
  };
}

async function resolveCodexCli() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  const configPath = path.join(homedir(), ".codex", "config.toml");
  const config = await readFile(configPath, "utf8");
  const match = config.match(/^CODEX_CLI_PATH\s*=\s*['\"]([^'\"]+)['\"]/m);
  if (!match) throw new Error("CODEX_CLI_PATH is not configured.");
  return match[1];
}

const sourcePrompts = {
  outlook: `Use the Serent Command Center MCP route to inspect recent Serent Inbox and Sent Items. Identify only consequential messages that likely require Jake's attention.`,
  calendar: `Use the Serent Command Center MCP route to inspect today's and tomorrow's calendar. Identify meetings needing preparation, notes, transcript follow-through, or a decision.`,
  clickup: `Read ClickUp Next Actions list 901114003532. Exclude completed tasks and identify overdue, due-soon, blocked, or materially changed actions.`,
  transcripts: `Inspect only the local transcript index.csv, manifest.jsonl, and transcript inbox. Identify newly routed transcripts, meetings missing a transcript, and follow-through that needs review.`,
  box: `Inspect only meaningful changes in currently active Pricing CoE company project folders under Box Growth Team / 32. Pricing. Ignore routine file churn. Identify new or changed artifacts that create a decision, follow-up, or review need.`,
};

function sourceOutputContract(source) {
  const existingKeys = db.prepare("SELECT source_key FROM work_items WHERE source_provider=? AND status NOT IN ('done','dismissed') AND source_key<>'' LIMIT 100").all(source).map((row) => row.source_key);
  const reconciliation = existingKeys.length ? ` Re-check these currently active local source keys and return any that are now complete or no longer active with resolutionState=resolved: ${existingKeys.join(", ")}.` : "";
  if (source === "box") {
    const registeredProjects = db.prepare("SELECT company_slug,title,source_id,source_label FROM projects WHERE status='active' AND source_provider='box'").all();
    return `${sourcePrompts[source]} Registered active project baselines: ${JSON.stringify(registeredProjects)}. For an approved kickoff deck or workplan that is new or materially changed, compile it through an execution lens. Preserve every meaningful deliverable, input, analysis, decision gate, and owner; break broad rows into concrete leaf actions; infer dependencies; and distinguish Jake-owned work from external inputs. Return one JSON object only: {"summary":"coverage note","items":[{"sourceKey":"stable source id","resolutionState":"active|resolved","companySlug":"known company slug or null","type":"decision|follow_up|research|artifact","title":"action title","summary":"what changed","whyNow":"why it matters","priority":"urgent|high|normal|low","confidence":0.0,"suggestedAction":"next action","sourceLabel":"evidence label","sourceUrl":"Box link"}],"projects":[{"approved":true,"sourceId":"Box file id","sourceLabel":"file name","sourceUrl":"Box link","companySlug":"known company slug","projectKey":"stable short key","title":"project title","objective":"outcome","startDate":"YYYY-MM-DD","targetDate":"YYYY-MM-DD","phases":[{"sourceKey":"stable phase key","title":"phase","summary":"purpose","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","status":"planned|active|complete"}],"milestones":[{"sourceKey":"stable milestone key","title":"decision gate","scheduledDate":"YYYY-MM-DD","decision":"decision required","status":"upcoming|complete"}],"planItems":[{"sourceKey":"stable item key","phaseKey":"phase key","workstream":"workstream","title":"one concrete executable step","description":"definition of done or required output","owner":"Jake, Jake + Codex, or named external owner","startDate":"YYYY-MM-DD","dueDate":"YYYY-MM-DD","status":"planned|active|blocked|complete","suggestedAction":"literal next move","whyNow":"dependency or deadline reason","priority":"high|normal|low","dependsOn":["other item source keys"],"surfaceDays":21,"followUpDays":3}]}]}. Only include projects when the underlying plan is approved and source-backed. Read only; do not alter Box.`;
  }
  return `${sourcePrompts[source]}${reconciliation} Return one JSON object only with this shape: {"summary":"coverage note","items":[{"sourceKey":"stable source id","resolutionState":"active|resolved","companySlug":"one of avionte, stockiq, govworx, firm or null","type":"email|meeting|task|decision|follow_up|research|artifact","title":"short action-oriented title","summary":"what happened","whyNow":"why it matters now","priority":"urgent|high|normal|low","confidence":0.0,"suggestedAction":"next action","sourceLabel":"human-readable evidence","sourcePath":"optional local path","sourceUrl":"optional source link"}]}. Use an empty items array when nothing consequential changed. Read only. Do not send, create, update, move, or delete anything.`;
}

function parseAgentJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function upsertNormalizedItems(source, payload) {
  if (!payload || !Array.isArray(payload.items)) return 0;
  let changed = 0;
  for (const item of payload.items.slice(0, 30)) {
    if (!item?.sourceKey || !item?.title || !item?.summary) continue;
    const existing = db.prepare("SELECT * FROM work_items WHERE source_provider = ? AND source_key = ?").get(source, String(item.sourceKey));
    const id = existing?.id || randomUUID();
    const now = nowIso();
    if (item.resolutionState === "resolved" && existing) {
      if (!["done","dismissed"].includes(existing.status)) {
        db.prepare("UPDATE work_items SET status='done',resolution=?,resolved_at=?,updated_at=? WHERE id=?").run(`Resolved in ${source} and verified during source refresh.`,now,now,id);
        eventFor(id,"source_resolved",`The ${source} source now reports this item resolved.`);
        changed += 1;
      }
      continue;
    }
    const company = item.companySlug && db.prepare("SELECT slug FROM companies WHERE slug = ?").get(item.companySlug) ? item.companySlug : null;
    const next = {
      type: String(item.type || "follow_up").slice(0,120),
      title: String(item.title).slice(0,240),
      summary: String(item.summary).slice(0,1600),
      whyNow: String(item.whyNow || "Changed source requires review.").slice(0,1200),
      priority: ["urgent","high","normal","low"].includes(item.priority) ? item.priority : "normal",
      confidence: Math.min(1,Math.max(0,Number(item.confidence ?? 0.7))),
      suggestedAction: String(item.suggestedAction || "Review the source change.").slice(0,1200),
    };
    if (existing) {
      const materiallyChanged = existing.type !== next.type || existing.company_slug !== company || existing.title !== next.title || existing.summary !== next.summary || existing.why_now !== next.whyNow || existing.priority !== next.priority || Number(existing.confidence) !== next.confidence || existing.suggested_action !== next.suggestedAction;
      db.prepare(`UPDATE work_items SET type=?, company_slug=?, title=?, summary=?, why_now=?, priority=?, confidence=?,
        suggested_action=?,status=CASE WHEN ? AND status IN ('done','dismissed') THEN 'to_review' ELSE status END,
        resolved_at=CASE WHEN ? AND status IN ('done','dismissed') THEN NULL ELSE resolved_at END,updated_at=? WHERE id=?`).run(next.type, company, next.title, next.summary, next.whyNow, next.priority, next.confidence, next.suggestedAction, materiallyChanged ? 1 : 0, materiallyChanged ? 1 : 0, now, id);
      if (materiallyChanged) { eventFor(id, "changed", `Updated by the ${source} pulse.`); changed += 1; }
    } else {
      db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,source_provider,source_key,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?, 'to_review', ?,?,?,?,?)`).run(id, next.type, company, next.title, next.summary, String(item.whyNow || "New source activity requires review.").slice(0,1200), next.priority, next.confidence, next.suggestedAction, source, String(item.sourceKey), now, now);
      eventFor(id, "created", `Created by the ${source} pulse.`);
      changed += 1;
    }
    if (source === "clickup") db.prepare("UPDATE work_items SET decision_state='committed' WHERE id=?").run(id);
    db.prepare("DELETE FROM source_references WHERE work_item_id = ? AND provider = ?").run(id, source);
    db.prepare(`INSERT INTO source_references(id,work_item_id,provider,label,source_id,source_path,source_url,retrieved_at,freshness)
      VALUES(?,?,?,?,?,?,?,?, 'live')`).run(randomUUID(), id, source, String(item.sourceLabel || source), String(item.sourceKey), String(item.sourcePath || ""), String(item.sourceUrl || ""), now);
  }
  return changed;
}

function sourceDate(value) {
  const next = String(value || "").slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(next) ? next : null;
}

function upsertSourceProjects(source, payload) {
  if (source !== "box" || !Array.isArray(payload?.projects)) return 0;
  let changed = 0;
  for (const incoming of payload.projects.slice(0,10)) {
    if (incoming?.approved !== true || !incoming.sourceId || !incoming.companySlug || !incoming.title || !Array.isArray(incoming.planItems)) continue;
    const company = db.prepare("SELECT slug FROM companies WHERE slug=?").get(String(incoming.companySlug));
    if (!company) continue;
    const sourceId = String(incoming.sourceId).slice(0,240);
    const existing = db.prepare("SELECT * FROM projects WHERE source_provider=? AND source_id=?").get(source,sourceId);
    const projectId = existing?.id || `${safeSegment(incoming.companySlug)}-${safeSegment(incoming.projectKey || sourceId)}-project`;
    const now = nowIso();
    if (existing) {
      db.prepare(`UPDATE projects SET company_slug=?,title=?,objective=?,start_date=?,target_date=?,source_label=?,source_url=?,updated_at=? WHERE id=?`)
        .run(company.slug,String(incoming.title).slice(0,240),String(incoming.objective || "").slice(0,2000),sourceDate(incoming.startDate),sourceDate(incoming.targetDate),String(incoming.sourceLabel || incoming.title).slice(0,500),String(incoming.sourceUrl || `https://app.box.com/file/${sourceId}`).slice(0,1000),now,projectId);
    } else {
      db.prepare(`INSERT INTO projects(id,company_slug,title,objective,status,start_date,target_date,source_provider,source_id,source_label,source_url,approved_at,created_at,updated_at)
        VALUES(?,?,?,?,'active',?,?,?,?,?,?,?, ?,?)`).run(projectId,company.slug,String(incoming.title).slice(0,240),String(incoming.objective || "").slice(0,2000),sourceDate(incoming.startDate),sourceDate(incoming.targetDate),source,sourceId,String(incoming.sourceLabel || incoming.title).slice(0,500),String(incoming.sourceUrl || `https://app.box.com/file/${sourceId}`).slice(0,1000),now,now,now);
    }

    const phaseIds = new Map();
    for (const [index,phase] of (incoming.phases || []).slice(0,30).entries()) {
      if (!phase?.title) continue;
      const key = safeSegment(phase.sourceKey || phase.title,`phase-${index+1}`);
      const id = `${projectId}-${key}`;
      phaseIds.set(String(phase.sourceKey || phase.title),id);
      db.prepare(`INSERT INTO project_phases(id,project_id,title,summary,start_date,end_date,status,sort_order,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,summary=excluded.summary,start_date=excluded.start_date,end_date=excluded.end_date,status=CASE WHEN project_phases.status='complete' THEN 'complete' ELSE excluded.status END,sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
        .run(id,projectId,String(phase.title).slice(0,240),String(phase.summary || "").slice(0,1600),sourceDate(phase.startDate),sourceDate(phase.endDate),["planned","active","complete"].includes(phase.status) ? phase.status : "planned",index+1,now,now);
    }
    for (const [index,milestone] of (incoming.milestones || []).slice(0,30).entries()) {
      if (!milestone?.title) continue;
      const id = `${projectId}-${safeSegment(milestone.sourceKey || milestone.title,`milestone-${index+1}`)}`;
      db.prepare(`INSERT INTO project_milestones(id,project_id,title,scheduled_date,decision,status,sort_order,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,scheduled_date=excluded.scheduled_date,decision=excluded.decision,status=CASE WHEN project_milestones.status='complete' THEN 'complete' ELSE excluded.status END,sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
        .run(id,projectId,String(milestone.title).slice(0,240),sourceDate(milestone.scheduledDate),String(milestone.decision || "").slice(0,1600),milestone.status === "complete" ? "complete" : "upcoming",index+1,now,now);
    }
    const itemIds = new Map((incoming.planItems || []).slice(0,100).map((item,index) => [String(item.sourceKey || item.title),`${projectId}-${safeSegment(item.sourceKey || item.title,`item-${index+1}`)}`]));
    for (const [index,item] of incoming.planItems.slice(0,100).entries()) {
      if (!item?.title) continue;
      const itemKey = String(item.sourceKey || item.title);
      const id = itemIds.get(itemKey);
      const dependencies = Array.isArray(item.dependsOn) ? item.dependsOn.map((dependency) => itemIds.get(String(dependency))).filter(Boolean) : [];
      const phaseId = phaseIds.get(String(item.phaseKey || "")) || null;
      const status = ["planned","active","blocked","complete"].includes(item.status) ? item.status : "planned";
      db.prepare(`INSERT INTO project_plan_items(id,project_id,phase_id,workstream,title,description,owner_label,start_date,due_date,status,suggested_action,why_now,priority,create_action,surface_days,dedupe_terms,sort_order,created_at,updated_at,depends_on,execution_mode,follow_up_days)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,'[]',?,?,?,?, 'auto',?)
        ON CONFLICT(id) DO UPDATE SET phase_id=excluded.phase_id,workstream=excluded.workstream,title=excluded.title,description=excluded.description,owner_label=excluded.owner_label,start_date=excluded.start_date,due_date=excluded.due_date,status=CASE WHEN project_plan_items.status='complete' THEN 'complete' ELSE excluded.status END,suggested_action=excluded.suggested_action,why_now=excluded.why_now,priority=excluded.priority,surface_days=excluded.surface_days,sort_order=excluded.sort_order,depends_on=excluded.depends_on,execution_mode='auto',follow_up_days=excluded.follow_up_days,updated_at=excluded.updated_at`)
        .run(id,projectId,phaseId,String(item.workstream || "Project execution").slice(0,240),String(item.title).slice(0,240),String(item.description || "").slice(0,2400),String(item.owner || "Jake").slice(0,240),sourceDate(item.startDate),sourceDate(item.dueDate),status,String(item.suggestedAction || `Begin ${item.title}.`).slice(0,1600),String(item.whyNow || "Required by the approved project plan.").slice(0,1600),["high","normal","low"].includes(item.priority) ? item.priority : "normal",Math.max(1,Number(item.surfaceDays || 21)),index+1,now,now,JSON.stringify(dependencies),Math.max(1,Number(item.followUpDays || 3)));
    }
    changed += 1;
  }
  if (changed) reconcileAllProjects();
  return changed;
}

function routeById(id) {
  return db.prepare("SELECT * FROM skill_routes WHERE id=? AND enabled=1").get(id);
}

function resolveSkillRoute({ item = null, mail = null, override = "" } = {}) {
  if (override) {
    const selected = routeById(override);
    if (!selected) throw new Error("The selected skill route is not enabled.");
    return selected;
  }
  if (mail || item?.type === "email") return routeById("draft-executive-email");
  const type = String(item?.type || "").toLowerCase();
  const title = String(item?.title || "").toLowerCase();
  const explicitTranscriptTask = ["transcript", "meeting_transcript"].includes(type)
    || /\bwaiting\s+(?:on|for)\s+(?:the\s+)?transcript\b/.test(title)
    || /\b(?:download|process|route|file|save)\b.{0,32}\btranscript\b|\btranscript\b.{0,32}\b(?:download|process|route|file|save)\b/.test(title);
  if (explicitTranscriptTask) return routeById("zoom-transcript-router");
  const text = `${type} ${title}`;
  if (text.includes("morning") || text.includes("daily priorit")) return routeById("morning-briefing");
  return routeById("generic-codex");
}

function contextualNotes({ workItemId = null, mailMessageId = null, companySlug = null }) {
  const rows = [];
  if (workItemId) rows.push(...db.prepare(`SELECT n.* FROM notes n JOIN note_links l ON l.note_id=n.id WHERE l.work_item_id=?`).all(workItemId));
  if (mailMessageId) rows.push(...db.prepare(`SELECT n.* FROM notes n JOIN mail_note_links l ON l.note_id=n.id WHERE l.mail_message_id=?`).all(mailMessageId));
  if (companySlug) rows.push(...db.prepare("SELECT * FROM notes WHERE company_slug=? AND type IN ('project','decision') ORDER BY updated_at DESC LIMIT 12").all(companySlug));
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function delegationPreview({ workItemId = null, mailMessageId = null, skillId = "" }) {
  const item = workItemId ? db.prepare("SELECT * FROM work_items WHERE id=?").get(workItemId) : null;
  const mail = mailMessageId ? db.prepare("SELECT * FROM mail_messages WHERE id=?").get(mailMessageId) : null;
  if (workItemId && !item) throw new Error("Unknown work item.");
  if (mailMessageId && !mail) throw new Error("Unknown mail message.");
  const route = resolveSkillRoute({ item, mail, override: skillId });
  const companySlug = mail?.company_slug || item?.company_slug || null;
  const notes = contextualNotes({ workItemId, mailMessageId, companySlug });
  const rules = activeRules({ companySlug, source: mail ? "outlook" : item?.source_provider, workType: mail ? "email" : item?.type, skillId: route.id });
  const sources = workItemId ? db.prepare("SELECT provider,label,source_id FROM source_references WHERE work_item_id=?").all(workItemId) : [{ provider: "outlook", label: mail?.subject || "Mail", source_id: mail?.graph_id || "" }];
  const missing = [];
  if (route.id === "zoom-transcript-router") missing.push("A downloaded .vtt, .srt, or transcript-like .txt file is required before routing can finish.");
  return {
    selectedSkill: { id: route.id, label: route.label, description: route.description, executorType: route.executor_type, expectedOutput: route.expected_output },
    availableSkills: db.prepare("SELECT * FROM skill_routes WHERE enabled=1 ORDER BY CASE id WHEN 'generic-codex' THEN 1 ELSE 0 END,label").all().map((row) => ({ id: row.id, label: row.label, description: row.description, executorType: row.executor_type, expectedOutput: row.expected_output })),
    contextManifest: { workItemId, mailMessageId, companySlug, noteIds: notes.map((note) => note.id), sourceRefs: sources, ruleIds: rules.map((rule) => rule.id) },
    contextSummary: [`${notes.length} relevant note${notes.length === 1 ? "" : "s"}`, `${sources.length} source reference${sources.length === 1 ? "" : "s"}`, `${rules.length} active rule${rules.length === 1 ? "" : "s"}`],
    missingPrerequisites: missing,
  };
}

async function launchNoteEditProposal(note, instruction) {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(`INSERT INTO note_edit_proposals(id,note_id,instruction,status,created_at,updated_at)
    VALUES(?,?,?,'working',?,?)`).run(id, note.id, instruction, now, now);
  const company = note.company_slug ? db.prepare("SELECT * FROM companies WHERE slug=?").get(note.company_slug) : null;
  const cli = await resolveCodexCli();
  const args = ["exec", "--json", "-c", 'approval_policy="never"', "-C", aiOsRoot, "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-"];
  const child = spawn(cli, args, { cwd: aiOsRoot, env: process.env, windowsHide: true });
  activeProcesses.set(id, child);
  let buffer = ""; let finalMessage = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
    for (const line of lines) try { const event = JSON.parse(line); if (event.type === "item.completed" && event.item?.type === "agent_message") finalMessage = event.item.text || ""; } catch { }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  child.stdin.end(`Edit a shared Serent Command Center Markdown document. Use available AI OS and project context only when it materially improves the requested edit. Do not modify any files or external systems. Return one JSON object only: {"title":"document title","body":"complete revised Markdown body without the title heading","summary":"brief description of changes","sources":["source labels used"]}.\n\nCompany: ${company?.display_name || "Unfiled"}\nDocument title: ${note.title}\nCurrent Markdown:\n${note.body}\n\nJake's requested edit: ${instruction}`);
  child.on("close", (code) => {
    activeProcesses.delete(id); const finished = nowIso(); const parsed = parseAgentJson(finalMessage);
    if (code === 0 && parsed && typeof parsed.body === "string") {
      db.prepare("UPDATE note_edit_proposals SET proposed_title=?,proposed_body=?,summary=?,status='ready',updated_at=? WHERE id=?")
        .run(String(parsed.title || note.title).slice(0,240), String(parsed.body).slice(0,100000), String(parsed.summary || "Codex proposed an edit.").slice(0,2000), finished, id);
    } else {
      db.prepare("UPDATE note_edit_proposals SET status='error',error=?,updated_at=? WHERE id=?").run(stderr.trim() || "Codex did not return a valid Markdown revision.", finished, id);
    }
  });
  return mapNote(db.prepare("SELECT * FROM notes WHERE id=?").get(note.id));
}

function clickUpTargetFor(item) {
  const source = db.prepare("SELECT source_id,source_url FROM source_references WHERE work_item_id=? AND provider='clickup' ORDER BY retrieved_at DESC LIMIT 1").get(item.id);
  const fromUrl = String(source?.source_url || "").match(/\/t\/([a-zA-Z0-9_-]+)/)?.[1];
  const candidate = source?.source_id || fromUrl || "";
  return /^[a-zA-Z0-9_-]{4,80}$/.test(String(candidate || "")) ? String(candidate) : "";
}

async function launchClickUpCompletion(item) {
  const targetId = clickUpTargetFor(item);
  if (!targetId) throw new Error("This card is not linked to a usable ClickUp task ID yet.");
  const id = randomUUID(); const now = nowIso();
  db.prepare(`INSERT INTO external_actions(id,work_item_id,provider,action_type,target_id,status,created_at,updated_at)
    VALUES(?,?, 'clickup','complete_task',?,'working',?,?)`).run(id, item.id, targetId, now, now);
  eventFor(item.id, "external_action_started", `Completing ClickUp task ${targetId}.`);
  const cli = await resolveCodexCli();
  const args = ["exec", "--json", "-c", 'approval_policy="never"', "-C", aiOsRoot, "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-"];
  const child = spawn(cli, args, { cwd: aiOsRoot, env: process.env, windowsHide: true });
  activeProcesses.set(id, child);
  let buffer=""; let finalMessage=""; let stderr="";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { buffer += chunk; const lines=buffer.split(/\r?\n/); buffer=lines.pop()||""; for(const line of lines) try { const event=JSON.parse(line); if(event.type==="item.completed"&&event.item?.type==="agent_message") finalMessage=event.item.text||""; } catch {} });
  child.stderr.on("data", (chunk) => { stderr=`${stderr}${chunk}`.slice(-8000); });
  child.stdin.end(`Jake explicitly clicked Done in ClickUp in Serent Command Center. Use the installed ClickUp connector to update only task ${targetId}. Set its status to complete. Do not change any other field or system. Then read that exact task back from ClickUp. Return one JSON object only: {"verified":true,"taskId":"${targetId}","status":"complete","receipt":"one sentence receipt"}. If the update or readback fails, return {"verified":false,"taskId":"${targetId}","status":"unknown","error":"reason"}.`);
  child.on("close", (code) => {
    activeProcesses.delete(id); const finished=nowIso();
    const verified = parseAgentJson(finalMessage);
    if(code===0 && verified?.verified === true && String(verified.taskId) === targetId && String(verified.status).toLowerCase() === "complete") {
      const receipt=String(verified.receipt||`ClickUp task ${targetId} verified complete.`).slice(0,4000);
      db.prepare("UPDATE external_actions SET status='complete',receipt=?,updated_at=? WHERE id=?").run(receipt,finished,id);
      db.prepare("UPDATE work_items SET status='done',resolution=?,resolved_at=?,updated_at=? WHERE id=?").run(`Completed in ClickUp: ${receipt}`.slice(0,4000),finished,finished,item.id);
      eventFor(item.id,"completed_in_clickup",receipt.slice(0,1200));
    } else {
      const error=String(verified?.error||stderr.trim()||"ClickUp completion could not be verified by readback.").slice(0,4000);
      db.prepare("UPDATE external_actions SET status='error',error=?,updated_at=? WHERE id=?").run(error,finished,id);
      eventFor(item.id,"external_action_error",error.slice(0,1200));
    }
  });
  return { id, status: "working", targetId };
}

async function relevantTranscriptPaths(companySlug, query = "") {
  const companiesDir = path.join(transcriptRoot, "companies");
  try {
    const entries = await readdir(companiesDir, { recursive: true, withFileTypes: true });
    const paths = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".summary.md")).map((entry) => path.join(entry.parentPath || entry.path || companiesDir, entry.name));
    const terms=[...new Set(String(query).toLowerCase().split(/[^a-z0-9]+/).filter((term)=>term.length>=5&&!['prepare','meeting','agenda','separate','codex','documents'].includes(term)))];
    const scored=[];
    for(const filePath of paths){
      const content=(await readFile(filePath,"utf8").catch(()=>"")).slice(0,40000).toLowerCase();
      const normalized=filePath.toLowerCase();
      const score=(companySlug&&normalized.includes(`${path.sep}${companySlug}${path.sep}`)?4:0)+terms.reduce((total,term)=>total+(content.includes(term)||normalized.includes(term)?1:0),0);
      if(score>0)scored.push({filePath,score});
    }
    return scored.sort((a,b)=>b.score-a.score||b.filePath.localeCompare(a.filePath)).slice(0,6).map((item)=>item.filePath);
  } catch { return []; }
}

function mapPmConfig(row) {
  return {
    mode: row?.mode || "observer",
    enabled: Boolean(row?.enabled),
    morningTime: row?.morning_time || "08:00",
    pulseMinutes: Number(row?.pulse_minutes || 30),
    maxConcurrent: Number(row?.max_concurrent || 2),
    lastRunAt: row?.last_run_at || "",
    lastMorningDate: row?.last_morning_date || "",
    chatThreadId: row?.chat_thread_id || "",
    chatStatus: row?.chat_status || "not_created",
    chatUpdatedAt: row?.chat_updated_at || "",
    chatError: row?.chat_error || "",
  };
}

function mapPmRun(row) {
  if (!row) return null;
  return { id: row.id, kind: row.kind, status: row.status, summary: row.summary, error: row.error, threadCount: row.thread_count, recommendationCount: row.recommendation_count, startedAt: row.started_at, finishedAt: row.finished_at || "" };
}

function pmStrategicContext() {
  const projects = db.prepare("SELECT id FROM projects WHERE status='active' ORDER BY target_date").all().map((row) => projectDetail(row.id,{ reconcile: false })).filter(Boolean).map((project) => ({
    id: project.id,
    companySlug: project.companySlug,
    companyName: project.companyName,
    title: project.title,
    objective: project.objective,
    targetDate: project.targetDate,
    health: `${project.health.label}: ${project.health.reason}`,
    progress: project.progress,
    activePhase: project.activePhase?.title || "",
    nextMilestone: project.nextMilestone ? `${project.nextMilestone.title} on ${project.nextMilestone.scheduledDate}${project.nextMilestone.decision ? ` — ${project.nextMilestone.decision}` : ""}` : "",
    criticalPath: project.guidance.doNow.slice(0,8).map((item) => ({ title: item.title, companyName: project.companyName, dueAt: item.dueDate || "", status: item.workItemStatus || item.executionState, owner: item.owner, reason: item.executionReason })),
    blocked: project.guidance.waiting.slice(0,8).map((item) => ({ title: item.title, companyName: project.companyName, dueAt: item.dueDate || "", status: item.workItemStatus || item.executionState, owner: item.owner, reason: item.executionReason, blockedBy: item.blockedBy })),
    upNext: project.guidance.upNext.slice(0,6).map((item) => ({ title: item.title, companyName: project.companyName, dueAt: item.dueDate || "", status: item.executionState, owner: item.owner, reason: item.executionReason })),
  }));
  const now = new Date();
  const horizon = new Date(now.getTime() + 3 * 86400000).toISOString();
  const calendar = db.prepare(`SELECT subject AS title,start_at AS startAt,end_at AS endAt,organizer_name AS organizer
    FROM calendar_events WHERE end_at>=? AND start_at<=? ORDER BY start_at LIMIT 12`).all(now.toISOString(),horizon).map((item) => ({ ...item, companyName: meetingCompany(item.title) ? db.prepare("SELECT display_name FROM companies WHERE slug=?").get(meetingCompany(item.title))?.display_name || "" : "" }));
  const mail = db.prepare(`SELECT subject AS title,sender_name AS sender,received_at AS receivedAt,company_slug AS companySlug,reply_reason AS reason
    FROM mail_messages WHERE reply_state IN ('needs_reply','likely_needs_reply') AND review_state!='reviewed'
      AND (snoozed_until IS NULL OR snoozed_until<=?) ORDER BY received_at DESC LIMIT 10`).all(now.toISOString()).map((item) => ({ ...item, companyName: item.companySlug ? db.prepare("SELECT display_name FROM companies WHERE slug=?").get(item.companySlug)?.display_name || "" : "" }));
  return { projects, calendar, mail, generatedAt: nowIso() };
}

function pmAgentPayload() {
  const config = db.prepare("SELECT * FROM pm_agent_config WHERE id='default'").get();
  const latest = db.prepare("SELECT * FROM pm_runs ORDER BY started_at DESC LIMIT 1").get();
  const companyNames = new Map(db.prepare("SELECT slug,display_name FROM companies").all().map((row) => [row.slug, row.display_name]));
  const observations = latest ? db.prepare("SELECT * FROM pm_thread_observations WHERE run_id=? ORDER BY thread_updated_at DESC,title").all(latest.id).map((row) => ({
    threadId: row.thread_id, title: row.title, preview: row.preview, status: row.thread_status,
    companySlug: row.company_slug, companyName: companyNames.get(row.company_slug) || "Unassigned",
    linkedWorkItemId: row.linked_work_item_id, linkedWorkItemTitle: row.linked_work_item_title,
    matchType: row.match_type, confidence: row.confidence, rationale: row.rationale,
    updatedAt: row.thread_updated_at || "", cwd: row.cwd,
  })) : [];
  const recommendations = latest ? db.prepare("SELECT * FROM pm_recommendations WHERE run_id=? ORDER BY created_at,id").all(latest.id).map((row) => ({
    id: row.id, action: row.action, workItemId: row.work_item_id, workItemTitle: row.work_item_title,
    threadId: row.thread_id, threadTitle: row.thread_title, companySlug: row.company_slug,
    companyName: companyNames.get(row.company_slug) || "Unassigned", rationale: row.rationale, status: row.status,
  })) : [];
  const count = (actions, statuses = null) => recommendations.filter((item) => actions.includes(item.action) && (!statuses || statuses.includes(item.status))).length;
  const activeWorkItems = new Set(observations.filter((item) => item.linkedWorkItemId && isPmThreadActive(item.status)).map((item) => item.linkedWorkItemId));
  return {
    config: mapPmConfig(config), latestRun: mapPmRun(latest), observations, recommendations, strategy: pmStrategicContext(),
    summary: {
      underway: activeWorkItems.size,
      likelyMatches: observations.filter((item) => item.matchType === "likely").length,
      wouldDispatch: count(["dispatch"], ["proposed"]),
      autoStarted: count(["dispatch"], ["executed"]),
      needsJake: count(["needs_jake", "link", "review"]),
      waiting: count(["wait"]),
    },
  };
}

async function runPmAgent(kind = "manual") {
  if (pmRunPromise) return pmRunPromise;
  pmRunPromise = (async () => {
    const id = randomUUID(); const started = nowIso();
    db.prepare("INSERT INTO pm_runs(id,kind,status,started_at) VALUES(?,?, 'working',?)").run(id, kind, started);
    try {
      reconcileAllProjects();
      const threads = db.prepare(`SELECT t.*,w.company_slug FROM codex_tasks t
        JOIN work_items w ON w.id=t.work_item_id ORDER BY t.updated_at DESC LIMIT 20`).all().map((task) => ({
        id: task.thread_id || `receipt:${task.id}`,
        name: task.title,
        preview: task.instruction,
        status: task.status === "working" ? "working" : task.status === "complete" ? "completed" : task.status,
        latestSummary: task.result || task.error || "",
        updatedAt: task.updated_at,
        cwd: aiOsRoot,
      }));
      const workItems = db.prepare(`SELECT w.*,c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug
        WHERE w.status NOT IN ('done','dismissed') ORDER BY COALESCE(w.due_at,'9999-12-31'),w.updated_at DESC`).all();
      const explicitLinks = [
        ...db.prepare("SELECT CASE WHEN t.thread_id<>'' THEN t.thread_id ELSE 'receipt:'||t.id END AS threadId,t.work_item_id AS workItemId,'codex_task' AS type FROM codex_tasks t JOIN work_items w ON w.id=t.work_item_id WHERE w.status NOT IN ('done','dismissed')").all(),
        ...db.prepare("SELECT l.thread_id AS threadId,l.work_item_id AS workItemId,'confirmed' AS type FROM pm_thread_links l JOIN work_items w ON w.id=l.work_item_id WHERE l.status='confirmed' AND w.status NOT IN ('done','dismissed')").all(),
      ];
      const snapshot = buildPmSnapshot({ threads, workItems, explicitLinks, recentAwarenessLimit: 20 });
      const created = nowIso();
      const insertObservation = db.prepare(`INSERT INTO pm_thread_observations(id,run_id,thread_id,title,preview,thread_status,company_slug,linked_work_item_id,linked_work_item_title,match_type,confidence,rationale,thread_updated_at,cwd,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of snapshot.observations) insertObservation.run(randomUUID(), id, item.threadId, item.title, item.preview, item.status, item.companySlug, item.linkedWorkItemId, item.linkedWorkItemTitle, item.matchType, item.confidence, item.rationale, item.updatedAt || null, item.cwd, created);
      const insertRecommendation = db.prepare(`INSERT INTO pm_recommendations(id,run_id,action,work_item_id,work_item_title,thread_id,thread_title,company_slug,rationale,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'proposed',?,?)`);
      const savedRecommendations = [];
      for (const item of snapshot.recommendations) {
        const recommendationId = randomUUID();
        insertRecommendation.run(recommendationId, id, item.action, item.workItemId, item.workItemTitle, item.threadId, item.threadTitle, item.companySlug, item.rationale, created, created);
        savedRecommendations.push({ ...item, id: recommendationId });
      }
      let autoStarted = 0;
      const dispatchCounts = db.prepare(`SELECT
        SUM(CASE WHEN status='executed' THEN 1 ELSE 0 END) AS started,
        SUM(CASE WHEN status='proposed' THEN 1 ELSE 0 END) AS remaining
        FROM pm_recommendations WHERE run_id=? AND action='dispatch'`).get(id);
      autoStarted = Number(dispatchCounts?.started || 0);
      const remainingDispatch = Number(dispatchCounts?.remaining || 0);
      const summary = `${snapshot.summary.underway} active Codex turn(s); ${autoStarted} preparation task(s) started; ${remainingDispatch} ready to start; ${snapshot.summary.needsJake} item(s) need Jake.`;
      db.prepare("UPDATE pm_runs SET status='complete',summary=?,thread_count=?,recommendation_count=?,finished_at=? WHERE id=?").run(summary, snapshot.observations.length, snapshot.recommendations.length, created, id);
      const morningDate = kind === "morning" ? localDateKey() : db.prepare("SELECT last_morning_date FROM pm_agent_config WHERE id='default'").get()?.last_morning_date || "";
      db.prepare("UPDATE pm_agent_config SET last_run_at=?,last_morning_date=?,updated_at=? WHERE id='default'").run(created, morningDate, created);
      return pmAgentPayload();
    } catch (error) {
      const finished = nowIso(); const message = error instanceof Error ? error.message : "The PM check failed.";
      db.prepare("UPDATE pm_runs SET status='error',error=?,finished_at=? WHERE id=?").run(message.slice(0,4000), finished, id);
      throw error;
    } finally { pmRunPromise = null; }
  })();
  return pmRunPromise;
}

function pacificClock() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function withImmediateTransaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = callback();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function assignmentContext(item, includeScratchpad = false) {
  const sources = db.prepare(`SELECT provider,label,source_id,source_path,source_url,retrieved_at,freshness
    FROM source_references WHERE work_item_id=? ORDER BY retrieved_at DESC`).all(item.id);
  const notes = db.prepare(`SELECT n.id,n.title,n.type,n.file_path FROM notes n
    JOIN note_links l ON l.note_id=n.id WHERE l.work_item_id=? ORDER BY n.updated_at DESC`).all(item.id);
  return {
    workItemId: item.id,
    companySlug: item.company_slug,
    companyName: item.company_name || "Unassigned",
    companyOperatingPath: item.ai_os_path ? path.resolve(aiOsRoot, item.ai_os_path) : "",
    sourceRefs: sources,
    noteRefs: notes,
    scratchpad: includeScratchpad ? item.draft || "" : "",
    scratchpadIncluded: Boolean(includeScratchpad && String(item.draft || "").trim()),
  };
}

function assignmentHandoffPacket(item, assignment, capability) {
  const callbackUrl = `http://127.0.0.1:${port}/api/assignments/${assignment.id}/events`;
  const context = JSON.parse(assignment.context_manifest || "{}");
  const prompt = `Complete this Command Center assignment in a normal user-owned Codex task.

Assignment key: ${assignment.assignment_key}
Destination: ${assignment.destination === "card" ? "Return the result to the originating card" : "Work in a separate native Codex task and return a terminal receipt to the card"}
Requested outcome: ${assignment.instruction}
Originating card: ${item.title}
Work item ID: ${item.id}
Company: ${item.company_name || "Unassigned"}
Summary: ${item.summary}
Why now: ${item.why_now}
Expected next action: ${item.suggested_action}
Context manifest: ${JSON.stringify(context)}
External-action boundary: ${assignment.external_action_boundary}

Command Center records lifecycle receipts only; it does not launch, resume, open, or inspect this task. Generate a unique eventId for every callback and keep one stable ownerId for the native Codex task. POST JSON to ${callbackUrl} with this header (the capability ends at the line break):
Authorization: Bearer ${capability}

Lifecycle: accepted {eventId,type:"accepted",ownerId}; started {eventId,type:"started",ownerId}; heartbeat {eventId,type:"heartbeat",ownerId}; needs input {eventId,type:"needs_input",ownerId,result:"question"}; completed {eventId,type:"completed",ownerId,result:"reviewable result and artifact paths"}; failed {eventId,type:"failed",ownerId,error:"terminal reason"}; ownership released {eventId,type:"ownership_released",ownerId,result:"reason"}.

Read the live card from GET http://127.0.0.1:${port}/api/work-items/${item.id} before working. Never send messages or write to external/shared systems without Jake's separate explicit approval.`;
  return { assignmentId: assignment.id, assignmentKey: assignment.assignment_key, callbackUrl, capabilityGeneration: assignment.capability_generation, prompt };
}

function prepareAssignment(item, { destination, instruction, includeScratchpad = false, revisionOf = null, clientRequestId = "" }) {
  const safeDestination = normalizeAssignmentDestination(destination);
  const safeInstruction = String(instruction || "").trim().slice(0, 4000);
  if (!safeInstruction) throw requestError("Describe what Codex should prepare.");
  const scopeHash = assignmentScopeHash({ workItemId: item.id, destination: safeDestination, instruction: safeInstruction });
  const existing = db.prepare(`SELECT * FROM assignments WHERE work_item_id=?
    AND status IN ('prepared','accepted','working','needs_input','needs_attention') ORDER BY updated_at DESC LIMIT 1`).get(item.id);
  if (existing) {
    if (existing.scope_hash !== scopeHash || existing.destination !== safeDestination) {
      throw requestError("This card already has an active Codex assignment with a different outcome. Cancel the unowned preparation or wait for the current owner to release it before replacing it.", 409);
    }
    return { outcome: "assignment_reused", assignment: mapAssignment(existing, { includeEvents: true }), handoffPacket: null, reused: true };
  }
  if (revisionOf) {
    const prior = db.prepare("SELECT id,work_item_id,status FROM assignments WHERE id=?").get(revisionOf);
    if (!prior || prior.work_item_id !== item.id || !["completed", "failed", "ownership_released"].includes(prior.status)) {
      throw requestError("Choose a terminal result from this card to revise.", 409);
    }
  }

  return withImmediateTransaction(() => {
    const { id, assignmentKey } = createAssignmentIdentity(item.id);
    const capability = createCallbackCapability();
    const now = nowIso();
    const title = `${item.company_name || "Serent"} - ${item.title}`.slice(0, 240);
    const contextManifest = assignmentContext(item, includeScratchpad);
    const allowedSources = [...new Set(contextManifest.sourceRefs.map((source) => source.provider).concat(["ai_os", "project_files"]))];
    db.prepare(`INSERT INTO assignments
      (id,assignment_key,work_item_id,destination,title,instruction,scope_hash,status,attempt,prior_work_item_status,
       owner_type,owner_id,callback_capability_hash,capability_generation,allowed_sources,context_manifest,
       external_action_boundary,result,error,revision_of,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'prepared',1,?,'native_codex','',?,1,?,?,?,'','',?,?,?)`)
      .run(id, assignmentKey, item.id, safeDestination, title, safeInstruction, scopeHash, item.status || "to_review", capability.hash,
        JSON.stringify(allowedSources), JSON.stringify(contextManifest), "No external writes without Jake's separate approval.", revisionOf, now, now);
    const eventKey = String(clientRequestId || `prepared:${id}`).trim().slice(0, 200);
    db.prepare(`INSERT INTO assignment_events
      (id,assignment_id,attempt,event_key,event_type,owner_id,occurred_at,received_at,previous_status,next_status,payload_json,applied,rejection_reason)
      VALUES(?,?,1,?,'prepared','',?,?, 'none','prepared',?,1,'')`)
      .run(randomUUID(), id, eventKey, now, now, JSON.stringify({ destination: safeDestination, instruction: safeInstruction }));
    db.prepare("UPDATE work_items SET decision_state=CASE WHEN decision_state='proposed' THEN 'accepted' ELSE decision_state END,updated_at=? WHERE id=?").run(now, item.id);
    eventFor(item.id, "assignment_prepared", `${safeDestination === "card" ? "Card-return" : "Separate-task"} assignment prepared. No Codex task is running yet. Assignment key: ${assignmentKey}`);
    const row = db.prepare("SELECT * FROM assignments WHERE id=?").get(id);
    return { outcome: "assignment_prepared", assignment: mapAssignment(row, { includeEvents: true }), handoffPacket: assignmentHandoffPacket(item, row, capability.token), reused: false };
  });
}

function issueAssignmentPacket(assignmentId) {
  return withImmediateTransaction(() => {
    const assignment = db.prepare("SELECT * FROM assignments WHERE id=?").get(assignmentId);
    if (!assignment) throw requestError("Unknown assignment.", 404);
    if (assignment.status !== "prepared" || assignment.owner_id) throw requestError("A new packet can be issued only while the assignment is prepared and unowned.", 409);
    const item = db.prepare(`SELECT w.*,c.display_name AS company_name,c.ai_os_path FROM work_items w
      LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(assignment.work_item_id);
    const capability = createCallbackCapability();
    const now = nowIso();
    const generation = Number(assignment.capability_generation || 1) + 1;
    db.prepare("UPDATE assignments SET callback_capability_hash=?,capability_generation=?,updated_at=? WHERE id=?").run(capability.hash, generation, now, assignment.id);
    db.prepare(`INSERT INTO assignment_events
      (id,assignment_id,attempt,event_key,event_type,owner_id,occurred_at,received_at,previous_status,next_status,payload_json,applied,rejection_reason)
      VALUES(?,?,?,?,'packet_issued','',?,?, 'prepared','prepared',?,1,'')`)
      .run(randomUUID(), assignment.id, assignment.attempt, `packet:${assignment.attempt}:${generation}`, now, now, JSON.stringify({ capabilityGeneration: generation }));
    const updated = db.prepare("SELECT * FROM assignments WHERE id=?").get(assignment.id);
    return { assignment: mapAssignment(updated, { includeEvents: true }), handoffPacket: assignmentHandoffPacket(item, updated, capability.token) };
  });
}

function applyAssignmentEvent(assignmentId, body, capability) {
  const eventKey = String(body.eventId || body.eventKey || "").trim().slice(0, 200);
  if (!/^[0-9a-z][0-9a-z._:-]{5,199}$/i.test(eventKey)) throw requestError("A stable eventId is required for every assignment callback.");
  return withImmediateTransaction(() => {
    const current = db.prepare("SELECT * FROM assignments WHERE id=?").get(assignmentId);
    if (!current) throw requestError("Unknown assignment.", 404);
    if (!verifyCallbackCapability(capability, current.callback_capability_hash)) throw requestError("Assignment callback capability is invalid.", 403);
    const replay = db.prepare("SELECT * FROM assignment_events WHERE assignment_id=? AND attempt=? AND event_key=?").get(current.id, current.attempt, eventKey);
    if (replay) return { assignment: mapAssignment(current, { includeEvents: true }), event: { id: replay.id, eventKey: replay.event_key, type: replay.event_type, replayed: true }, replayed: true };

    const now = nowIso();
    const ownerId = String(body.ownerId || body.threadId || "").trim().slice(0, 200);
    const rawType = normalizeAssignmentEvent(body.type || body.status);
    let transition;
    try {
      transition = transitionAssignment({ id: current.id, assignmentKey: current.assignment_key, status: current.status, ownerId: current.owner_id, ownerType: current.owner_type }, { type: rawType, ownerId, ownerType: body.ownerType });
    } catch (error) {
      db.prepare(`INSERT INTO assignment_events
        (id,assignment_id,attempt,event_key,event_type,owner_id,occurred_at,received_at,previous_status,next_status,payload_json,applied,rejection_reason)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)`)
        .run(randomUUID(), current.id, current.attempt, eventKey, rawType || "invalid", ownerId, body.occurredAt || null, now,
          current.status, current.status, JSON.stringify(body), String(error.message || error).slice(0, 1000));
      throw requestError(String(error.message || error), 409);
    }

    let result = current.result || "";
    let errorText = current.error || "";
    if (["needs_input", "needs_attention", "ownership_released", "completed"].includes(transition.nextStatus)) result = String(body.result || body.detail || "").slice(0, 50000);
    if (transition.nextStatus === "completed") errorText = "";
    if (transition.nextStatus === "failed") errorText = String(body.error || "The native Codex owner could not complete this assignment.").slice(0, 8000);
    const isHeartbeat = ["accepted", "started", "heartbeat", "needs_input", "needs_attention"].includes(transition.eventType);
    db.prepare(`UPDATE assignments SET status=?,owner_type=?,owner_id=?,result=?,error=?,
      accepted_at=CASE WHEN ?='accepted' THEN COALESCE(accepted_at,?) ELSE accepted_at END,
      started_at=CASE WHEN ?='started' THEN COALESCE(started_at,?) ELSE started_at END,
      heartbeat_at=CASE WHEN ? THEN ? ELSE heartbeat_at END,
      needs_input_at=CASE WHEN ?='needs_input' THEN ? ELSE needs_input_at END,
      completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,
      failed_at=CASE WHEN ?='failed' THEN ? ELSE failed_at END,
      released_at=CASE WHEN ?='ownership_released' THEN ? ELSE released_at END,
      updated_at=? WHERE id=?`)
      .run(transition.nextStatus, transition.ownerType, transition.ownerId, result, errorText,
        transition.eventType, now, transition.eventType, now, isHeartbeat ? 1 : 0, now,
        transition.eventType, now, transition.eventType, now, transition.eventType, now, transition.eventType, now, now, current.id);
    db.prepare(`INSERT INTO assignment_events
      (id,assignment_id,attempt,event_key,event_type,owner_id,occurred_at,received_at,previous_status,next_status,payload_json,applied,rejection_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,'')`)
      .run(randomUUID(), current.id, current.attempt, eventKey, transition.eventType, transition.ownerId, body.occurredAt || null, now,
        transition.previousStatus, transition.nextStatus, JSON.stringify(body));

    const item = db.prepare("SELECT * FROM work_items WHERE id=?").get(current.work_item_id);
    const projected = workItemStatusForAssignment({ nextStatus: transition.nextStatus, priorWorkItemStatus: current.prior_work_item_status });
    if (projected && item && !["done", "dismissed"].includes(item.status)) {
      if (transition.nextStatus === "completed" && item.preparation_skill === "draft-executive-email" && !String(item.draft || "").trim()) {
        db.prepare("UPDATE work_items SET status=?,draft=?,updated_at=? WHERE id=?").run(projected, result, now, current.work_item_id);
      } else {
        db.prepare("UPDATE work_items SET status=?,updated_at=? WHERE id=?").run(projected, now, current.work_item_id);
      }
    }
    const detail = ({
      accepted: "A native Codex owner accepted this assignment and is waiting to start.",
      started: "The verified native Codex owner started this assignment.",
      heartbeat: "The native Codex owner reported progress.",
      needs_input: result || "The native Codex owner needs input.",
      needs_attention: result || "No recent lifecycle receipt was received; the existing owner remains assigned.",
      completed: "The verified result is ready for review on this card.",
      failed: errorText,
      ownership_released: result || "The native Codex owner released this assignment without a result.",
    })[transition.eventType] || `Assignment state changed to ${transition.nextStatus}.`;
    eventFor(current.work_item_id, `assignment_${transition.eventType}`, `${detail} Assignment key: ${current.assignment_key}`);
    const updated = db.prepare("SELECT * FROM assignments WHERE id=?").get(current.id);
    return { assignment: mapAssignment(updated, { includeEvents: true }), event: { eventKey, type: transition.eventType, replayed: false }, replayed: false };
  });
}

function cancelPreparedAssignment(assignmentId) {
  return withImmediateTransaction(() => {
    const current = db.prepare("SELECT * FROM assignments WHERE id=?").get(assignmentId);
    if (!current) throw requestError("Unknown assignment.", 404);
    const transition = transitionAssignment({ id: current.id, assignmentKey: current.assignment_key, status: current.status, ownerId: current.owner_id, ownerType: current.owner_type }, { type: "cancelled" });
    const now = nowIso();
    db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=?,updated_at=? WHERE id=?").run(now, now, current.id);
    db.prepare(`INSERT INTO assignment_events
      (id,assignment_id,attempt,event_key,event_type,owner_id,occurred_at,received_at,previous_status,next_status,payload_json,applied,rejection_reason)
      VALUES(?,?,?,?,'cancelled','',?,?,?,?,'{}',1,'')`)
      .run(randomUUID(), current.id, current.attempt, `cancelled:${current.attempt}:${now}`, now, now, transition.previousStatus, transition.nextStatus);
    eventFor(current.work_item_id, "assignment_cancelled", `Cancelled an unowned prepared assignment. Assignment key: ${current.assignment_key}`);
    return mapAssignment(db.prepare("SELECT * FROM assignments WHERE id=?").get(current.id), { includeEvents: true });
  });
}

function reconcileAssignmentAttention() {
  const stale = db.prepare(`SELECT * FROM assignments WHERE status IN ('accepted','working','needs_input')
    AND datetime(COALESCE(heartbeat_at,updated_at)) <= datetime('now','-10 minutes')`).all();
  for (const assignment of stale) {
    withImmediateTransaction(() => {
      const current = db.prepare("SELECT * FROM assignments WHERE id=?").get(assignment.id);
      if (!current || !["accepted", "working", "needs_input"].includes(current.status)) return;
      const now = nowIso();
      const eventKey = `attention:${current.attempt}:${current.heartbeat_at || current.updated_at}`;
      if (db.prepare("SELECT 1 FROM assignment_events WHERE assignment_id=? AND attempt=? AND event_key=?").get(current.id, current.attempt, eventKey)) return;
      const transition = transitionAssignment({ id: current.id, assignmentKey: current.assignment_key, status: current.status, ownerId: current.owner_id, ownerType: current.owner_type }, { type: "needs_attention", ownerId: current.owner_id });
      const detail = "No lifecycle receipt has arrived for 10 minutes. The existing native Codex owner remains assigned; Command Center will not create a replacement.";
      db.prepare("UPDATE assignments SET status='needs_attention',result=?,updated_at=? WHERE id=?").run(detail, now, current.id);
      db.prepare(`INSERT INTO assignment_events
        (id,assignment_id,attempt,event_key,event_type,owner_id,occurred_at,received_at,previous_status,next_status,payload_json,applied,rejection_reason)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1,'')`)
        .run(randomUUID(), current.id, current.attempt, eventKey, "needs_attention", current.owner_id, now, now,
          transition.previousStatus, transition.nextStatus, JSON.stringify({ reason: "heartbeat_timeout", seconds: 600 }));
      const item = db.prepare("SELECT status FROM work_items WHERE id=?").get(current.work_item_id);
      if (item && !["done", "dismissed"].includes(item.status)) db.prepare("UPDATE work_items SET status='needs_attention',updated_at=? WHERE id=?").run(now, current.work_item_id);
      eventFor(current.work_item_id, "assignment_needs_attention", `${detail} Assignment key: ${current.assignment_key}`);
    });
  }
}

async function launchAgentRun({ workItemId = null, mailMessageId = null, companySlug = null, scope, intent, title, allowedSources, revisionOf = null, sourceRefresh = null, skillId = "generic-codex", executorType = "codex_readonly", contextManifest = {} }) {
  const id = randomUUID();
  const now = nowIso();
  const safeIntent = String(intent || "").trim().slice(0, 4000);
  if (!safeIntent) throw new Error("Describe what Codex should do.");
  const inputHash = createHash("sha256").update(`${scope}:${safeIntent}:${workItemId || ""}`).digest("hex").slice(0, 12);
  if (workItemId) {
    const existing = db.prepare("SELECT * FROM agent_runs WHERE work_item_id=? AND status IN ('queued','working','waiting_on_user') ORDER BY created_at DESC LIMIT 1").get(workItemId);
    if (existing) {
      eventFor(workItemId, "agent_run_reused", "An active assignment already owns this card, so Command Center did not create a duplicate.");
      return mapRun(existing);
    }
  }
  db.prepare(`INSERT INTO agent_runs(id,work_item_id,company_slug,scope,intent,title,allowed_sources,status,result,error,revision_of,input_hash,skill_id,executor_type,context_manifest,mail_message_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'queued','','',?,?,?,?,?,?,?,?)`).run(id, workItemId, companySlug, scope, safeIntent, title, JSON.stringify(allowedSources), revisionOf, inputHash, skillId, executorType, JSON.stringify(contextManifest), mailMessageId, now, now);
  if (workItemId) {
    db.prepare("UPDATE work_items SET status='queued', updated_at=? WHERE id=?").run(now, workItemId);
    eventFor(workItemId, "queued", title);
  }
  if (sourceRefresh) {
    db.prepare(`INSERT INTO source_receipts(source,status,checked_at,detail,result,error)
      VALUES(?, 'working', ?, 'Refreshing independently.', '', '')
      ON CONFLICT(source) DO UPDATE SET status='working', checked_at=excluded.checked_at, detail=excluded.detail, result='', error=''`).run(sourceRefresh, now);
  }

  const cli = await resolveCodexCli();
  const args = ["exec", "--json", "-c", 'approval_policy="never"', "-C", appRoot, "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-"];
  const child = spawn(cli, args, { cwd: appRoot, env: process.env, windowsHide: true });
  activeProcesses.set(id, child);
  db.prepare("UPDATE agent_runs SET status='working', updated_at=? WHERE id=?").run(nowIso(), id);
  if (mailMessageId && scope === "mail_draft") {
    db.prepare("UPDATE mail_drafts SET status='working',updated_at=? WHERE mail_message_id=?").run(nowIso(), mailMessageId);
    db.prepare("UPDATE mail_messages SET draft_state='working',updated_at=? WHERE id=?").run(nowIso(), mailMessageId);
  }
  if (workItemId) db.prepare("UPDATE work_items SET status='working', updated_at=? WHERE id=?").run(nowIso(), workItemId);

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let finalMessage = "";
  const timeout = setTimeout(() => { if (!child.killed) child.kill(); }, 15 * 60 * 1000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") finalMessage = event.item.text;
      } catch {
        // Ignore non-event output.
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderrBuffer = `${stderrBuffer}${chunk}`.slice(-8000); });
  const skillInstruction = skillId === "generic-codex" ? "Use normal Codex capabilities for this scoped assignment." : `Use the installed ${skillId} skill for this assignment.`;
  child.stdin.end(`${skillInstruction}\n\n${safeIntent}\n\nThis is a Serent Command Center background assignment. Stay within these allowed source categories: ${allowedSources.join(", ") || "local context only"}. Work read-only. Never send messages or modify ClickUp, calendar, Box, Guru, email, or any shared system. ${scope === "mail_draft" ? "Return only the sendable reply body with no commentary, labels, or Markdown fence." : "Return a concise, source-backed result."}`);

  child.on("close", (code) => {
    clearTimeout(timeout);
    activeProcesses.delete(id);
    const finished = nowIso();
    if (code === 0 && finalMessage) {
      db.prepare("UPDATE agent_runs SET status='review', result=?, updated_at=? WHERE id=?").run(finalMessage, finished, id);
      if (workItemId) {
        db.prepare("UPDATE work_items SET status='back_for_review', updated_at=? WHERE id=?").run(finished, workItemId);
        eventFor(workItemId, "agent_returned", title);
      }
      if (mailMessageId && scope === "mail_draft") {
        const draft = db.prepare("SELECT * FROM mail_drafts WHERE mail_message_id=?").get(mailMessageId);
        if (draft) {
          db.prepare("UPDATE mail_drafts SET generated_body=?,current_body=?,status='ready',updated_at=? WHERE id=?").run(finalMessage.trim(), finalMessage.trim(), finished, draft.id);
          db.prepare("INSERT INTO mail_draft_revisions(id,mail_draft_id,body,origin,created_at) VALUES(?,?,?,'agent',?)").run(randomUUID(), draft.id, finalMessage.trim(), finished);
          db.prepare("UPDATE mail_messages SET draft_state='ready',updated_at=? WHERE id=?").run(finished, mailMessageId);
        }
      }
      if (sourceRefresh) {
        const parsed = parseAgentJson(finalMessage);
        const changed = upsertNormalizedItems(sourceRefresh, parsed);
        const projectsChanged = upsertSourceProjects(sourceRefresh,parsed);
        db.prepare(`UPDATE source_receipts SET status='ready', checked_at=?, detail=?, result=?, error='' WHERE source=?`).run(finished, parsed?.summary || `Refresh complete; ${changed} consequential item${changed === 1 ? "" : "s"} and ${projectsChanged} project plan${projectsChanged === 1 ? "" : "s"} updated.`, finalMessage, sourceRefresh);
      }
    } else {
      const error = stderrBuffer.trim() || `Codex exited without a reviewable result (code ${code}).`;
      db.prepare("UPDATE agent_runs SET status='error', error=?, updated_at=? WHERE id=?").run(error, finished, id);
      if (workItemId) {
        db.prepare("UPDATE work_items SET status='back_for_review', updated_at=? WHERE id=?").run(finished, workItemId);
        eventFor(workItemId, "agent_error", "The assignment stopped without a reviewable result.");
      }
      if (sourceRefresh) db.prepare("UPDATE source_receipts SET status='error', checked_at=?, detail='Refresh failed without affecting other sources.', error=? WHERE source=?").run(finished, error, sourceRefresh);
      if (mailMessageId && scope === "mail_draft") {
        db.prepare("UPDATE mail_drafts SET status='error',updated_at=? WHERE mail_message_id=?").run(finished, mailMessageId);
        db.prepare("UPDATE mail_messages SET draft_state='error',updated_at=? WHERE id=?").run(finished, mailMessageId);
      }
    }
  });
  child.on("error", (error) => {
    clearTimeout(timeout);
    activeProcesses.delete(id);
    const finished = nowIso();
    db.prepare("UPDATE agent_runs SET status='error', error=?, updated_at=? WHERE id=?").run(error.message, finished, id);
    if (workItemId) db.prepare("UPDATE work_items SET status='back_for_review', updated_at=? WHERE id=?").run(finished, workItemId);
    if (sourceRefresh) db.prepare("UPDATE source_receipts SET status='error', checked_at=?, detail='Refresh failed without affecting other sources.', error=? WHERE source=?").run(finished, error.message, sourceRefresh);
    if (mailMessageId && scope === "mail_draft") db.prepare("UPDATE mail_drafts SET status='error',updated_at=? WHERE mail_message_id=?").run(finished, mailMessageId);
  });
  return mapRun(db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id));
}

function pacificDate(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function routeMeetingTranscript({ sourcePath, event, companySlug, noteBody }) {
  const extension = path.extname(sourcePath).toLowerCase();
  const date = pacificDate(event.start_at);
  const title = safeMeetingName(event.subject);
  const destinationDir = path.join(transcriptRoot, "companies", companySlug, "general");
  const storedPath = path.join(destinationDir, `${date} - ${title}${extension}`);
  const summaryPath = path.join(destinationDir, `${date} - ${title}.summary.md`);
  const metadataPath = path.join(destinationDir, `${date} - ${title}.metadata.json`);
  await mkdir(destinationDir, { recursive: true });
  if (path.resolve(sourcePath) !== path.resolve(storedPath)) await copyFile(sourcePath, storedPath);
  const raw = await readFile(sourcePath);
  const sourceHash = createHash("sha256").update(raw).digest("hex").toUpperCase();
  const processedAt = nowIso();
  const metadata = {
    meeting_date: date, meeting_title: event.subject, source_file: sourcePath,
    stored_transcript_path: storedPath, summary_path: summaryPath, metadata_path: metadataPath,
    company: companySlug, project: "general", classification_confidence: 100,
    classification_evidence: ["Matched to an Outlook calendar event and confirmed from Command Center."],
    participants: JSON.parse(event.attendees_json || "[]").map((item) => item.name || item.email).filter(Boolean),
    source_hash: sourceHash, processed_at: processedAt, recording_url: "",
  };
  await writeFile(summaryPath, `# ${event.subject}\n\n${noteBody.trim()}\n`, "utf8");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await mkdir(transcriptRoot, { recursive: true });
  const manifestPath = path.join(transcriptRoot, "manifest.jsonl");
  const manifest = await readFile(manifestPath, "utf8").catch(() => "");
  if (!manifest.includes(`"stored_transcript_path":"${storedPath.replaceAll("\\", "\\\\")}"`)) {
    await appendFile(manifestPath, `${JSON.stringify(metadata)}\n`, "utf8");
    const indexPath = path.join(transcriptRoot, "index.csv");
    const existingIndex = await readFile(indexPath, "utf8").catch(() => "");
    if (!existingIndex.trim()) await appendFile(indexPath, '"meeting_date","meeting_title","company","project","classification_confidence","stored_transcript_path","summary_path","source_hash","processed_at"\n', "utf8");
    await appendFile(indexPath, `${[date,event.subject,companySlug,"general",100,storedPath,summaryPath,sourceHash,processedAt].map(csvCell).join(",")}\n`, "utf8");
  }
  return { storedPath, summaryPath, metadataPath, sourceHash };
}

async function finishMeetingProcessing({ workflow, event, sourcePath, parsed, runId }) {
  const finished = nowIso();
  const companySlugs = db.prepare("SELECT slug FROM companies WHERE active=1").all().map((row) => row.slug);
  const companySlug = companySlugs.includes(parsed.companySlug) ? parsed.companySlug : meetingCompany(`${event.subject} ${parsed.summary || ""}`);
  const noteBody = String(parsed.noteBody || parsed.summary || "No meeting note was returned.").slice(0, 100000);
  const routed = await routeMeetingTranscript({ sourcePath, event, companySlug, noteBody });
  const existingNote = workflow.note_id ? db.prepare("SELECT * FROM notes WHERE id=?").get(workflow.note_id) : existingMeetingNoteFor(event);
  const noteId = existingNote?.id || randomUUID();
  const noteTitle = existingNote?.title || String(parsed.noteTitle || `${event.subject} - Meeting notes`).slice(0, 240);
  if (!existingNote) {
    db.prepare(`INSERT INTO notes(id,title,body,type,origin,state,company_slug,meeting_id,project_ref,created_at,updated_at)
      VALUES(?,?,?,'meeting','agent','active',?,?, 'general',?,?)`)
      .run(noteId, noteTitle, noteBody, companySlug, event.graph_id, finished, finished);
  }
  db.prepare("INSERT OR IGNORE INTO note_links(note_id,work_item_id) VALUES(?,?)").run(noteId, workflow.work_item_id);
  await persistNoteFile(db.prepare("SELECT * FROM notes WHERE id=?").get(noteId));
  db.prepare(`INSERT INTO source_references(id,work_item_id,provider,label,source_id,source_path,retrieved_at,freshness)
    VALUES(?,?, 'transcripts', ?, ?, ?, ?, 'live')`)
    .run(randomUUID(), workflow.work_item_id, path.basename(sourcePath), routed.sourceHash, routed.storedPath, finished);
  db.prepare("DELETE FROM meeting_action_suggestions WHERE meeting_workflow_id=? AND decision='proposed'").run(workflow.id);
  const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 20) : [];
  for (const raw of actions) {
    const action = normalizeMeetingAction(raw, companySlugs);
    if (!action) continue;
    const existing = action.existingWorkItemId ? db.prepare("SELECT id FROM work_items WHERE id=?").get(action.existingWorkItemId) : null;
    db.prepare(`INSERT INTO meeting_action_suggestions(id,meeting_workflow_id,title,summary,company_slug,type,priority,owner_state,suggested_action,evidence_timestamp,due_at,existing_work_item_id,decision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'proposed',?,?)`)
      .run(randomUUID(), workflow.id, action.title, action.summary, action.companySlug || companySlug, action.type, action.priority, action.owner, action.suggestedAction, action.evidenceTimestamp, action.dueAt, existing?.id || null, finished, finished);
  }
  const count = db.prepare("SELECT COUNT(*) AS count FROM meeting_action_suggestions WHERE meeting_workflow_id=? AND decision='proposed'").get(workflow.id).count;
  db.prepare("UPDATE meeting_workflows SET state='review',transcript_path=?,note_id=?,agent_run_id=?,error='',updated_at=? WHERE id=?")
    .run(routed.storedPath, noteId, runId, finished, workflow.id);
  db.prepare("UPDATE agent_runs SET status='review',result=?,updated_at=? WHERE id=?")
    .run(`Saved “${noteTitle}” and proposed ${count} follow-up action${count === 1 ? "" : "s"}.`, finished, runId);
  db.prepare("UPDATE work_items SET company_slug=?,status='back_for_review',summary=?,suggested_action=?,updated_at=? WHERE id=?")
    .run(companySlug, String(parsed.summary || "The meeting transcript has been processed.").slice(0, 4000), count ? `Review ${count} proposed follow-up${count === 1 ? "" : "s"}, then finish the meeting review.` : "Review the saved meeting note, then finish the meeting review.", finished, workflow.work_item_id);
  eventFor(workflow.work_item_id, "meeting_processed", `Saved the meeting note and proposed ${count} reviewable follow-up action${count === 1 ? "" : "s"}.`);
}

async function launchMeetingProcessing(workflow, event, sourcePath) {
  if (!isAllowedTranscriptPath(sourcePath, [downloadsDir, transcriptInbox, transcriptRoot])) throw new Error("Choose a transcript from Downloads or the transcript inbox.");
  if (!/\.(vtt|srt|txt)$/i.test(sourcePath)) throw new Error("Choose a .vtt, .srt, or .txt transcript.");
  const transcriptText = (await readFile(sourcePath, "utf8")).slice(0, 180000);
  if (!transcriptText.trim()) throw new Error("The selected transcript is empty.");
  const runId = randomUUID();
  const now = nowIso();
  const activeItems = db.prepare("SELECT id,title,company_slug,status,summary FROM work_items WHERE status NOT IN ('done','dismissed') AND id<>? ORDER BY updated_at DESC LIMIT 80").all(workflow.work_item_id);
  const intent = `Process the transcript for ${event.subject} into a meeting note and proposed actions.`;
  db.prepare(`INSERT INTO agent_runs(id,work_item_id,company_slug,scope,intent,title,allowed_sources,status,result,error,revision_of,input_hash,skill_id,executor_type,context_manifest,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'working','','',NULL,?,'zoom-transcript-router','codex_readonly',?,?,?)`)
    .run(runId, workflow.work_item_id, meetingCompany(event.subject), "meeting_transcript", intent, `${event.subject} · Meeting follow-through`, JSON.stringify(["transcripts", "calendar", "ai_os", "project_files"]), createHash("sha256").update(`${event.graph_id}:${sourcePath}`).digest("hex").slice(0, 12), JSON.stringify({ meetingWorkflowId: workflow.id, calendarEventId: event.graph_id, transcriptPath: sourcePath }), now, now);
  db.prepare("UPDATE meeting_workflows SET state='processing',candidate_path=?,agent_run_id=?,error='',updated_at=? WHERE id=?").run(sourcePath, runId, now, workflow.id);
  db.prepare("UPDATE work_items SET status='working',suggested_action='Command Center is processing the transcript and will return the note and proposed actions here.',updated_at=? WHERE id=?").run(now, workflow.work_item_id);
  eventFor(workflow.work_item_id, "meeting_processing", `Processing ${path.basename(sourcePath)} with the Zoom Transcript Router.`);
  const cli = await resolveCodexCli();
  const args = ["exec", "--json", "-c", 'approval_policy="never"', "-C", aiOsRoot, "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-"];
  const child = spawn(cli, args, { cwd: aiOsRoot, env: process.env, windowsHide: true });
  activeProcesses.set(runId, child);
  let buffer = ""; let finalMessage = ""; let stderr = "";
  const timeout = setTimeout(() => { if (!child.killed) child.kill(); }, 15 * 60 * 1000);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) try { const value = JSON.parse(line); if (value.type === "item.completed" && value.item?.type === "agent_message") finalMessage = value.item.text || ""; } catch {} });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  const prompt = `Use the installed zoom-transcript-router skill's meeting-note standards. Analyze this exact transcript read-only. Do not create or modify files or external systems. Return one JSON object only with this shape:\n{"companySlug":"avionte|stockiq|govworx|firm","noteTitle":"title","noteBody":"complete Markdown meeting note without a title heading","summary":"brief meeting outcome","actions":[{"title":"action","summary":"what is owed and why","companySlug":"avionte|stockiq|govworx|firm","type":"follow_up|decision|task|artifact","priority":"urgent|high|normal|low","owner":"jake|external","suggestedAction":"concrete next step","evidenceTimestamp":"timestamp or short quote locator","dueAt":null,"existingWorkItemId":null}]}\n\nRules: separate Jake-owned actions from items waiting on someone else; include decisions and open questions in the note; do not invent dates; use existingWorkItemId only when the same obligation already appears in the active-card list.\n\nCalendar meeting:\n${JSON.stringify({ subject: event.subject, startAt: event.start_at, endAt: event.end_at, organizer: event.organizer_name, attendees: JSON.parse(event.attendees_json || "[]") })}\n\nActive Command Center cards for deduplication:\n${JSON.stringify(activeItems)}\n\nTranscript:\n${transcriptText}`;
  child.stdin.end(prompt);
  child.on("close", (code) => {
    clearTimeout(timeout); activeProcesses.delete(runId);
    const parsed = parseAgentJson(finalMessage);
    if (code === 0 && parsed && typeof parsed.noteBody === "string" && Array.isArray(parsed.actions)) {
      void finishMeetingProcessing({ workflow, event, sourcePath, parsed, runId }).catch((error) => failMeetingProcessing(workflow, runId, error));
    } else failMeetingProcessing(workflow, runId, new Error(stderr.trim() || "Codex did not return a valid meeting note and action list."));
  });
  child.on("error", (error) => { clearTimeout(timeout); activeProcesses.delete(runId); failMeetingProcessing(workflow, runId, error); });
  return mapRun(db.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId));
}

function failMeetingProcessing(workflow, runId, error) {
  const now = nowIso();
  const message = String(error?.message || error || "Meeting processing failed.").slice(0, 4000);
  db.prepare("UPDATE meeting_workflows SET state='error',error=?,updated_at=? WHERE id=?").run(message, now, workflow.id);
  db.prepare("UPDATE agent_runs SET status='error',error=?,updated_at=? WHERE id=?").run(message, now, runId);
  db.prepare("UPDATE work_items SET status='back_for_review',suggested_action='Review the processing error, then try the transcript again.',updated_at=? WHERE id=?").run(now, workflow.work_item_id);
  eventFor(workflow.work_item_id, "meeting_processing_error", message.slice(0, 1200));
}

function acceptMeetingSuggestion(id) {
  const suggestion = db.prepare(`SELECT s.*,mw.work_item_id AS meeting_work_item_id,mw.note_id,mw.transcript_path
    FROM meeting_action_suggestions s JOIN meeting_workflows mw ON mw.id=s.meeting_workflow_id WHERE s.id=?`).get(id);
  if (!suggestion) throw new Error("Unknown meeting follow-up.");
  if (suggestion.decision !== "proposed") return suggestion.created_work_item_id || suggestion.existing_work_item_id;
  const now = nowIso();
  let targetId = suggestion.existing_work_item_id;
  if (targetId) {
    const target = db.prepare("SELECT * FROM work_items WHERE id=?").get(targetId);
    if (!target) targetId = null;
    else {
      if (["done", "dismissed"].includes(target.status)) db.prepare("UPDATE work_items SET status='to_review',resolution='',resolved_at=NULL,updated_at=? WHERE id=?").run(now, targetId);
      eventFor(targetId, "confirmed_from_meeting", `Confirmed in the transcript linked to ${suggestion.meeting_work_item_id}.`);
    }
  }
  if (!targetId) {
    targetId = randomUUID();
    const status = suggestion.owner_state === "external" ? "waiting_external" : "to_review";
    const decisionState = suggestion.owner_state === "external" ? "accepted" : "committed";
    db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,owner,due_at,source_provider,source_key,decision_state,created_at,updated_at)
      VALUES(?,?,?,?,?,'Confirmed in a processed meeting transcript.',?,1,?,?,?,?,'transcripts',?,?,?,?)`)
      .run(targetId, suggestion.type, suggestion.company_slug, suggestion.title, suggestion.summary, suggestion.priority, status, suggestion.suggested_action, suggestion.owner_state === "external" ? "External" : "Jake", suggestion.due_at, `meeting-action:${suggestion.id}`, decisionState, now, now);
    db.prepare(`INSERT INTO source_references(id,work_item_id,provider,label,source_id,source_path,retrieved_at,freshness)
      VALUES(?,?, 'transcripts', 'Meeting transcript', ?, ?, ?, 'live')`).run(randomUUID(), targetId, suggestion.id, suggestion.transcript_path, now);
    eventFor(targetId, "created_from_meeting", suggestion.evidence_timestamp ? `Transcript evidence: ${suggestion.evidence_timestamp}` : "Accepted from a processed meeting transcript.");
  }
  if (suggestion.note_id) db.prepare("INSERT OR IGNORE INTO note_links(note_id,work_item_id) VALUES(?,?)").run(suggestion.note_id, targetId);
  db.prepare("UPDATE meeting_action_suggestions SET decision='accepted',created_work_item_id=?,updated_at=? WHERE id=?").run(targetId, now, id);
  return targetId;
}

async function launchMailDraft(mailMessageId, { automatic = false, feedback = "" } = {}) {
  const active = db.prepare("SELECT * FROM agent_runs WHERE mail_message_id=? AND scope='mail_draft' AND status IN ('queued','working') ORDER BY created_at DESC LIMIT 1").get(mailMessageId);
  if (active) return mapRun(active);
  const mail = await mailDetail(mailMessageId);
  const preview = delegationPreview({ mailMessageId, skillId: "draft-executive-email" });
  const notes = mail.notes.map((note) => `- ${note.title}: ${note.body.slice(0, 1600)}`).join("\n");
  const rules = mail.activeRules.map((rule) => `- ${rule.instruction}`).join("\n");
  const intent = `Draft a reply from Jake to this incoming email.\n\nFrom: ${mail.senderName} <${mail.senderEmail}>\nSubject: ${mail.subject}\nReceived: ${mail.receivedAt}\n\nIncoming message:\n${mail.body || mail.preview}\n\nRelevant notes:\n${notes || "None."}\n\nApproved Command Center rules:\n${rules || "Use the skill's Jake-style defaults."}\n\nAdditional feedback:\n${feedback || "None."}`;
  const now = nowIso();
  const existingDraft = db.prepare("SELECT * FROM mail_drafts WHERE mail_message_id=?").get(mailMessageId);
  const draftId = existingDraft?.id || randomUUID();
  db.prepare(`INSERT INTO mail_drafts(id,mail_message_id,generated_body,current_body,status,origin_mode,skill_id,source_basis,created_at,updated_at)
    VALUES(?,?, '', '', 'queued',?,'draft-executive-email',?,?,?)
    ON CONFLICT(mail_message_id) DO UPDATE SET status='queued',origin_mode=excluded.origin_mode,skill_id='draft-executive-email',source_basis=excluded.source_basis,updated_at=excluded.updated_at`).run(draftId, mailMessageId, automatic ? "automatic" : "manual", JSON.stringify(preview.contextManifest), now, now);
  db.prepare("UPDATE mail_messages SET draft_state='queued',updated_at=? WHERE id=?").run(now, mailMessageId);
  return launchAgentRun({ mailMessageId, companySlug: mail.companySlug, scope: "mail_draft", intent, title: `Draft reply · ${mail.subject}`, allowedSources: ["outlook", "ai_os", "project_files", "notes"], skillId: "draft-executive-email", executorType: "codex_readonly", contextManifest: preview.contextManifest });
}

async function runFixedPowerShell(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-12000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `Local workflow exited with code ${code}.`)));
  });
}

async function transcriptInboxFiles() {
  try {
    return (await readdir(transcriptInbox, { withFileTypes: true })).filter((entry) => entry.isFile() && /\.(vtt|srt|txt)$/i.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function resumeTranscriptRun(row) {
  if (activeProcesses.has(row.id)) return;
  try { await runFixedPowerShell(transcriptStageScript); } catch { /* Existing inbox files can still be processed. */ }
  const files = await transcriptInboxFiles();
  if (!files.length) return;
  db.prepare("UPDATE agent_runs SET status='working',waiting_reason='',updated_at=? WHERE id=?").run(nowIso(), row.id);
  if (row.work_item_id) db.prepare("UPDATE work_items SET status='working',updated_at=? WHERE id=?").run(nowIso(), row.work_item_id);
  const promise = runFixedPowerShell(transcriptProcessScript);
  activeProcesses.set(row.id, { kill() {} });
  try {
    const output = await promise;
    const finished = nowIso();
    db.prepare("UPDATE agent_runs SET status='review',result=?,updated_at=? WHERE id=?").run(output || `Processed ${files.length} transcript file${files.length === 1 ? "" : "s"} through the Zoom Transcript Router.`, finished, row.id);
    if (row.work_item_id) { db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(finished, row.work_item_id); eventFor(row.work_item_id, "agent_returned", "Zoom Transcript Router completed."); }
  } catch (error) {
    const finished = nowIso();
    db.prepare("UPDATE agent_runs SET status='error',error=?,updated_at=? WHERE id=?").run(error.message, finished, row.id);
    if (row.work_item_id) db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(finished, row.work_item_id);
  } finally {
    activeProcesses.delete(row.id);
  }
}

async function launchTranscriptRoute({ item, intent, contextManifest }) {
  const existing = db.prepare("SELECT * FROM agent_runs WHERE work_item_id=? AND status IN ('queued','working','waiting_on_user') ORDER BY created_at DESC LIMIT 1").get(item.id);
  if (existing) {
    eventFor(item.id, "agent_run_reused", "An active assignment already owns this card, so Command Center did not create a duplicate.");
    return mapRun(existing);
  }
  const now = nowIso();
  const id = randomUUID();
  const waitingReason = "Download the Zoom transcript and leave the .vtt, .srt, or transcript-like .txt file in Downloads. Command Center will resume automatically.";
  db.prepare(`INSERT INTO agent_runs(id,work_item_id,company_slug,scope,intent,title,allowed_sources,status,result,error,revision_of,input_hash,skill_id,executor_type,context_manifest,waiting_reason,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'waiting_on_user','','',NULL,?,'zoom-transcript-router','allowlisted_local_workflow',?,?,?,?)`).run(id, item.id, item.company_slug, "item", intent, `${item.title} · Zoom Transcript Router`, JSON.stringify(["transcripts", "ai_os", "project_files"]), createHash("sha256").update(intent).digest("hex").slice(0, 12), JSON.stringify(contextManifest), waitingReason, now, now);
  db.prepare("UPDATE work_items SET status='waiting_on_user',updated_at=? WHERE id=?").run(now, item.id);
  eventFor(item.id, "waiting_on_user", waitingReason);
  const row = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id);
  if (localWorkflowsEnabled) void resumeTranscriptRun(row);
  return mapRun(row);
}

if (localWorkflowsEnabled) setInterval(() => {
    const waiting = db.prepare("SELECT * FROM agent_runs WHERE skill_id='zoom-transcript-router' AND status='waiting_on_user'").all();
    for (const row of waiting) void resumeTranscriptRun(row);
  }, 60_000).unref();

function proposeDraftLearning(mailMessageId) {
  const row = db.prepare(`${mailSelect} WHERE m.id=?`).get(mailMessageId);
  if (!row?.draft_id || !row.generated_body || !row.current_body || row.generated_body.trim() === row.current_body.trim()) return null;
  const before = row.generated_body.trim();
  const after = row.current_body.trim();
  const ratio = Math.abs(after.length - before.length) / Math.max(1, before.length);
  const observations = [];
  if (after.length < before.length * 0.8) observations.push("keep replies materially shorter");
  if (!after.includes("—") && before.includes("—")) observations.push("avoid em dashes");
  if (!/:\s*$/.test(after.split("\n")[0] || "") && /:\s*$/.test(before.split("\n")[0] || "")) observations.push("avoid colon-led openings");
  if (!observations.length && ratio < 0.12) return null;
  if (!observations.length) observations.push("follow the tighter wording and structure in Jake's edited version");
  const duplicate = db.prepare("SELECT id FROM preference_rules WHERE status='proposed' AND category='writing' AND rationale LIKE ?").get(`%${row.subject.slice(0, 80)}%`);
  if (duplicate) return duplicate.id;
  const id = randomUUID();
  const now = nowIso();
  db.prepare(`INSERT INTO preference_rules(id,title,rationale,instruction,scope_type,scope_value,category,status,evidence_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?, 'writing','proposed',?,?,?)`).run(id, "Learn from an edited reply", `Jake materially edited the proposed reply to “${row.subject}.”`, `For future email drafts, ${observations.join(" and ")}.`, row.company_slug ? "company" : "skill", row.company_slug || "draft-executive-email", JSON.stringify([{ mailMessageId, beforeLength: before.length, afterLength: after.length }]), now, now);
  return id;
}

function searchAll(query) {
  const term = `%${String(query || "").slice(0, 200)}%`;
  if (term === "%%") return [];
  const items = db.prepare(`SELECT w.id, w.title, w.summary, w.company_slug, c.display_name AS company_name
    FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug
    WHERE w.title LIKE ? OR w.summary LIKE ? OR w.why_now LIKE ? LIMIT 30`).all(term, term, term).map((row) => ({ kind: "work_item", id: row.id, title: row.title, excerpt: row.summary, companySlug: row.company_slug, companyName: row.company_name }));
  const notes = db.prepare("SELECT id,title,body,company_slug FROM notes WHERE title LIKE ? OR body LIKE ? LIMIT 30").all(term, term).map((row) => ({ kind: "note", id: row.id, title: row.title, excerpt: row.body.slice(0, 240), companySlug: row.company_slug }));
  const runs = db.prepare("SELECT id,title,result,work_item_id,company_slug FROM agent_runs WHERE title LIKE ? OR result LIKE ? LIMIT 20").all(term, term).map((row) => ({ kind: "agent_run", id: row.id, title: row.title, excerpt: row.result.slice(0, 240), workItemId: row.work_item_id, companySlug: row.company_slug }));
  const mail = db.prepare("SELECT id,subject,sender_name,sender_email,preview,company_slug FROM mail_messages WHERE subject LIKE ? OR sender_name LIKE ? OR sender_email LIKE ? OR preview LIKE ? LIMIT 30").all(term, term, term, term).map((row) => ({ kind: "mail", id: row.id, title: row.subject, excerpt: `${row.sender_name || row.sender_email} · ${row.preview}`, companySlug: row.company_slug }));
  return [...items, ...notes, ...runs, ...mail];
}

function applyCardInstruction(id, instruction) {
  const current = db.prepare("SELECT * FROM work_items WHERE id=?").get(id);
  if (!current) throw requestError("Unknown work item.", 404);
  const safeInstruction = String(instruction || "").trim().slice(0, 4000);
  if (!safeInstruction) throw requestError("Describe what you want to update.");
  const companies = db.prepare("SELECT slug,display_name FROM companies WHERE active=1").all()
    .map((company) => ({ slug: company.slug, displayName: company.display_name, aliases: company.slug === "firm" ? ["Serent", "Serent / Firm"] : [] }));
  const parsed = parseCardCommand({ instruction: safeInstruction, current, companies, now: new Date() });
  if (parsed.clarification) return { handled: true, updated: workItemById(id), changes: [], remainingIntent: "", clarification: parsed.clarification, message: parsed.clarification, undoToken: "" };
  if (!parsed.handled) return { handled: false, updated: workItemById(id), changes: [], remainingIntent: safeInstruction, clarification: "", message: "", undoToken: "" };

  const commandId = randomUUID();
  const now = nowIso();
  const fields = Object.keys(parsed.patch);
  const previous = cardCommandSnapshot(current, fields);
  if (parsed.patch.status === "done") {
    previous.projectPlanItems = db.prepare(`SELECT p.id,p.status FROM project_plan_items p
      JOIN project_action_links l ON l.project_plan_item_id=p.id WHERE l.work_item_id=?`).all(id);
  }
  applyCardCommandPatch(id, parsed.patch);
  db.prepare(`INSERT INTO card_commands(id,work_item_id,instruction,previous_json,next_json,status,created_at)
    VALUES(?,?,?,?,?,'applied',?)`).run(commandId, id, safeInstruction, JSON.stringify(previous), JSON.stringify(parsed.patch), now);
  const labels = [...new Set(parsed.changes.map((change) => change.label))];
  const message = `Updated ${labels.join(", ")}.`;
  eventFor(id, "command_applied", `${message} Jake wrote: ${safeInstruction}`);
  if (Object.hasOwn(parsed.patch, "company_slug")) {
    const linkedMail = db.prepare("SELECT id FROM mail_messages WHERE action_work_item_id=? LIMIT 1").get(id);
    if (linkedMail) db.prepare("UPDATE mail_messages SET company_slug=?,updated_at=? WHERE id=?").run(parsed.patch.company_slug, now, linkedMail.id);
  }
  if (parsed.patch.status === "done") {
    db.prepare(`UPDATE project_plan_items SET status='complete',updated_at=? WHERE id IN
      (SELECT project_plan_item_id FROM project_action_links WHERE work_item_id=?)`).run(now, id);
  }
  return { handled: true, updated: workItemById(id), changes: parsed.changes, remainingIntent: parsed.remainingIntent, clarification: "", message, undoToken: commandId };
}

reconcileAllProjects();
setInterval(() => reconcileAllProjects(), 60 * 60 * 1000).unref();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    const origin = request.headers.origin || "";
    if (origin && origin !== allowedOrigin) return responseJson(response, 403, { error: "Request origin is not allowed." });
    if (request.method === "OPTIONS") return responseJson(response, 204, {});
    if (origin && request.method !== "GET" && request.headers["x-serent-command-center"] !== "1") return responseJson(response, 403, { error: "Command Center request marker is required." });
    if (request.method === "GET" && url.pathname === "/api/health") return responseJson(response, 200, { status: "ready", checkedAt: nowIso(), activeJobs: activeProcesses.size, database: databasePath });
    if (request.method === "GET" && url.pathname === "/api/pm-agent") return responseJson(response, 200, pmAgentPayload());
    if (request.method === "POST" && url.pathname === "/api/pm-agent/run") {
      const body = await readJsonBody(request);
      const kind = ["manual", "morning", "pulse"].includes(body.kind) ? body.kind : "manual";
      return responseJson(response, 200, await runPmAgent(kind));
    }
    if (request.method === "PATCH" && url.pathname === "/api/pm-agent/config") {
      const body = await readJsonBody(request); const current = db.prepare("SELECT * FROM pm_agent_config WHERE id='default'").get(); const now = nowIso();
      const enabled = body.enabled === undefined ? current.enabled : body.enabled ? 1 : 0;
      const morningTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.morningTime || "")) ? String(body.morningTime) : current.morning_time;
      const pulseMinutes = body.pulseMinutes === undefined ? current.pulse_minutes : Math.max(15, Math.min(240, Number(body.pulseMinutes) || 30));
      const maxConcurrent = body.maxConcurrent === undefined ? current.max_concurrent : Math.max(1, Math.min(3, Number(body.maxConcurrent) || 2));
      db.prepare("UPDATE pm_agent_config SET mode='observer',enabled=?,morning_time=?,pulse_minutes=?,max_concurrent=?,updated_at=? WHERE id='default'").run(enabled, morningTime, pulseMinutes, maxConcurrent, now);
      return responseJson(response, 200, pmAgentPayload());
    }
    if (request.method === "POST" && url.pathname === "/api/pm-agent/links") {
      const body = await readJsonBody(request); const threadId = String(body.threadId || ""); const workItemId = String(body.workItemId || ""); const now = nowIso();
      if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error("Choose a valid Codex task.");
      if (!db.prepare("SELECT id FROM work_items WHERE id=?").get(workItemId)) throw new Error("The work item no longer exists.");
      db.prepare(`INSERT INTO pm_thread_links(thread_id,work_item_id,title,status,created_at,updated_at) VALUES(?,?,?,'confirmed',?,?)
        ON CONFLICT(thread_id) DO UPDATE SET work_item_id=excluded.work_item_id,title=excluded.title,status='confirmed',updated_at=excluded.updated_at`).run(threadId, workItemId, String(body.title || "").slice(0,240), now, now);
      return responseJson(response, 200, await runPmAgent("manual"));
    }
    if (request.method === "GET" && url.pathname === "/api/bootstrap") return responseJson(response, 200, bootstrapPayload(Object.fromEntries(url.searchParams)));
    if (request.method === "GET" && url.pathname === "/api/work-items") return responseJson(response, 200, queryWorkItems(Object.fromEntries(url.searchParams)));
    if (request.method === "GET" && url.pathname === "/api/projects") return responseJson(response, 200, queryProjects());
    if (request.method === "POST" && url.pathname === "/api/projects/ingest") {
      const body = await readJsonBody(request);
      const changed = upsertSourceProjects("box",{ projects: [body] });
      if (!changed) throw new Error("An approved, source-backed project plan is required.");
      const project = db.prepare("SELECT id FROM projects WHERE source_provider='box' AND source_id=?").get(String(body.sourceId));
      return responseJson(response, 201,projectDetail(project.id));
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && request.method === "GET") {
      const project = projectDetail(decodeURIComponent(projectMatch[1]));
      if (!project) throw new Error("Unknown project.");
      return responseJson(response, 200, project);
    }
    const projectReconcileMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reconcile$/);
    if (projectReconcileMatch && request.method === "POST") {
      const project = reconcileProject(decodeURIComponent(projectReconcileMatch[1]));
      if (!project) throw new Error("Unknown project.");
      return responseJson(response, 200, project);
    }
    const planItemMatch = url.pathname.match(/^\/api\/project-plan-items\/([^/]+)$/);
    if (planItemMatch && request.method === "PATCH") {
      const id = decodeURIComponent(planItemMatch[1]);
      const current = db.prepare("SELECT * FROM project_plan_items WHERE id=?").get(id);
      if (!current) throw new Error("Unknown project-plan item.");
      const body = await readJsonBody(request);
      const status = ["planned","active","blocked","complete"].includes(body.status) ? body.status : current.status;
      const owner = typeof body.owner === "string" ? body.owner.trim().slice(0,240) || current.owner_label : current.owner_label;
      const dueDate = body.dueDate === undefined ? current.due_date : body.dueDate ? String(body.dueDate).slice(0,10) : null;
      db.prepare("UPDATE project_plan_items SET status=?,owner_label=?,due_date=?,updated_at=? WHERE id=?").run(status,owner,dueDate,nowIso(),id);
      const project = reconcileProject(current.project_id);
      return responseJson(response, 200, project);
    }
    if (request.method === "GET" && url.pathname === "/api/calendar") return responseJson(response, 200, { events: queryCalendar(Object.fromEntries(url.searchParams)), receipt: sourceReceipts().find((item) => item.source === "calendar") || null });
    if (request.method === "POST" && url.pathname === "/api/calendar/refresh") {
      if (!calendarRefreshPromise) calendarRefreshPromise = syncCalendar().catch(() => null).finally(() => { calendarRefreshPromise = null; });
      return responseJson(response, 202, { status: "working" });
    }
    if (request.method === "POST" && url.pathname === "/api/work-items") {
      const body = await readJsonBody(request);
      const title = String(body.title || "").trim().slice(0, 240);
      if (!title) throw new Error("A work-item title is required.");
      const sourceKey = String(body.sourceKey || `manual-${randomUUID()}`).trim().slice(0, 500);
      const existing = db.prepare("SELECT id FROM work_items WHERE source_provider='manual' AND source_key=?").get(sourceKey);
      if (existing) {
        const row = db.prepare(`SELECT w.*,c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(existing.id);
        return responseJson(response, 200, hydrateWorkItem(row));
      }
      const companySlug = body.companySlug && db.prepare("SELECT slug FROM companies WHERE slug=?").get(body.companySlug) ? body.companySlug : null;
      const id = randomUUID();
      const now = nowIso();
      const type = String(body.type || "follow_up").trim().slice(0, 120);
      const summary = String(body.summary || title).trim().slice(0, 4000);
      const whyNow = String(body.whyNow || "Jake explicitly committed to this action.").trim().slice(0, 2000);
      const priority = ["urgent","high","normal","low"].includes(body.priority) ? body.priority : "normal";
      const suggestedAction = String(body.suggestedAction || title).trim().slice(0, 4000);
      const dueAt = body.dueAt ? new Date(body.dueAt).toISOString() : null;
      const preparation = defaultPreparationPolicy({ type, title, suggestedAction, preparationMode: body.preparationMode, preparationSkill: body.preparationSkill, preparationInstruction: body.preparationInstruction });
      db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,due_at,source_provider,source_key,decision_state,preparation_mode,preparation_skill,preparation_instruction,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,'to_review',?,?, 'manual',?,'committed',?,?,?,?,?)`).run(id,type,companySlug,title,summary,whyNow,priority,suggestedAction,dueAt,sourceKey,preparation.mode,preparation.skill,preparation.instruction,now,now);
      db.prepare(`INSERT INTO source_references(id,work_item_id,provider,label,source_id,source_path,source_url,retrieved_at,freshness)
        VALUES(?,?, 'manual','Captured from Jake in Codex',?,'','',?,'live')`).run(randomUUID(),id,sourceKey,now);
      eventFor(id,"created","Captured from Jake's conversational commitment in Codex.");
      const row = db.prepare(`SELECT w.*,c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(id);
      return responseJson(response, 201, hydrateWorkItem(row));
    }
    if (request.method === "GET" && url.pathname === "/api/mail") return responseJson(response, 200, { items: queryMail(Object.fromEntries(url.searchParams)), counts: bootstrapPayload().mailCounts, receipt: sourceReceipts().find((item) => item.source === "mail") || null });
    if (request.method === "POST" && url.pathname === "/api/mail/refresh") {
      if (!mailRefreshPromise) mailRefreshPromise = syncMail().catch(() => null).finally(() => { mailRefreshPromise = null; });
      return responseJson(response, 202, { status: "working" });
    }

    const mailDraftMatch = url.pathname.match(/^\/api\/mail\/([^/]+)\/draft$/);
    if (mailDraftMatch && request.method === "POST") {
      const id = decodeURIComponent(mailDraftMatch[1]);
      const body = await readJsonBody(request);
      const run = await launchMailDraft(id, { automatic: false, feedback: String(body.feedback || "").slice(0, 2000) });
      return responseJson(response, 202, run);
    }
    if (mailDraftMatch && request.method === "PATCH") {
      const id = decodeURIComponent(mailDraftMatch[1]);
      const body = await readJsonBody(request);
      const draft = db.prepare("SELECT * FROM mail_drafts WHERE mail_message_id=?").get(id);
      if (!draft) throw new Error("This message has no draft yet.");
      const value = String(body.body ?? draft.current_body).slice(0, 50000);
      if (value !== draft.current_body) {
        db.prepare("UPDATE mail_drafts SET current_body=?,status='edited',updated_at=? WHERE id=?").run(value, nowIso(), draft.id);
        db.prepare("INSERT INTO mail_draft_revisions(id,mail_draft_id,body,origin,created_at) VALUES(?,?,?,'manual',?)").run(randomUUID(), draft.id, value, nowIso());
        db.prepare("UPDATE mail_messages SET draft_state='edited',updated_at=? WHERE id=?").run(nowIso(), id);
        const mail = db.prepare("SELECT company_slug FROM mail_messages WHERE id=?").get(id);
        recordFeedback({ eventType: "draft_edited", mailMessageId: id, companySlug: mail?.company_slug, skillId: "draft-executive-email", detail: "Jake edited a proposed email reply.", beforeValue: draft.current_body, afterValue: value });
      }
      return responseJson(response, 200, mapMail(db.prepare(`${mailSelect} WHERE m.id=?`).get(id), true));
    }

    const mailMatch = url.pathname.match(/^\/api\/mail\/([^/]+)$/);
    if (mailMatch && request.method === "GET") return responseJson(response, 200, await mailDetail(decodeURIComponent(mailMatch[1])));
    if (mailMatch && request.method === "PATCH") {
      const id = decodeURIComponent(mailMatch[1]);
      const current = db.prepare("SELECT * FROM mail_messages WHERE id=?").get(id);
      if (!current) throw new Error("Unknown mail message.");
      const body = await readJsonBody(request);
      const company = body.companySlug === undefined ? current.company_slug : (body.companySlug && db.prepare("SELECT slug FROM companies WHERE slug=?").get(body.companySlug) ? body.companySlug : null);
      const reviewState = ["unreviewed", "reviewed", "dismissed"].includes(body.reviewState) ? body.reviewState : current.review_state;
      const hasReplyState = ["needs_reply", "responded", "informational"].includes(body.replyState);
      const replyState = hasReplyState ? body.replyState : current.reply_state;
      const replyOverride = body.replyState === null ? "" : hasReplyState ? body.replyState : current.reply_override;
      const snoozedUntil = body.snoozedUntil === undefined ? current.snoozed_until : body.snoozedUntil || null;
      db.prepare("UPDATE mail_messages SET company_slug=?,review_state=?,reply_state=?,reply_override=?,snoozed_until=?,updated_at=? WHERE id=?").run(company, reviewState, replyState, replyOverride, snoozedUntil, nowIso(), id);
      if (company !== current.company_slug && current.action_work_item_id) db.prepare("UPDATE work_items SET company_slug=?,updated_at=? WHERE id=?").run(company, nowIso(), current.action_work_item_id);
      if (body.promote && !current.action_work_item_id) ensureMailAction(id, { highImpact: true });
      const actionId = current.action_work_item_id || (body.promote ? db.prepare("SELECT action_work_item_id FROM mail_messages WHERE id=?").get(id)?.action_work_item_id : null);
      if (actionId && snoozedUntil && Date.parse(snoozedUntil) > Date.now()) db.prepare("UPDATE work_items SET status='waiting_external',updated_at=? WHERE id=? AND status NOT IN ('done','dismissed')").run(nowIso(),actionId);
      if (actionId && (!snoozedUntil || Date.parse(snoozedUntil) <= Date.now())) db.prepare("UPDATE work_items SET status='to_review',updated_at=? WHERE id=? AND status='waiting_external'").run(nowIso(),actionId);
      const action = body.promote ? "promoted" : snoozedUntil !== current.snoozed_until ? "snoozed" : company !== current.company_slug ? "company_corrected" : replyState !== current.reply_state ? "reply_state_corrected" : "reviewed";
      recordFeedback({ eventType: action, mailMessageId: id, companySlug: company, detail: String(body.detail || action), beforeValue: JSON.stringify({ companySlug: current.company_slug, reviewState: current.review_state, replyState: current.reply_state, snoozedUntil: current.snoozed_until }), afterValue: JSON.stringify({ companySlug: company, reviewState, replyState, snoozedUntil }) });
      if (company !== current.company_slug && company) proposeCompanyRoutingRule(current, company);
      return responseJson(response, 200, mapMail(db.prepare(`${mailSelect} WHERE m.id=?`).get(id), true));
    }

    if (request.method === "GET" && url.pathname === "/api/delegation-preview") return responseJson(response, 200, delegationPreview({ workItemId: url.searchParams.get("workItemId"), mailMessageId: url.searchParams.get("mailMessageId"), skillId: url.searchParams.get("skillId") || "" }));

    const meetingWorkflowMatch = url.pathname.match(/^\/api\/meeting-workflows\/([^/]+)$/);
    if (request.method === "GET" && meetingWorkflowMatch) {
      const detail = await meetingWorkflowDetail(decodeURIComponent(meetingWorkflowMatch[1]));
      if (!detail) throw new Error("This card is not a post-meeting workflow.");
      return responseJson(response, 200, detail);
    }
    const meetingProcessMatch = url.pathname.match(/^\/api\/meeting-workflows\/([^/]+)\/process$/);
    if (request.method === "POST" && meetingProcessMatch) {
      const workItemId = decodeURIComponent(meetingProcessMatch[1]);
      const workflow = db.prepare("SELECT * FROM meeting_workflows WHERE work_item_id=?").get(workItemId);
      if (!workflow) throw new Error("This card is not a post-meeting workflow.");
      if (workflow.state === "processing") return responseJson(response, 200, await meetingWorkflowDetail(workItemId));
      const event = db.prepare("SELECT * FROM calendar_events WHERE id=?").get(workflow.calendar_event_id);
      const body = await readJsonBody(request);
      const candidates = await transcriptCandidatesFor(event);
      let sourcePath = String(body.candidatePath || "");
      if (sourcePath && !candidates.some((item) => path.resolve(item.path) === path.resolve(sourcePath))) throw new Error("That transcript is no longer an eligible match for this meeting.");
      if (!sourcePath && candidates.length === 1 && candidates[0].score >= 12) sourcePath = candidates[0].path;
      if (!sourcePath && candidates.length > 1 && candidates[0].score >= 8 && candidates[0].score - candidates[1].score >= 3) sourcePath = candidates[0].path;
      if (!sourcePath) {
        const state = candidates.length ? "candidate_review" : "waiting_for_transcript";
        db.prepare("UPDATE meeting_workflows SET state=?,error='',updated_at=? WHERE id=?").run(state, nowIso(), workflow.id);
        return responseJson(response, 200, await meetingWorkflowDetail(workItemId));
      }
      await launchMeetingProcessing(workflow, event, sourcePath);
      return responseJson(response, 202, await meetingWorkflowDetail(workItemId));
    }
    const meetingSuggestionMatch = url.pathname.match(/^\/api\/meeting-workflows\/([^/]+)\/suggestions\/([^/]+)$/);
    if (request.method === "PATCH" && meetingSuggestionMatch) {
      const workItemId = decodeURIComponent(meetingSuggestionMatch[1]);
      const suggestionId = decodeURIComponent(meetingSuggestionMatch[2]);
      const belongs = db.prepare(`SELECT s.id FROM meeting_action_suggestions s JOIN meeting_workflows mw ON mw.id=s.meeting_workflow_id WHERE s.id=? AND mw.work_item_id=?`).get(suggestionId, workItemId);
      if (!belongs) throw new Error("Unknown meeting follow-up.");
      const body = await readJsonBody(request);
      if (body.decision === "accept") acceptMeetingSuggestion(suggestionId);
      else if (body.decision === "reject") db.prepare("UPDATE meeting_action_suggestions SET decision='rejected',updated_at=? WHERE id=? AND decision='proposed'").run(nowIso(), suggestionId);
      else if (body.decision === "edit") {
        const current = db.prepare("SELECT * FROM meeting_action_suggestions WHERE id=?").get(suggestionId);
        if (current.decision !== "proposed") throw new Error("Only an unreviewed follow-up can be edited.");
        db.prepare("UPDATE meeting_action_suggestions SET title=?,summary=?,suggested_action=?,priority=?,owner_state=?,updated_at=? WHERE id=?")
          .run(String(body.title || current.title).slice(0,240), String(body.summary ?? current.summary).slice(0,4000), String(body.suggestedAction ?? current.suggested_action).slice(0,4000), ["urgent","high","normal","low"].includes(body.priority) ? body.priority : current.priority, ["jake","external"].includes(body.ownerState) ? body.ownerState : current.owner_state, nowIso(), suggestionId);
      } else throw new Error("Choose accept, edit, or reject.");
      return responseJson(response, 200, await meetingWorkflowDetail(workItemId));
    }
    const meetingCompleteMatch = url.pathname.match(/^\/api\/meeting-workflows\/([^/]+)\/complete$/);
    if (request.method === "POST" && meetingCompleteMatch) {
      const workItemId = decodeURIComponent(meetingCompleteMatch[1]);
      const workflow = db.prepare("SELECT * FROM meeting_workflows WHERE work_item_id=?").get(workItemId);
      if (!workflow) throw new Error("This card is not a post-meeting workflow.");
      const proposed = db.prepare("SELECT COUNT(*) AS count FROM meeting_action_suggestions WHERE meeting_workflow_id=? AND decision='proposed'").get(workflow.id).count;
      if (proposed) throw new Error("Accept or ignore each proposed follow-up before finishing the meeting review.");
      const now = nowIso();
      db.prepare("UPDATE meeting_workflows SET state='complete',updated_at=? WHERE id=?").run(now, workflow.id);
      db.prepare("UPDATE work_items SET status='done',resolution='Meeting note saved and follow-up review completed.',resolved_at=?,updated_at=? WHERE id=?").run(now, now, workItemId);
      eventFor(workItemId, "meeting_review_complete", "Meeting note saved and all proposed follow-ups were reviewed.");
      return responseJson(response, 200, await meetingWorkflowDetail(workItemId));
    }
    const meetingNoTranscriptMatch = url.pathname.match(/^\/api\/meeting-workflows\/([^/]+)\/no-transcript$/);
    if (request.method === "POST" && meetingNoTranscriptMatch) {
      const workItemId = decodeURIComponent(meetingNoTranscriptMatch[1]);
      const workflow = db.prepare("SELECT * FROM meeting_workflows WHERE work_item_id=?").get(workItemId);
      if (!workflow) throw new Error("This card is not a post-meeting workflow.");
      if (workflow.state === "processing") throw new Error("This transcript is already being processed.");
      const now = nowIso();
      db.prepare("UPDATE meeting_workflows SET state='complete',error='',updated_at=? WHERE id=?").run(now, workflow.id);
      db.prepare("UPDATE work_items SET status='done',resolution='No transcript was recorded for this meeting.',suggested_action='No transcript follow-through is required.',resolved_at=?,updated_at=? WHERE id=?").run(now, now, workItemId);
      eventFor(workItemId, "no_transcript", "Jake confirmed that no transcript was recorded. The reminder was closed without processing.");
      return responseJson(response, 200, await meetingWorkflowDetail(workItemId));
    }

    const clickUpCompleteMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/complete-clickup$/);
    if (request.method === "POST" && clickUpCompleteMatch) {
      const item = db.prepare(`SELECT w.*,c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(decodeURIComponent(clickUpCompleteMatch[1]));
      if (!item) throw new Error("Unknown work item.");
      return responseJson(response, 202, await launchClickUpCompletion(item));
    }
    const instructionMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/instructions$/);
    if (request.method === "POST" && instructionMatch) {
      const id = decodeURIComponent(instructionMatch[1]);
      const item = db.prepare(`SELECT w.*,c.display_name AS company_name,c.ai_os_path FROM work_items w
        LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(id);
      if (!item) throw requestError("Unknown work item.", 404);
      const body = await readJsonBody(request);
      const mode = String(body.mode || "");
      if (mode === "update") {
        const result = applyCardInstruction(id, body.instruction);
        return responseJson(response, 200, { outcome: result.handled ? "card_updated" : "not_understood", ...result });
      }
      if (!['return_here', 'separate_task'].includes(mode)) throw requestError("Choose Update card, Ask Codex and return here, or Prepare a separate Codex task.");
      const prepared = prepareAssignment(item, {
        destination: mode === "return_here" ? "card" : "separate_task",
        instruction: body.instruction,
        includeScratchpad: Boolean(body.includeScratchpad),
        revisionOf: body.revisionOf || null,
        clientRequestId: body.clientRequestId || "",
      });
      return responseJson(response, prepared.reused ? 200 : 201, { ...prepared, card: workItemById(id) });
    }

    const assignmentCreateMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/assignments$/);
    if (request.method === "POST" && assignmentCreateMatch) {
      const item = db.prepare(`SELECT w.*,c.display_name AS company_name,c.ai_os_path FROM work_items w
        LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(decodeURIComponent(assignmentCreateMatch[1]));
      if (!item) throw requestError("Unknown work item.", 404);
      const body = await readJsonBody(request);
      const prepared = prepareAssignment(item, body);
      return responseJson(response, prepared.reused ? 200 : 201, prepared);
    }

    const assignmentEventMatch = url.pathname.match(/^\/api\/assignments\/([^/]+)\/events$/);
    if (request.method === "POST" && assignmentEventMatch) {
      const authorization = String(request.headers.authorization || "");
      const capability = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
      const body = await readJsonBody(request);
      return responseJson(response, 200, applyAssignmentEvent(decodeURIComponent(assignmentEventMatch[1]), body, capability));
    }

    const assignmentPacketMatch = url.pathname.match(/^\/api\/assignments\/([^/]+)\/packet$/);
    if (request.method === "POST" && assignmentPacketMatch) {
      return responseJson(response, 200, issueAssignmentPacket(decodeURIComponent(assignmentPacketMatch[1])));
    }

    const assignmentCancelMatch = url.pathname.match(/^\/api\/assignments\/([^/]+)\/cancel$/);
    if (request.method === "POST" && assignmentCancelMatch) {
      return responseJson(response, 200, { assignment: cancelPreparedAssignment(decodeURIComponent(assignmentCancelMatch[1])) });
    }

    if (request.method === "POST" && (/^\/api\/work-items\/[^/]+\/codex-task(?:-link)?$/.test(url.pathname) || /^\/api\/codex-tasks\/[^/]+\/callback$/.test(url.pathname))) {
      throw requestError("This legacy Codex-task endpoint is retired. Use the assignment lifecycle endpoints.", 410);
    }

    const cardCommandMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/command$/);
    if (request.method === "POST" && cardCommandMatch) {
      const id = decodeURIComponent(cardCommandMatch[1]);
      const body = await readJsonBody(request);
      return responseJson(response, 200, applyCardInstruction(id, body.instruction));
    }

    const undoCardCommandMatch = url.pathname.match(/^\/api\/card-commands\/([^/]+)\/undo$/);
    if (request.method === "POST" && undoCardCommandMatch) {
      const command = db.prepare("SELECT * FROM card_commands WHERE id=?").get(decodeURIComponent(undoCardCommandMatch[1]));
      if (!command) throw new Error("Unknown card change.");
      if (command.status !== "applied") throw new Error("This card change has already been undone.");
      const previous = JSON.parse(command.previous_json || "{}");
      applyCardCommandPatch(command.work_item_id, previous);
      const now = nowIso();
      db.prepare("UPDATE card_commands SET status='undone',undone_at=? WHERE id=?").run(now, command.id);
      if (Object.hasOwn(previous, "company_slug")) {
        const linkedMail = db.prepare("SELECT id FROM mail_messages WHERE action_work_item_id=? LIMIT 1").get(command.work_item_id);
        if (linkedMail) db.prepare("UPDATE mail_messages SET company_slug=?,updated_at=? WHERE id=?").run(previous.company_slug, now, linkedMail.id);
      }
      if (Array.isArray(previous.projectPlanItems)) {
        const restorePlanStatus = db.prepare("UPDATE project_plan_items SET status=?,updated_at=? WHERE id=?");
        for (const item of previous.projectPlanItems) restorePlanStatus.run(item.status, now, item.id);
      }
      eventFor(command.work_item_id, "command_undone", `Undid card command: ${command.instruction}`);
      return responseJson(response, 200, { updated: workItemById(command.work_item_id), message: "Undid the card change." });
    }

    const workItemMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)$/);
    if (request.method === "GET" && workItemMatch) {
      const id = decodeURIComponent(workItemMatch[1]);
      const row = db.prepare(`SELECT w.*, c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(id);
      if (!row) throw new Error("Unknown work item.");
      return responseJson(response, 200, hydrateWorkItem(row));
    }
    if (request.method === "PATCH" && workItemMatch) {
      const id = decodeURIComponent(workItemMatch[1]);
      const current = db.prepare("SELECT * FROM work_items WHERE id = ?").get(id);
      if (!current) throw new Error("Unknown work item.");
      const body = await readJsonBody(request);
      const allowedStatus = ["to_review", "queued", "working", "waiting_on_user", "waiting_external", "needs_attention", "back_for_review", "done", "dismissed", "error"];
      const requestedCompany = body.companySlug === undefined ? current.company_slug : body.companySlug || null;
      const companySlug = requestedCompany && !db.prepare("SELECT slug FROM companies WHERE slug=? AND active=1").get(requestedCompany) ? current.company_slug : requestedCompany;
      const next = {
        status: allowedStatus.includes(body.status) ? body.status : current.status,
        priority: ["urgent", "high", "normal", "low"].includes(body.priority) ? body.priority : current.priority,
        draft: typeof body.draft === "string" ? body.draft.slice(0, 50000) : current.draft,
        title: typeof body.title === "string" ? body.title.slice(0, 240) : current.title,
        summary: typeof body.summary === "string" ? body.summary.slice(0, 4000) : current.summary,
        suggestedAction: typeof body.suggestedAction === "string" ? body.suggestedAction.slice(0, 4000) : current.suggested_action,
        resolution: typeof body.resolution === "string" ? body.resolution.slice(0, 4000) : current.resolution,
        decisionState: ["proposed","accepted","committed"].includes(body.decisionState) ? body.decisionState : current.decision_state,
        dueAt: body.dueAt === undefined ? current.due_at : body.dueAt ? new Date(body.dueAt).toISOString() : null,
        plannedAt: body.plannedAt === undefined ? current.planned_at : body.plannedAt ? new Date(body.plannedAt).toISOString() : null,
        plannedMinutes: body.plannedMinutes === undefined ? current.planned_minutes : Math.min(240, Math.max(0, Number(body.plannedMinutes || 0))),
        preparationMode: ["manual","auto","none"].includes(body.preparationMode) ? body.preparationMode : current.preparation_mode,
        preparationSkill: typeof body.preparationSkill === "string" ? body.preparationSkill.trim().slice(0,120) : current.preparation_skill,
        preparationInstruction: typeof body.preparationInstruction === "string" ? body.preparationInstruction.trim().slice(0,4000) : current.preparation_instruction,
        companySlug,
      };
      const resolvedAt = ["done", "dismissed"].includes(next.status) ? nowIso() : null;
      db.prepare(`UPDATE work_items SET status=?,priority=?,draft=?,title=?,summary=?,suggested_action=?,resolution=?,decision_state=?,due_at=?,planned_at=?,planned_minutes=?,preparation_mode=?,preparation_skill=?,preparation_instruction=?,company_slug=?,updated_at=?,resolved_at=? WHERE id=?`).run(next.status, next.priority, next.draft, next.title, next.summary, next.suggestedAction, next.resolution, next.decisionState, next.dueAt, next.plannedAt, next.plannedMinutes, next.preparationMode, next.preparationSkill, next.preparationInstruction, next.companySlug, nowIso(), resolvedAt, id);
      if (next.status === "done") {
        db.prepare(`UPDATE project_plan_items SET status='complete',updated_at=? WHERE id IN
          (SELECT project_plan_item_id FROM project_action_links WHERE work_item_id=?)`).run(nowIso(),id);
      }
      const linkedMail = next.companySlug !== current.company_slug ? db.prepare("SELECT * FROM mail_messages WHERE action_work_item_id=? LIMIT 1").get(id) : null;
      if (linkedMail) {
        db.prepare("UPDATE mail_messages SET company_slug=?,updated_at=? WHERE id=?").run(next.companySlug, nowIso(), linkedMail.id);
        if (next.companySlug) proposeCompanyRoutingRule(linkedMail, next.companySlug);
      }
      const eventType = next.status !== current.status ? next.status : next.companySlug !== current.company_slug ? "company_corrected" : "edited";
      eventFor(id, eventType, body.eventDetail || (eventType === "edited" ? "Workbench content updated." : `Moved to ${eventType}.`));
      if (next.status !== current.status || next.priority !== current.priority || next.draft !== current.draft || next.companySlug !== current.company_slug) {
        recordFeedback({ eventType, workItemId: id, mailMessageId: linkedMail?.id || null, companySlug: next.companySlug, detail: body.eventDetail || "Workbench action", beforeValue: JSON.stringify({ status: current.status, priority: current.priority, draft: current.draft, companySlug: current.company_slug }), afterValue: JSON.stringify({ status: next.status, priority: next.priority, draft: next.draft, companySlug: next.companySlug }) });
      }
      if (next.status === "dismissed" && body.feedback) {
        const now = nowIso();
        const ruleId = randomUUID();
        db.prepare(`INSERT INTO preference_rules(id,title,rationale,instruction,scope_type,scope_value,category,status,evidence_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'routing','proposed',?,?,?)`).run(ruleId, "Review a routing rule", String(body.feedback).slice(0, 1200), `Suppress or lower the priority of ${current.type} items like: ${current.title}`, current.company_slug ? "company" : "work_type", current.company_slug || current.type, JSON.stringify([{ workItemId: id, feedback: body.feedback }]), now, now);
      }
      const row = db.prepare(`SELECT w.*, c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(id);
      return responseJson(response, 200, hydrateWorkItem(row));
    }

    if (request.method === "GET" && url.pathname === "/api/notes") {
      const clauses = ["1=1"];
      const params = [];
      if (url.searchParams.get("company") && url.searchParams.get("company") !== "all") { clauses.push("company_slug=?"); params.push(url.searchParams.get("company")); }
      if (url.searchParams.get("type") && url.searchParams.get("type") !== "all") { clauses.push("type=?"); params.push(url.searchParams.get("type")); }
      const rows = db.prepare(`SELECT * FROM notes WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`).all(...params).map(mapNote);
      return responseJson(response, 200, rows);
    }
    if (request.method === "POST" && url.pathname === "/api/notes") {
      const body = await readJsonBody(request);
      const id = randomUUID();
      const now = nowIso();
      db.prepare(`INSERT INTO notes(id,title,body,type,origin,state,company_slug,meeting_id,project_ref,created_at,updated_at)
        VALUES(?,?,?,?,?,'active',?,?,?,?,?)`).run(id, String(body.title || "Quick note").slice(0, 240), String(body.body || "").slice(0, 100000), ["daily","scratch","meeting","project","decision"].includes(body.type) ? body.type : "scratch", body.origin === "agent" ? "agent" : "manual", body.companySlug || null, body.meetingId || null, body.projectRef || null, now, now);
      if (body.workItemId) db.prepare("INSERT OR IGNORE INTO note_links(note_id,work_item_id) VALUES(?,?)").run(id, body.workItemId);
      if (body.mailMessageId) db.prepare("INSERT OR IGNORE INTO mail_note_links(mail_message_id,note_id) VALUES(?,?)").run(body.mailMessageId, id);
      const created = db.prepare("SELECT * FROM notes WHERE id=?").get(id);
      await persistNoteFile(created);
      return responseJson(response, 201, mapNote(db.prepare("SELECT * FROM notes WHERE id=?").get(id)));
    }
    const noteCodexEditMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/codex-edit$/);
    if (request.method === "POST" && noteCodexEditMatch) {
      const note = db.prepare("SELECT * FROM notes WHERE id=?").get(decodeURIComponent(noteCodexEditMatch[1]));
      if (!note) throw new Error("Unknown note.");
      const body = await readJsonBody(request);
      const instruction = String(body.instruction || "").trim().slice(0,4000);
      if (!instruction) throw new Error("Tell Codex what to change in this document.");
      return responseJson(response, 202, await launchNoteEditProposal(note,instruction));
    }
    const noteProposalMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/proposals\/([^/]+)$/);
    if (request.method === "PATCH" && noteProposalMatch) {
      const noteId=decodeURIComponent(noteProposalMatch[1]); const proposalId=decodeURIComponent(noteProposalMatch[2]);
      const note=db.prepare("SELECT * FROM notes WHERE id=?").get(noteId); const proposal=db.prepare("SELECT * FROM note_edit_proposals WHERE id=? AND note_id=?").get(proposalId,noteId);
      if(!note||!proposal) throw new Error("Unknown document edit proposal.");
      const body=await readJsonBody(request); const decision=body.decision;
      if(decision==="accept"&&proposal.status==="ready") {
        const now=nowIso();
        db.prepare("INSERT INTO note_revisions(id,note_id,title,body,origin,summary,created_at) VALUES(?,?,?,?,'manual','Before accepted Codex edit',?)").run(randomUUID(),note.id,note.title,note.body,now);
        db.prepare("UPDATE notes SET title=?,body=?,origin='manual',updated_at=? WHERE id=?").run(proposal.proposed_title||note.title,proposal.proposed_body,now,note.id);
        db.prepare("UPDATE note_edit_proposals SET status='accepted',updated_at=? WHERE id=?").run(now,proposal.id);
        await persistNoteFile(db.prepare("SELECT * FROM notes WHERE id=?").get(note.id));
        recordFeedback({eventType:"note_edit_accepted",companySlug:note.company_slug,detail:proposal.instruction,beforeValue:note.body,afterValue:proposal.proposed_body});
      } else if(decision==="reject") {
        db.prepare("UPDATE note_edit_proposals SET status='rejected',updated_at=? WHERE id=?").run(nowIso(),proposal.id);
        recordFeedback({eventType:"note_edit_rejected",companySlug:note.company_slug,detail:proposal.instruction});
      } else throw new Error("This proposal cannot be updated with that decision.");
      return responseJson(response,200,mapNote(db.prepare("SELECT * FROM notes WHERE id=?").get(note.id)));
    }
    const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
    if (request.method === "PATCH" && noteMatch) {
      const id = decodeURIComponent(noteMatch[1]);
      const current = db.prepare("SELECT * FROM notes WHERE id=?").get(id);
      if (!current) throw new Error("Unknown note.");
      const body = await readJsonBody(request);
      if ((typeof body.title === "string" && body.title !== current.title) || (typeof body.body === "string" && body.body !== current.body)) {
        db.prepare("INSERT INTO note_revisions(id,note_id,title,body,origin,summary,created_at) VALUES(?,?,?,?,'manual','Autosaved revision',?)").run(randomUUID(),current.id,current.title,current.body,nowIso());
      }
      db.prepare(`UPDATE notes SET title=?,body=?,type=?,state=?,company_slug=?,meeting_id=?,project_ref=?,updated_at=? WHERE id=?`).run(
        typeof body.title === "string" ? body.title.slice(0, 240) : current.title,
        typeof body.body === "string" ? body.body.slice(0, 100000) : current.body,
        ["daily","scratch","meeting","project","decision"].includes(body.type) ? body.type : current.type,
        ["inbox","active","pinned","archived"].includes(body.state) ? body.state : current.state,
        body.companySlug === undefined ? current.company_slug : body.companySlug || null,
        body.meetingId === undefined ? current.meeting_id : body.meetingId || null,
        body.projectRef === undefined ? current.project_ref : body.projectRef || null,
        nowIso(), id);
      if (body.workItemId) db.prepare("INSERT OR IGNORE INTO note_links(note_id,work_item_id) VALUES(?,?)").run(id, body.workItemId);
      if (body.mailMessageId) db.prepare("INSERT OR IGNORE INTO mail_note_links(mail_message_id,note_id) VALUES(?,?)").run(body.mailMessageId, id);
      const saved = db.prepare("SELECT * FROM notes WHERE id=?").get(id);
      await persistNoteFile(saved);
      return responseJson(response, 200, mapNote(saved));
    }
    const promoteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)\/promote$/);
    if (request.method === "POST" && promoteMatch) {
      const note = db.prepare("SELECT * FROM notes WHERE id=?").get(decodeURIComponent(promoteMatch[1]));
      if (!note) throw new Error("Unknown note.");
      const body = await readJsonBody(request);
      const id = randomUUID();
      const now = nowIso();
      db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,source_provider,source_key,created_at,updated_at)
        VALUES(?,?,?,?,?,'Captured from Jake\'s notes.','normal',1,'to_review',?,'note',?,?,?)`).run(id, body.type || "follow_up", note.company_slug, body.title || note.title, note.body.slice(0, 1600), body.suggestedAction || "Review and decide the next action.", note.id, now, now);
      db.prepare("INSERT INTO note_links(note_id,work_item_id) VALUES(?,?)").run(note.id, id);
      eventFor(id, "created", "Promoted from a note.");
      return responseJson(response, 201, hydrateWorkItem(db.prepare(`SELECT w.*,c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(id)));
    }

    if (request.method === "GET" && url.pathname === "/api/agent-runs") return responseJson(response, 200, db.prepare("SELECT * FROM agent_runs ORDER BY created_at DESC").all().map(mapRun));
    if (request.method === "POST" && url.pathname === "/api/agent-runs") {
      const body = await readJsonBody(request);
      const item = body.workItemId ? db.prepare(`SELECT w.*,c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(body.workItemId) : null;
      if (body.workItemId && !item) throw new Error("Unknown work item.");
      const scope = ["item","company","note","workspace"].includes(body.scope) ? body.scope : "item";
      const preview = delegationPreview({ workItemId: item?.id || null, mailMessageId: body.mailMessageId || null, skillId: String(body.skillId || "") });
      const route = preview.selectedSkill;
      const allowedSources = item ? [...new Set(db.prepare("SELECT provider FROM source_references WHERE work_item_id=?").all(item.id).map((row) => row.provider).concat(["ai_os", "project_files"]))] : ["ai_os", "project_files"];
      const notes = contextualNotes({ workItemId: item?.id || null, companySlug: item?.company_slug || body.companySlug || null });
      const rules = activeRules({ companySlug: item?.company_slug || body.companySlug || null, source: item?.source_provider || "", workType: item?.type || "", skillId: route.id });
      const context = item ? `Selected work item: ${item.title}\nSummary: ${item.summary}\nWhy now: ${item.why_now}\nSuggested action: ${item.suggested_action}\nCompany: ${item.company_name || "Unassigned"}\n\nRelevant notes:\n${notes.map((note) => `- ${note.title}: ${note.body.slice(0, 1600)}`).join("\n") || "None."}\n\nApproved Command Center rules:\n${rules.map((rule) => `- ${rule.instruction}`).join("\n") || "None."}\n` : "";
      const intent = `${context}\nJake's request: ${String(body.intent || "").trim()}`;
      if (item?.decision_state === "proposed") {
        db.prepare("UPDATE work_items SET decision_state='accepted',updated_at=? WHERE id=?").run(nowIso(), item.id);
        eventFor(item.id, "accepted", "Jake asked Codex to work on this action and return the result to the card.");
      }
      recordFeedback({ eventType: body.skillId && body.skillId !== resolveSkillRoute({ item }).id ? "skill_overridden" : "delegated", workItemId: item?.id || null, companySlug: item?.company_slug || body.companySlug || null, skillId: route.id, detail: String(body.intent || "").slice(0, 1200) });
      if (route.id === "zoom-transcript-router" && item) return responseJson(response, 202, await launchTranscriptRoute({ item, intent, contextManifest: preview.contextManifest }));
      const run = await launchAgentRun({ workItemId: item?.id || null, mailMessageId: body.mailMessageId || null, companySlug: item?.company_slug || body.companySlug || null, scope, intent, title: item ? `${item.company_name} · ${item.title}` : "Scoped Serent assignment", allowedSources, revisionOf: body.revisionOf || null, skillId: route.id, executorType: route.executorType, contextManifest: preview.contextManifest });
      return responseJson(response, 202, run);
    }
    if (request.method === "POST" && url.pathname === "/api/source-refresh") {
      const body = await readJsonBody(request);
      const source = String(body.source || "");
      if (source === "mail") {
        if (!mailRefreshPromise) mailRefreshPromise = syncMail().catch(() => null).finally(() => { mailRefreshPromise = null; });
        return responseJson(response, 202, { status: "working" });
      }
      if (!sourcePrompts[source]) throw new Error("Unknown source.");
      const active = db.prepare("SELECT * FROM agent_runs WHERE scope='source' AND status IN ('queued','working') AND intent LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%${source}%`);
      if (active) return responseJson(response, 200, mapRun(active));
      const run = await launchAgentRun({ scope: "source", intent: sourceOutputContract(source), title: `Refresh · ${source}`, allowedSources: [source], sourceRefresh: source });
      return responseJson(response, 202, run);
    }
    if (request.method === "POST" && url.pathname === "/api/approvals") {
      const body = await readJsonBody(request);
      const id = randomUUID();
      const now = nowIso();
      db.prepare(`INSERT INTO approvals(id,work_item_id,action_type,destination,payload_summary,decision,created_at)
        VALUES(?,?,?,?,?,'approved_locally',?)`).run(id, body.workItemId || null, String(body.actionType || "external_action").slice(0, 120), String(body.destination || "Explicit Codex task").slice(0, 240), String(body.payloadSummary || "").slice(0, 4000), now);
      if (body.workItemId) eventFor(body.workItemId, "approved", "Recorded local approval. No external action was executed.");
      return responseJson(response, 201, { id, decision: "approved_locally", createdAt: now, executed: false });
    }
    if (request.method === "POST" && url.pathname === "/api/feedback-events") {
      const body = await readJsonBody(request);
      const id = recordFeedback({ eventType: String(body.eventType || "feedback").slice(0, 120), workItemId: body.workItemId || null, mailMessageId: body.mailMessageId || null, companySlug: body.companySlug || null, skillId: body.skillId || null, detail: String(body.detail || "").slice(0, 4000), beforeValue: String(body.beforeValue || "").slice(0, 50000), afterValue: String(body.afterValue || "").slice(0, 50000) });
      const proposedRuleId = body.eventType === "draft_copied" && body.mailMessageId ? proposeDraftLearning(body.mailMessageId) : null;
      return responseJson(response, 201, { id, proposedRuleId });
    }
    if (request.method === "GET" && url.pathname === "/api/search") return responseJson(response, 200, searchAll(url.searchParams.get("q")));
    if (request.method === "GET" && url.pathname === "/api/policies") return responseJson(response, 200, db.prepare("SELECT * FROM preference_rules ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,updated_at DESC").all().map(mapRule));
    if (request.method === "POST" && url.pathname === "/api/policies") {
      const body = await readJsonBody(request);
      const id = randomUUID(); const now = nowIso();
      const scopeType = ["global","company","source","work_type","skill"].includes(body.scopeType) ? body.scopeType : "global";
      db.prepare(`INSERT INTO preference_rules(id,title,rationale,instruction,scope_type,scope_value,category,status,evidence_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'proposed','[]',?,?)`).run(id, String(body.title || "New Command Center rule").slice(0, 240), String(body.rationale || "Created by Jake.").slice(0, 2000), String(body.instruction || "").slice(0, 4000), scopeType, String(body.scopeValue || "").slice(0, 240), String(body.category || "routing").slice(0, 120), now, now);
      return responseJson(response, 201, mapRule(db.prepare("SELECT * FROM preference_rules WHERE id=?").get(id)));
    }
    const policyMatch = url.pathname.match(/^\/api\/policies\/([^/]+)$/);
    if (policyMatch && request.method === "PATCH") {
      const id = decodeURIComponent(policyMatch[1]); const current = db.prepare("SELECT * FROM preference_rules WHERE id=?").get(id);
      if (!current) throw new Error("Unknown Command Center rule.");
      const body = await readJsonBody(request);
      const status = ["proposed","accepted","rejected","retired"].includes(body.status) ? body.status : current.status;
      const scopeType = ["global","company","source","work_type","skill"].includes(body.scopeType) ? body.scopeType : current.scope_type;
      db.prepare("UPDATE preference_rules SET title=?,rationale=?,instruction=?,scope_type=?,scope_value=?,category=?,status=?,updated_at=? WHERE id=?").run(String(body.title ?? current.title).slice(0,240), String(body.rationale ?? current.rationale).slice(0,2000), String(body.instruction ?? current.instruction).slice(0,4000), scopeType, String(body.scopeValue ?? current.scope_value).slice(0,240), String(body.category ?? current.category).slice(0,120), status, nowIso(), id);
      recordFeedback({ eventType: `rule_${status}`, detail: current.title, beforeValue: current.status, afterValue: status });
      return responseJson(response, 200, mapRule(db.prepare("SELECT * FROM preference_rules WHERE id=?").get(id)));
    }

    return responseJson(response, 404, { error: "Not found." });
  } catch (error) {
    return responseJson(response, Number(error?.statusCode || 400), { error: error instanceof Error ? error.message : "Request failed." });
  }
});

server.listen(port, host, () => {
  console.log(`Serent Command Center control server listening at http://${host}:${port}`);
  reconcileAssignmentAttention();
  const reconciliationTimer=setInterval(()=>reconcileAssignmentAttention(),15000);
  reconciliationTimer.unref();
});
