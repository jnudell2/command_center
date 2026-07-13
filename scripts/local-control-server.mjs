import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { clearSerentTokenCache, fetchActiveMail, fetchCalendarEvents, fetchMailAttachments, fetchMailBody, htmlToText } from "./graph-mail.mjs";

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
const localWorkflowsEnabled = process.env.SERENT_TEND_DISABLE_LOCAL_WORKFLOWS !== "1";
const transcriptRoot = path.join(homedir(), "Projects", "ai-operating-system-transcripts");
const transcriptInbox = path.join(transcriptRoot, "inbox");
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
ensureColumn("mail_messages", "reply_override", "TEXT NOT NULL DEFAULT ''");
ensureColumn("mail_drafts", "origin_mode", "TEXT NOT NULL DEFAULT 'manual'");
db.prepare("UPDATE work_items SET decision_state='committed' WHERE source_provider='clickup' AND decision_state='proposed'").run();
db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,datetime('now'))").run();

const nowIso = () => new Date().toISOString();
const localDateKey = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

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

recoverInterruptedRuns();

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

function normalizedSubject(value) {
  return String(value || "").toLowerCase().replace(/^\s*((re|fw|fwd):\s*)+/i, "").replace(/\s+/g, " ").trim();
}

function addresses(recipients) {
  return (Array.isArray(recipients) ? recipients : []).map((item) => ({
    name: item?.emailAddress?.name || "",
    email: item?.emailAddress?.address || "",
  }));
}

function inferCompany(message) {
  const haystack = `${message.subject || ""} ${message.bodyPreview || ""} ${message.from?.emailAddress?.address || ""}`.toLowerCase();
  const candidates = [
    ["avionte", ["aviont", "avionte"]],
    ["stockiq", ["stockiq", "stock iq"]],
    ["govworx", ["govworx"]],
  ];
  return candidates.find(([, keys]) => keys.some((key) => haystack.includes(key)))?.[0] || null;
}

function classifyMail(message, sentByConversation, sentBySubject, companySlug = null) {
  const subject = String(message.subject || "");
  const preview = String(message.bodyPreview || "");
  const text = `${subject}\n${preview}`.toLowerCase();
  const inboundAt = Date.parse(message.receivedDateTime || 0);
  const laterSent = Math.max(sentByConversation.get(message.conversationId) || 0, sentBySubject.get(normalizedSubject(subject)) || 0);
  const automatic = /newsletter|unsubscribe|no[- ]?reply|notification|alert|digest|calendar|invitation|accepted:|declined:|out of office|automatic reply|do not reply|webinar|survey|event feedback|challenge results|sent a message in teams|see how .* delivers|demo session|placeholder:|gold star/.test(text);
  const question = /could you|can you|would you|please (review|send|confirm|share|let|advise)|let me know|your thoughts|your feedback|need your|are you able|when can|do you have|your reaction|please opine|please respond/.test(text);
  const blocking = /urgent|today|tomorrow|deadline|blocked|need (this|your|an answer)|waiting on|approval|sign[- ]?off|decision/.test(text);
  const responded = laterSent > inboundAt;
  const needsReply = !automatic && question && !responded;
  const ageHours = Math.max(0, (Date.now() - inboundAt) / 3_600_000);
  const confidence = responded ? 0.98 : needsReply ? Math.min(0.96, 0.72 + (blocking ? 0.14 : 0) + (message.importance === "high" ? 0.08 : 0)) : automatic ? 0.95 : 0.67;
  const reason = responded
    ? "A later message from Jake appears in Sent Items on this conversation or subject."
    : needsReply
      ? `${question ? "The message asks Jake for a response or decision." : "The message appears actionable."}${blocking ? " Timing or dependency language raises its urgency." : ""}`
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
    for (const message of payload.inbox) {
      const companySlug = inferCompany(message);
      const classification = classifyMail(message, sentByConversation, sentBySubject, companySlug);
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

function queryMail(filters = {}) {
  const clauses = ["1=1"];
  const params = [];
  const view = filters.view || "needs_reply";
  if (view === "needs_reply") clauses.push("m.freshness='live' AND m.reply_state='needs_reply' AND (m.snoozed_until IS NULL OR datetime(m.snoozed_until) <= datetime('now'))");
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
    needs_reply: db.prepare("SELECT COUNT(*) AS count FROM mail_messages WHERE freshness='live' AND reply_state='needs_reply' AND (snoozed_until IS NULL OR datetime(snoozed_until) <= datetime('now'))").get().count,
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
  const text = `${item?.type || ""} ${item?.title || ""} ${item?.source_provider || ""}`.toLowerCase();
  if (text.includes("transcript")) return routeById("zoom-transcript-router");
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

function threadOutcome(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const turn = turns.at(-1);
  const status = String(turn?.status || "");
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const messages = items.filter((item) => item?.type === "agentMessage" && typeof item.text === "string");
  const final = [...messages].reverse().find((item) => item.phase === "final_answer")?.text || (status === "completed" ? messages.at(-1)?.text || "" : "");
  return { status, final, error: turn?.error?.message || "" };
}

async function readCodexThread(threadId) {
  const cli = await resolveCodexCli();
  return new Promise((resolve, reject) => {
    const child = spawn(cli,["app-server","--stdio"],{cwd:aiOsRoot,env:process.env,windowsHide:true});
    let buffer=""; let finished=false;
    const stop=(error,value)=>{if(finished)return;finished=true;clearTimeout(timeout);if(!child.killed)child.kill();if(error)reject(error);else resolve(value);};
    const send=(message)=>{
      if(finished||child.killed||!child.stdin.writable)return false;
      try{child.stdin.write(`${JSON.stringify(message)}\n`,(error)=>{if(error)stop(error);});return true;}
      catch(error){stop(error);return false;}
    };
    const timeout=setTimeout(()=>stop(new Error("Timed out while reading the Codex task.")),8000);
    child.stdout.setEncoding("utf8"); child.stdout.on("data",(chunk)=>{buffer+=chunk;const lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";for(const line of lines)try{const event=JSON.parse(line);if(event.id===1){send({method:"initialized",params:{}});send({id:2,method:"thread/read",params:{threadId,includeTurns:true}});}if(event.id===2){if(event.error)stop(new Error(event.error.message||"Could not read Codex task."));else stop(null,event.result?.thread||null);}}catch{}});
    child.stdin.on("error",(error)=>stop(error));
    child.on("error",stop); child.on("close",()=>{if(!finished)stop(new Error("Codex task reader stopped."));});
    send({id:1,method:"initialize",params:{clientInfo:{name:"serent-command-center-reconciler",title:"Serent Command Center",version:"1.0.0"},capabilities:{experimentalApi:true}}});
  });
}

async function reconcilePersistentTasks() {
  const tasks=db.prepare("SELECT * FROM codex_tasks WHERE status IN ('starting','working')").all();
  for(const task of tasks){
    if(!task.thread_id){
      if(Date.now()-Date.parse(task.created_at)>60000){const now=nowIso();db.prepare("UPDATE codex_tasks SET status='error',error='The separate task did not create a Codex thread.',updated_at=? WHERE id=?").run(now,task.id);db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(now,task.work_item_id);eventFor(task.work_item_id,"codex_task_error","The separate task did not create a Codex thread.");}
      continue;
    }
    try{
      const outcome=threadOutcome(await readCodexThread(task.thread_id));
      if(outcome.status==="completed"&&outcome.final){const now=nowIso();db.prepare("UPDATE codex_tasks SET status='complete',result=?,error='',updated_at=? WHERE id=?").run(outcome.final.slice(0,50000),now,task.id);db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(now,task.work_item_id);eventFor(task.work_item_id,"codex_task_returned",`Separate Codex task completed (${task.thread_id}).`);}
      else if(["failed","cancelled"].includes(outcome.status)||(outcome.status==="interrupted"&&!activeProcesses.has(task.id)&&Date.now()-Date.parse(task.updated_at)>30000)){const now=nowIso();const error=outcome.error||`Codex task ended as ${outcome.status}.`;db.prepare("UPDATE codex_tasks SET status='error',error=?,updated_at=? WHERE id=?").run(error,now,task.id);db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(now,task.work_item_id);eventFor(task.work_item_id,"codex_task_error",error);}
    }catch{/* Preserve the receipt and retry on the next reconciliation. */}
  }
}

function userOwnedCodexTaskPrompt(item, taskId, instruction) {
  return `Use the Serent Command Center workflow to complete this assignment in a normal, user-owned Codex task.

Assignment: ${instruction}
Company: ${item.company_name || "Unassigned"}
Originating Command Center item: ${item.title}
Work item ID: ${item.id}
Summary: ${item.summary}
Why now: ${item.why_now}
Expected next action: ${item.suggested_action}
Company context: ${item.ai_os_path ? path.resolve(aiOsRoot,item.ai_os_path) : "Read the relevant AI OS company and project context."}

First, POST {"status":"working"} to http://127.0.0.1:4318/api/codex-tasks/${taskId}/callback. Read the live card and its linked notes, mail, and sources from GET http://127.0.0.1:4318/api/work-items before doing the work. Work independently, keep shared-system writes review-gated, and save local artifacts in the relevant project output convention. When finished, POST {"status":"complete","result":"a concise handoff with the answer and artifact paths"} to the same callback URL. If blocked, POST {"status":"error","error":"what is blocking the task"}.`;
}

function prepareUserOwnedCodexTask(item, instruction) {
  const id=randomUUID(); const now=nowIso();
  const title=`${item.company_name || "Serent"} - ${item.title}`.slice(0,240);
  const prompt=userOwnedCodexTaskPrompt(item,id,instruction);
  const deepLink=new URL("codex://threads/new");
  deepLink.searchParams.set("path",aiOsRoot);
  deepLink.searchParams.set("prompt",prompt);
  deepLink.searchParams.set("originUrl",`http://localhost:3000/?workItem=${encodeURIComponent(item.id)}`);
  db.prepare(`INSERT INTO codex_tasks(id,work_item_id,title,instruction,status,created_at,updated_at) VALUES(?,?,?,?, 'waiting_on_user',?,?)`).run(id,item.id,title,instruction,now,now);
  db.prepare("UPDATE work_items SET decision_state=CASE WHEN decision_state='proposed' THEN 'accepted' ELSE decision_state END,updated_at=? WHERE id=?").run(now,item.id);
  eventFor(item.id,"codex_task_prepared",`Prepared a normal Codex sidebar task: ${title}`);
  return {id,threadId:"",status:"waiting_on_user",title,instruction,deepLink:deepLink.toString(),createdAt:now,updatedAt:now};
}

async function launchPersistentCodexTask(item, instruction) {
  const id=randomUUID(); const now=nowIso();
  const company=item.company_slug ? db.prepare("SELECT * FROM companies WHERE slug=?").get(item.company_slug) : null;
  const notes=contextualNotes({workItemId:item.id,companySlug:item.company_slug});
  const sources=db.prepare("SELECT provider,label,source_path,source_url FROM source_references WHERE work_item_id=?").all(item.id);
  const transcripts=await relevantTranscriptPaths(item.company_slug,`${item.title} ${instruction}`);
  const linkedMail=db.prepare("SELECT subject,preview,attachments_json,web_link FROM mail_messages WHERE action_work_item_id=? LIMIT 1").get(item.id);
  const title=`${item.company_name || "Serent"} - ${item.title}`.slice(0,240);
  const prompt=`Create a durable Codex task for this Serent assignment.\n\nAssignment: ${instruction}\nCompany: ${item.company_name || "Unassigned"}\nOriginating Command Center item: ${item.title}\nWork item ID: ${item.id}\nSummary: ${item.summary}\nWhy now: ${item.why_now}\nExpected next action: ${item.suggested_action}\nCompany context: ${company?.ai_os_path ? path.resolve(aiOsRoot,company.ai_os_path) : "AI OS company context"}\nCard working draft: ${item.draft||"None"}\n\nRelevant notes:\n${notes.map((n)=>`## ${n.title}\n${n.body}`).join("\n\n")||"None"}\n\nLinked mail:\n${linkedMail?`Subject: ${linkedMail.subject}\nPreview: ${linkedMail.preview}\nAttachments: ${linkedMail.attachments_json}\nOutlook: ${linkedMail.web_link}`:"None"}\n\nRelevant transcript summaries:\n${transcripts.map((value)=>`- ${value}`).join("\n")||"None found"}\n\nSource manifest:\n${sources.map((s)=>`- ${s.provider}: ${s.label} ${s.source_path||s.source_url||""}`).join("\n")||"None"}\n\nRead the listed project and transcript sources before drafting. If Jake asks to place the output in Command Center Documents, create it through POST http://127.0.0.1:4318/api/notes with JSON fields title, body, type, origin='agent', companySlug='${item.company_slug||""}', and workItemId='${item.id}'. Do not edit the database directly. Work independently on the deliverable. Keep shared-system writes review-gated. Save any additional local artifacts in the relevant project output convention, verify them, and finish with a concise handoff including the Command Center document title, artifact paths, and remaining decisions.`;
  db.prepare(`INSERT INTO codex_tasks(id,work_item_id,title,instruction,status,created_at,updated_at) VALUES(?,?,?,?, 'starting',?,?)`).run(id,item.id,title,instruction,now,now);
  db.prepare("UPDATE work_items SET status='working',decision_state=CASE WHEN decision_state='proposed' THEN 'accepted' ELSE decision_state END,updated_at=? WHERE id=?").run(now,item.id);
  eventFor(item.id,"codex_task_started",`Started a separate Codex task: ${title}`);
  const cli=await resolveCodexCli();
  const child=spawn(cli,["app-server","--stdio"],{cwd:aiOsRoot,env:process.env,windowsHide:true});
  activeProcesses.set(id,child);
  let buffer="";let finalMessage="";let stderr="";let threadId="";let finishedTask=false;let pollTimer=null;let taskTimeout=null;let pollId=20;let terminalPolls=0;
  const finish=(success,error="")=>{
    if(finishedTask)return; finishedTask=true; if(pollTimer)clearInterval(pollTimer);if(taskTimeout)clearTimeout(taskTimeout);activeProcesses.delete(id); const finished=nowIso();
    if(success){db.prepare("UPDATE codex_tasks SET thread_id=?,status='complete',result=?,updated_at=? WHERE id=?").run(threadId,finalMessage.slice(0,50000),finished,id);db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(finished,item.id);eventFor(item.id,"codex_task_returned",`Separate Codex task completed${threadId?` (${threadId})`:""}.`);}
    else{const detail=error||stderr.trim()||"The separate Codex task stopped without a result.";db.prepare("UPDATE codex_tasks SET thread_id=?,status='error',error=?,updated_at=? WHERE id=?").run(threadId,detail,finished,id);db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(finished,item.id);eventFor(item.id,"codex_task_error",detail.slice(0,1200));}
    setTimeout(()=>{if(!child.killed)child.kill();},150);
  };
  const send=(message)=>{
    if(finishedTask||child.killed||!child.stdin.writable)return false;
    try{child.stdin.write(`${JSON.stringify(message)}\n`,(error)=>{if(error&&!finishedTask)finish(false,error.message);});return true;}
    catch(error){finish(false,error.message);return false;}
  };
  child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
  child.stdout.on("data",(chunk)=>{buffer+=chunk;const lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";for(const line of lines)try{const event=JSON.parse(line);
    if(event.id===1){send({method:"initialized",params:{}});send({id:2,method:"thread/start",params:{cwd:aiOsRoot,approvalPolicy:"never",sandbox:"workspace-write",ephemeral:false,threadSource:"app",runtimeWorkspaceRoots:[aiOsRoot]}});}
    if(event.id===2&&event.result?.thread?.id){threadId=event.result.thread.id;db.prepare("UPDATE codex_tasks SET thread_id=?,status='working',updated_at=? WHERE id=?").run(threadId,nowIso(),id);send({id:4,method:"thread/name/set",params:{threadId,name:title}});send({id:3,method:"turn/start",params:{threadId,input:[{type:"text",text:prompt}]}});pollTimer=setInterval(()=>{if(!finishedTask)send({id:pollId++,method:"thread/read",params:{threadId,includeTurns:true}});},5000);}
    if(event.method==="item/completed"&&event.params?.item?.type==="agentMessage")finalMessage=event.params.item.text||"";
    if(event.method==="turn/completed"&&event.params?.turn?.status==="completed"&&finalMessage)finish(true);
    if(event.id>=20&&event.result?.thread){const outcome=threadOutcome(event.result.thread);if(outcome.status==="completed"&&outcome.final){finalMessage=outcome.final;finish(true);}else if(["failed","cancelled"].includes(outcome.status)){terminalPolls+=1;if(terminalPolls>=3)finish(false,outcome.error||`Codex task ended as ${outcome.status}.`);}else terminalPolls=0;}
    if(event.id===4&&event.error)eventFor(item.id,"codex_task_naming_warning",event.error.message||"The Codex task was created but could not be named in the sidebar.");
    if(event.id&&event.error&&event.id<20&&event.id!==4)finish(false,event.error.message||"Codex app-server request failed.");
  }catch{}});
  child.stderr.on("data",(chunk)=>{stderr=`${stderr}${chunk}`.slice(-8000);});
  child.stdin.on("error",(error)=>{if(!finishedTask)finish(false,error.message);});
  child.on("error",(error)=>finish(false,error.message));
  child.on("close",()=>{if(!finishedTask)finish(false);});
  taskTimeout=setTimeout(()=>finish(false,"The separate Codex task exceeded 15 minutes without returning a result."),15*60*1000);
  send({id:1,method:"initialize",params:{clientInfo:{name:"serent-command-center",title:"Serent Command Center",version:"1.0.0"},capabilities:{experimentalApi:true}}});
  return {id,threadId,status:"starting",title,instruction,createdAt:now,updatedAt:now};
}

async function launchAgentRun({ workItemId = null, mailMessageId = null, companySlug = null, scope, intent, title, allowedSources, revisionOf = null, sourceRefresh = null, skillId = "generic-codex", executorType = "codex_readonly", contextManifest = {} }) {
  const id = randomUUID();
  const now = nowIso();
  const safeIntent = String(intent || "").trim().slice(0, 4000);
  if (!safeIntent) throw new Error("Describe what Codex should do.");
  const inputHash = createHash("sha256").update(`${scope}:${safeIntent}:${workItemId || ""}`).digest("hex").slice(0, 12);
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
        db.prepare(`UPDATE source_receipts SET status='ready', checked_at=?, detail=?, result=?, error='' WHERE source=?`).run(finished, parsed?.summary || `Refresh complete; ${changed} consequential item${changed === 1 ? "" : "s"} updated.`, finalMessage, sourceRefresh);
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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    const origin = request.headers.origin || "";
    if (origin && origin !== allowedOrigin) return responseJson(response, 403, { error: "Request origin is not allowed." });
    if (request.method === "OPTIONS") return responseJson(response, 204, {});
    if (origin && request.method !== "GET" && request.headers["x-serent-command-center"] !== "1") return responseJson(response, 403, { error: "Command Center request marker is required." });
    if (request.method === "GET" && url.pathname === "/api/health") return responseJson(response, 200, { status: "ready", checkedAt: nowIso(), activeJobs: activeProcesses.size, database: databasePath });
    if (request.method === "GET" && url.pathname === "/api/bootstrap") return responseJson(response, 200, bootstrapPayload(Object.fromEntries(url.searchParams)));
    if (request.method === "GET" && url.pathname === "/api/work-items") return responseJson(response, 200, queryWorkItems(Object.fromEntries(url.searchParams)));
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
      db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,priority,confidence,status,suggested_action,due_at,source_provider,source_key,decision_state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,'to_review',?,?, 'manual',?,'committed',?,?)`).run(id,type,companySlug,title,summary,whyNow,priority,suggestedAction,dueAt,sourceKey,now,now);
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
      if (body.promote && !current.action_work_item_id) ensureMailAction(id, { highImpact: true });
      const actionId = current.action_work_item_id || (body.promote ? db.prepare("SELECT action_work_item_id FROM mail_messages WHERE id=?").get(id)?.action_work_item_id : null);
      if (actionId && snoozedUntil && Date.parse(snoozedUntil) > Date.now()) db.prepare("UPDATE work_items SET status='waiting_external',updated_at=? WHERE id=? AND status NOT IN ('done','dismissed')").run(nowIso(),actionId);
      if (actionId && (!snoozedUntil || Date.parse(snoozedUntil) <= Date.now())) db.prepare("UPDATE work_items SET status='to_review',updated_at=? WHERE id=? AND status='waiting_external'").run(nowIso(),actionId);
      const action = body.promote ? "promoted" : snoozedUntil !== current.snoozed_until ? "snoozed" : company !== current.company_slug ? "company_corrected" : replyState !== current.reply_state ? "reply_state_corrected" : "reviewed";
      recordFeedback({ eventType: action, mailMessageId: id, companySlug: company, detail: String(body.detail || action), beforeValue: JSON.stringify({ companySlug: current.company_slug, reviewState: current.review_state, replyState: current.reply_state, snoozedUntil: current.snoozed_until }), afterValue: JSON.stringify({ companySlug: company, reviewState, replyState, snoozedUntil }) });
      return responseJson(response, 200, mapMail(db.prepare(`${mailSelect} WHERE m.id=?`).get(id), true));
    }

    if (request.method === "GET" && url.pathname === "/api/delegation-preview") return responseJson(response, 200, delegationPreview({ workItemId: url.searchParams.get("workItemId"), mailMessageId: url.searchParams.get("mailMessageId"), skillId: url.searchParams.get("skillId") || "" }));

    const clickUpCompleteMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/complete-clickup$/);
    if (request.method === "POST" && clickUpCompleteMatch) {
      const item = db.prepare(`SELECT w.*,c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(decodeURIComponent(clickUpCompleteMatch[1]));
      if (!item) throw new Error("Unknown work item.");
      return responseJson(response, 202, await launchClickUpCompletion(item));
    }
    const codexTaskMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/codex-task$/);
    if (request.method === "POST" && codexTaskMatch) {
      const item = db.prepare(`SELECT w.*,c.display_name AS company_name FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(decodeURIComponent(codexTaskMatch[1]));
      if (!item) throw new Error("Unknown work item.");
      const body = await readJsonBody(request);
      const instruction = String(body.instruction || item.suggested_action || "Complete this assignment.").trim().slice(0,4000);
      if (!instruction) throw new Error("Describe the assignment for the new Codex task.");
      return responseJson(response, 202, await launchPersistentCodexTask(item,instruction));
    }
    const codexTaskLinkMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/codex-task-link$/);
    if (request.method === "POST" && codexTaskLinkMatch) {
      const item = db.prepare(`SELECT w.*,c.display_name AS company_name,c.ai_os_path FROM work_items w LEFT JOIN companies c ON c.slug=w.company_slug WHERE w.id=?`).get(decodeURIComponent(codexTaskLinkMatch[1]));
      if (!item) throw new Error("Unknown work item.");
      const body = await readJsonBody(request);
      const instruction = String(body.instruction || item.suggested_action || "Complete this assignment.").trim().slice(0,4000);
      if (!instruction) throw new Error("Describe the assignment for the new Codex task.");
      return responseJson(response, 201, prepareUserOwnedCodexTask(item,instruction));
    }
    const codexTaskCallbackMatch = url.pathname.match(/^\/api\/codex-tasks\/([^/]+)\/callback$/);
    if (request.method === "POST" && codexTaskCallbackMatch) {
      const task = db.prepare("SELECT * FROM codex_tasks WHERE id=?").get(decodeURIComponent(codexTaskCallbackMatch[1]));
      if (!task) throw new Error("Unknown Codex task receipt.");
      const body = await readJsonBody(request); const status=String(body.status||""); const now=nowIso();
      if (!['working','complete','error'].includes(status)) throw new Error("Codex task callback status must be working, complete, or error.");
      if(status==='working'){
        db.prepare("UPDATE codex_tasks SET status='working',updated_at=? WHERE id=?").run(now,task.id);
        db.prepare("UPDATE work_items SET status='working',updated_at=? WHERE id=?").run(now,task.work_item_id);
        eventFor(task.work_item_id,"codex_task_started",`Started the user-owned Codex task: ${task.title}`);
      }else if(status==='complete'){
        const result=String(body.result||"The separate Codex task completed.").slice(0,50000);
        db.prepare("UPDATE codex_tasks SET status='complete',result=?,error='',updated_at=? WHERE id=?").run(result,now,task.id);
        db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(now,task.work_item_id);
        eventFor(task.work_item_id,"codex_task_returned","User-owned Codex task completed and returned for review.");
      }else{
        const error=String(body.error||"The separate Codex task needs attention.").slice(0,8000);
        db.prepare("UPDATE codex_tasks SET status='error',error=?,updated_at=? WHERE id=?").run(error,now,task.id);
        db.prepare("UPDATE work_items SET status='back_for_review',updated_at=? WHERE id=?").run(now,task.work_item_id);
        eventFor(task.work_item_id,"codex_task_error",error);
      }
      return responseJson(response, 200, {id:task.id,status,updatedAt:now});
    }

    const workItemMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)$/);
    if (request.method === "PATCH" && workItemMatch) {
      const id = decodeURIComponent(workItemMatch[1]);
      const current = db.prepare("SELECT * FROM work_items WHERE id = ?").get(id);
      if (!current) throw new Error("Unknown work item.");
      const body = await readJsonBody(request);
      const allowedStatus = ["to_review", "queued", "working", "waiting_on_user", "waiting_external", "back_for_review", "done", "dismissed", "error"];
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
      };
      const resolvedAt = ["done", "dismissed"].includes(next.status) ? nowIso() : null;
      db.prepare(`UPDATE work_items SET status=?,priority=?,draft=?,title=?,summary=?,suggested_action=?,resolution=?,decision_state=?,due_at=?,planned_at=?,planned_minutes=?,updated_at=?,resolved_at=? WHERE id=?`).run(next.status, next.priority, next.draft, next.title, next.summary, next.suggestedAction, next.resolution, next.decisionState, next.dueAt, next.plannedAt, next.plannedMinutes, nowIso(), resolvedAt, id);
      const eventType = next.status !== current.status ? next.status : "edited";
      eventFor(id, eventType, body.eventDetail || (eventType === "edited" ? "Workbench content updated." : `Moved to ${eventType}.`));
      if (next.status !== current.status || next.priority !== current.priority || next.draft !== current.draft) {
        recordFeedback({ eventType, workItemId: id, companySlug: current.company_slug, detail: body.eventDetail || "Workbench action", beforeValue: JSON.stringify({ status: current.status, priority: current.priority, draft: current.draft }), afterValue: JSON.stringify({ status: next.status, priority: next.priority, draft: next.draft }) });
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
    return responseJson(response, 400, { error: error instanceof Error ? error.message : "Request failed." });
  }
});

server.listen(port, host, () => {
  console.log(`Serent Command Center control server listening at http://${host}:${port}`);
  void reconcilePersistentTasks();
  const reconciliationTimer=setInterval(()=>void reconcilePersistentTasks(),15000);
  reconciliationTimer.unref();
});
