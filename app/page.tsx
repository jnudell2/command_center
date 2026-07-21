"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MailWorkspace from "./mail-workspace";
import CalendarWorkspace from "./calendar-workspace";
import MarkdownEditor from "./markdown-editor";
import PmAgentWorkspace from "./pm-agent-workspace";
import ProjectWorkspace from "./project-workspace";
import { dueDateEndOfLocalDayIso, dueDateInputValue } from "./due-date";
import { workViewFor, workViews, type WorkView } from "./work-view";

type WorkStatus =
  | "to_review"
  | "queued"
  | "working"
  | "waiting_on_user"
  | "waiting_external"
  | "back_for_review"
  | "done"
  | "dismissed"
  | "error";
type DueBucket = "overdue" | "today" | "tomorrow" | "this_week" | "later" | "no_date";

type Company = {
  slug: string;
  displayName: string;
  description: string;
  aiOsPath: string;
  boxFolder: string;
};

type SourceRef = {
  id: string;
  provider: string;
  label: string;
  sourceId: string;
  sourcePath: string;
  sourceUrl: string;
  retrievedAt: string;
  freshness: string;
};

type WorkEvent = {
  id: string;
  type: string;
  detail: string;
  createdAt: string;
};

type Note = {
  id: string;
  title: string;
  body: string;
  type: "daily" | "scratch" | "meeting" | "project" | "decision";
  origin: "manual" | "agent";
  state: string;
  companySlug: string | null;
  workItemIds: string[];
  filePath: string;
  latestProposal: null | {
    id: string;
    instruction: string;
    proposedTitle: string;
    proposedBody: string;
    summary: string;
    status: "working" | "ready" | "accepted" | "rejected" | "error";
    error: string;
    createdAt: string;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

type AgentRun = {
  id: string;
  workItemId: string | null;
  companySlug: string | null;
  scope: string;
  intent: string;
  title: string;
  allowedSources: string[];
  status: "queued" | "working" | "waiting_on_user" | "review" | "error";
  result: string;
  error: string;
  revisionOf: string | null;
  skillId: string;
  executorType: string;
  contextManifest: Record<string, unknown>;
  mailMessageId: string | null;
  waitingReason: string;
  createdAt: string;
  updatedAt: string;
};

type CodexTaskReceipt = {
  id: string;
  threadId: string;
  title: string;
  instruction: string;
  status: string;
  result: string;
  error: string;
  createdAt: string;
  updatedAt: string;
};

type WorkItem = {
  id: string;
  type: string;
  companySlug: string | null;
  companyName: string;
  title: string;
  summary: string;
  whyNow: string;
  priority: "urgent" | "high" | "normal" | "low";
  confidence: number;
  status: WorkStatus;
  suggestedAction: string;
  draft: string;
  owner: string;
  dueAt: string | null;
  plannedAt: string | null;
  plannedMinutes: number;
  preparationMode: "manual" | "auto" | "none";
  preparationSkill: string;
  preparationInstruction: string;
  resolution: string;
  decisionState: "proposed" | "accepted" | "committed";
  createdAt: string;
  updatedAt: string;
  sources: SourceRef[];
  events: WorkEvent[];
  notes: Note[];
  agentRuns: AgentRun[];
  externalActions: Array<{ id: string; provider: string; actionType: string; targetId: string; status: string; receipt: string; error: string; createdAt: string; updatedAt: string }>;
  codexTasks: CodexTaskReceipt[];
  projectContext: null | {
    projectId: string;
    projectTitle: string;
    planItemId: string;
    planItemTitle: string;
    workstream: string;
    phaseTitle: string;
    dueDate: string | null;
  };
  activeRules: PreferenceRule[];
};

type PreferenceRule = {
  id: string;
  title: string;
  rationale: string;
  instruction: string;
  scopeType: string;
  scopeValue: string;
  category: string;
  status: "proposed" | "accepted" | "rejected" | "retired";
  evidence: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
};

type CardCommandResponse = {
  handled: boolean;
  updated: WorkItem;
  changes: Array<{ field: string; label: string; before: unknown; after: unknown }>;
  remainingIntent: string;
  clarification: string;
  message: string;
  undoToken: string;
};

type SourceReceipt = {
  source: string;
  status: string;
  checkedAt: string;
  detail: string;
  result: string;
  error: string;
};

type Bootstrap = {
  generatedAt: string;
  companies: Company[];
  items: WorkItem[];
  counts: Record<string, number>;
  companyCounts: Record<string, number>;
  mailCounts: Record<string, number>;
  sources: SourceReceipt[];
  dailyNote: Note;
  runner: { status: string; activeJobs: number };
};

type MeetingWorkflow = {
  id: string;
  workItemId: string;
  state: "waiting_for_transcript" | "candidate_review" | "processing" | "review" | "complete" | "error";
  candidatePath: string;
  transcriptPath: string;
  noteId: string | null;
  noteTitle: string;
  noteFilePath: string;
  agentRunId: string | null;
  error: string;
  event: { subject: string; startAt: string; endAt: string; attendees: Array<{ name?: string; email?: string }> };
  candidates: Array<{ path: string; name: string; modifiedAt: string; size: number; score: number; reasons: string[] }>;
  suggestions: Array<{
    id: string; title: string; summary: string; companySlug: string | null; type: string;
    priority: "urgent" | "high" | "normal" | "low"; ownerState: "jake" | "external";
    suggestedAction: string; evidenceTimestamp: string; dueAt: string | null;
    existingWorkItemId: string | null; decision: "proposed" | "accepted" | "rejected";
    createdWorkItemId: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
};

type SearchResult = {
  kind: "work_item" | "note" | "agent_run" | "mail";
  id: string;
  title: string;
  excerpt: string;
  workItemId?: string;
  companySlug?: string;
  companyName?: string;
};

const runnerUrl = "http://127.0.0.1:4318";

const statusMeta: Record<WorkStatus, { label: string; short: string }> = {
  to_review: { label: "To review", short: "Review" },
  queued: { label: "Queued for Codex", short: "Queued" },
  working: { label: "Working", short: "Working" },
  waiting_on_user: { label: "Waiting on Jake", short: "Waiting" },
  waiting_external: { label: "Waiting", short: "Waiting" },
  back_for_review: { label: "Back for review", short: "Returned" },
  done: { label: "Done", short: "Done" },
  dismissed: { label: "Dismissed", short: "Dismissed" },
  error: { label: "Needs attention", short: "Error" },
};

const navItems = [
  ["inbox", "My work"],
  ["projects", "Projects"],
  ["pm", "PM agent"],
  ["calendar", "Calendar"],
  ["mail", "Mail"],
  ["notes", "Documents"],
  ["companies", "Companies"],
  ["agents", "Codex work"],
  ["search", "Search"],
] as const;
const focusNavItems = navItems.filter(([id]) => ["inbox", "mail", "calendar"].includes(id));
const workspaceNavItems = navItems.filter(([id]) => ["projects", "notes", "companies"].includes(id));
const intelligenceNavItems = navItems.filter(([id]) => ["pm", "agents", "search"].includes(id));

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${runnerUrl}${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      "X-Serent-Command-Center": "1",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(options?.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "The local runner could not complete the request.");
  return payload as T;
}

function openDeepLink(href: string) {
  const link = document.createElement("a");
  link.href = href;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function relativeTime(value: string | null) {
  if (!value) return "No due date";
  const date = new Date(value);
  const minutes = Math.round((date.getTime() - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return minutes <= 0 ? "Due now" : `In ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return hours <= 0 ? `${Math.abs(hours)}h ago` : `In ${hours}h`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function bodyForEditor(title: string, body: string) {
  const leadingTitle = body.match(/^#\s+([^\r\n]+)\r?\n+/);
  return leadingTitle?.[1]?.trim() === title.trim() ? body.slice(leadingTitle[0].length) : body;
}

function fullDate(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ItemBadge({ status }: { status: WorkStatus }) {
  return <span className={`status-badge status-${status}`}>{statusMeta[status].short}</span>;
}

function actionKind(item: WorkItem) {
  if (item.decisionState === "committed" || item.sources.some((source) => source.provider === "clickup")) return { id: "committed", label: "Committed" };
  if (item.decisionState === "accepted") return { id: "accepted", label: "Accepted" };
  if (["outlook", "calendar", "transcripts"].some((provider) => item.sources.some((source) => source.provider === provider))) return { id: "owed", label: "Likely owed" };
  return { id: "suggested", label: "Suggested" };
}

const dueBuckets: Array<{ id: DueBucket; label: string }> = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "this_week", label: "This week" },
  { id: "later", label: "Later" },
  { id: "no_date", label: "No due date" },
];

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function dueBucketFor(item: WorkItem, anchor: Date): DueBucket {
  if (!item.dueAt) return "no_date";
  const due = startOfDay(new Date(item.dueAt));
  const today = startOfDay(anchor);
  const difference = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (difference < 0) return "overdue";
  if (difference === 0) return "today";
  if (difference === 1) return "tomorrow";
  const daysUntilSunday = (7 - today.getDay()) % 7;
  if (difference <= daysUntilSunday) return "this_week";
  return "later";
}

function dueLabel(item: WorkItem, anchor: Date) {
  const bucket = dueBucketFor(item, anchor);
  if (bucket === "no_date") return "No due date";
  const date = new Date(item.dueAt!);
  const calendarDate = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (bucket === "overdue") return `Overdue · ${calendarDate}`;
  if (bucket === "today") return `Today · ${calendarDate}`;
  if (bucket === "tomorrow") return `Tomorrow · ${calendarDate}`;
  return calendarDate;
}

function cardState(item: WorkItem) {
  if (item.status === "queued") return { owner: "Codex", label: "Starting" };
  if (item.status === "working") return { owner: "Codex", label: "Working" };
  if (item.status === "back_for_review") return { owner: "You", label: "Ready to review" };
  if (item.status === "error") return { owner: "You", label: "Needs attention" };
  if (item.status === "waiting_on_user") return { owner: "You", label: "Needs input" };
  if (item.status === "waiting_external") return { owner: "Someone else", label: "Waiting" };
  if (item.status === "done") return { owner: "—", label: "Done" };
  if (item.status === "dismissed") return { owner: "—", label: "Not needed" };
  if (item.decisionState === "proposed") return { owner: "You", label: "Needs decision" };
  return { owner: "You", label: "Ready" };
}

function requestedOutcome(run: AgentRun) {
  const marker = "Jake's request:";
  const value = run.intent.includes(marker) ? run.intent.split(marker).at(-1) : run.intent;
  return String(value || run.title).trim();
}

function codexTaskPresentation(task: CodexTaskReceipt) {
  if (task.status === "waiting_on_user" && !task.threadId) return { label: "Ready to open", detail: "No Codex task is running yet. Open this handoff when you are ready to start the work." };
  if (task.status === "accepted") return { label: "Accepted", detail: "A verified native Codex task accepted this assignment and is waiting to report that work started." };
  if (["starting", "working"].includes(task.status)) return { label: "Working", detail: "The native Codex task reports that it is actively working on this assignment." };
  if (task.status === "needs_input") return { label: "Needs input", detail: task.result || "The native Codex task needs input before it can continue." };
  if (task.status === "needs_attention") return { label: "Needs attention", detail: task.result || "The linked Codex task has not reported recent progress." };
  if (task.status === "complete") return { label: "Completed", detail: task.result || "The native Codex task completed this assignment." };
  if (task.status === "error") return { label: "Failed", detail: task.error || "The native Codex task reported a failure." };
  if (task.status === "ownership_released") return { label: "Released", detail: task.result || "The native Codex task released this assignment." };
  return { label: task.status.replaceAll("_", " "), detail: task.result || task.error || "No activity has been reported." };
}

function sourceName(source: string) {
  return ({ ai_os: "AI OS", project_files: "project files", project_plan: "approved project plan", manual: "this card", outlook: "Outlook", calendar: "calendar", transcripts: "transcripts", box: "Box", clickup: "ClickUp" } as Record<string, string>)[source] || source.replaceAll("_", " ");
}

function workingSurface(item: WorkItem) {
  const text = `${item.type} ${item.title}`.toLowerCase();
  if (/email|reply|follow.?up/.test(text)) return { label: "Draft reply", placeholder: "Write or refine the reply you may send..." };
  if (/meeting_prep|one-on-one|1:1|agenda/.test(text)) return { label: "Meeting agenda", placeholder: "Capture talking points, decisions needed, and questions..." };
  if (/deck|presentation|powerpoint|artifact/.test(text)) return { label: "Deck outline", placeholder: "Capture the story, required slides, evidence, and open questions..." };
  if (/schedul|calendar|kickoff meeting/.test(text)) return { label: "Scheduling note", placeholder: "Capture attendees, timing constraints, and the outreach you want to make..." };
  return { label: "Working notes", placeholder: "Capture optional notes, a checklist, or partial thinking for this action..." };
}

export default function Home() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<(typeof navItems)[number][0] | "settings">("inbox");
  const [selectedId, setSelectedId] = useState<string>("");
  const [companyFilter, setCompanyFilter] = useState(() =>
    typeof window === "undefined"
      ? "all"
      : window.localStorage.getItem("serent-tend-company") || "all",
  );
  const [statusFilter, setStatusFilter] = useState<WorkView>("open");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [mobileWorkbenchOpen, setMobileWorkbenchOpen] = useState(false);
  const [quickCapture, setQuickCapture] = useState("");
  const [composer, setComposer] = useState("");
  const [codexDestination, setCodexDestination] = useState<"card" | "task">("card");
  const [draft, setDraft] = useState("");
  const [draftItemId, setDraftItemId] = useState("");
  const [notice, setNotice] = useState("");
  const [undoCommandId, setUndoCommandId] = useState("");
  const [busy, setBusy] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNoteId, setActiveNoteId] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteEditId, setNoteEditId] = useState("");
  const [noteDirty, setNoteDirty] = useState(false);
  const [noteCodexInstruction, setNoteCodexInstruction] = useState("");
  const [noteQuery, setNoteQuery] = useState("");
  const [noteRailOpen, setNoteRailOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [policies, setPolicies] = useState<PreferenceRule[]>([]);
  const [mailTargetId, setMailTargetId] = useState("");
  const [meetingWorkflow, setMeetingWorkflow] = useState<MeetingWorkflow | null>(null);
  const [meetingEdit, setMeetingEdit] = useState<{ id: string; title: string; suggestedAction: string } | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const noteSaveVersion = useRef(0);

  const load = async (quiet = false) => {
    try {
      const next = await api<Bootstrap>("/api/bootstrap");
      setData(next);
      setSelectedId((current) =>
        current && next.items.some((item) => item.id === current)
          ? current
          : next.items[0]?.id || "",
      );
      if (!quiet) {
        const nextNotes = await api<Note[]>("/api/notes");
        setNotes(nextNotes);
        if (!activeNoteId) {
          setNoteTitle(next.dailyNote.title);
          setNoteDraft(bodyForEditor(next.dailyNote.title, next.dailyNote.body));
          setNoteEditId(next.dailyNote.id);
          setActiveNoteId(next.dailyNote.id);
        }
      }
    } catch (error) {
      if (!quiet) setNotice(error instanceof Error ? error.message : "The local runner is offline.");
    }
  };

  useEffect(() => {
    let cancelled = false;
    const initialLoad = async () => {
      try {
        const [next, nextNotes] = await Promise.all([
          api<Bootstrap>("/api/bootstrap"),
          api<Note[]>("/api/notes"),
        ]);
        if (cancelled) return;
        setData(next);
        setSelectedId(next.items[0]?.id || "");
        setNotes(nextNotes);
        setActiveNoteId(next.dailyNote.id);
        setNoteTitle(next.dailyNote.title);
        setNoteDraft(bodyForEditor(next.dailyNote.title, next.dailyNote.body));
        setNoteEditId(next.dailyNote.id);
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : "The local runner is offline.");
      }
    };
    void initialLoad();
    const timer = window.setInterval(async () => {
      try {
        const [next, nextNotes] = await Promise.all([api<Bootstrap>("/api/bootstrap"), api<Note[]>("/api/notes")]);
        if (!cancelled) { setData(next); setNotes(nextNotes); }
      } catch {
        // Keep the last cached view visible while the runner reconnects.
      }
    }, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("serent-tend-company", companyFilter);
  }, [companyFilter]);

  useEffect(() => {
    const refreshCalendar = () => void api("/api/calendar/refresh", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
    const initial = window.setTimeout(refreshCalendar, 1500);
    const timer = window.setInterval(refreshCalendar, 5 * 60 * 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, []);

  const activeNote = notes.find((note) => note.id === activeNoteId) || data?.dailyNote || null;
  const filteredNotes = useMemo(() => {
    const query = noteQuery.trim().toLowerCase();
    if (!query) return notes;
    return notes.filter((note) => `${note.title} ${note.body} ${note.type}`.toLowerCase().includes(query));
  }, [noteQuery, notes]);
  const noteGroups = useMemo(() => [
    { id: "daily", label: "Daily", notes: filteredNotes.filter((note) => note.type === "daily") },
    { id: "meetings", label: "Meetings", notes: filteredNotes.filter((note) => note.type === "meeting") },
    { id: "projects", label: "Projects & decisions", notes: filteredNotes.filter((note) => ["project", "decision"].includes(note.type)) },
    { id: "notes", label: "Notes", notes: filteredNotes.filter((note) => note.type === "scratch") },
  ].filter((group) => group.notes.length), [filteredNotes]);

  const saveNoteSnapshot = useCallback(async (id: string, title: string, body: string, version: number) => {
    const saved = await api<Note>(`/api/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title, body }),
    });
    setNotes((current) => current.map((note) => (note.id === saved.id ? saved : note)));
    if (version === noteSaveVersion.current) setNoteDirty(false);
    return saved;
  }, []);

  useEffect(() => {
    if (!noteDirty || !activeNoteId) return;
    const version = ++noteSaveVersion.current;
    const id = activeNoteId;
    const title = noteTitle;
    const body = noteDraft;
    const timer = window.setTimeout(async () => {
      try {
        await saveNoteSnapshot(id, title, body, version);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The note could not be saved.");
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [noteDirty, noteTitle, noteDraft, activeNoteId, saveNoteSnapshot]);

  const selectNote = async (note: Note) => {
    if (noteDirty && activeNoteId) {
      const version = ++noteSaveVersion.current;
      try { await saveNoteSnapshot(activeNoteId, noteTitle, noteDraft, version); }
      catch (error) { setNotice(error instanceof Error ? error.message : "The current note could not be saved."); return; }
    }
    setActiveNoteId(note.id);
    setNoteTitle(note.title);
    setNoteDraft(bodyForEditor(note.title, note.body));
    setNoteEditId(note.id);
    setNoteDirty(false);
  };

  const items = useMemo(() => data?.items || [], [data?.items]);
  const filteredItems = items.filter((item) => {
    if (companyFilter !== "all" && item.companySlug !== companyFilter) return false;
    if (workViewFor(item) !== statusFilter) return false;
    if (sourceFilter !== "all" && !item.sources.some((source) => source.provider === sourceFilter)) return false;
    if (typeFilter !== "all" && item.type !== typeFilter) return false;
    if (priorityFilter !== "all" && item.priority !== priorityFilter) return false;
    return true;
  });
  const effectiveSelectedId = items.some((item) => item.id === selectedId) ? selectedId : filteredItems[0]?.id || "";
  const selected = items.find((item) => item.id === effectiveSelectedId) || null;
  const selectedWorkingSurface = selected ? workingSurface(selected) : null;
  const selectedActiveRun = selected?.agentRuns.find((run) => ["queued", "working", "waiting_on_user"].includes(run.status)) || null;
  const selectedLatestResult = selected?.agentRuns.filter((run) => ["review", "error"].includes(run.status)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
  const selectedPreparedTask = selected?.codexTasks.find((task) => task.status === "waiting_on_user" && !task.threadId) || null;
  const selectedActiveTask = selected?.codexTasks.find((task) => Boolean(task.threadId) && ["accepted", "starting", "working"].includes(task.status)) || null;
  const selectedMeetingId = selected?.type === "meeting_follow_up" ? selected.id : "";
  const activeMeetingWorkflow = meetingWorkflow?.workItemId === selectedMeetingId ? meetingWorkflow : null;
  const visibleDraft = selected && draftItemId === selected.id ? draft : selected?.draft || "";
  const allRuns = items.flatMap((item) => item.agentRuns).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  useEffect(() => {
    if (!selectedMeetingId) return;
    let cancelled = false;
    const readWorkflow = async () => {
      try {
        const next = await api<MeetingWorkflow>(`/api/meeting-workflows/${encodeURIComponent(selectedMeetingId)}`);
        if (!cancelled) setMeetingWorkflow(next);
      } catch {
        if (!cancelled) setMeetingWorkflow(null);
      }
    };
    void readWorkflow();
    const timer = window.setInterval(() => void readWorkflow(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedMeetingId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((current) => !current);
        return;
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setMobileWorkbenchOpen(false);
      }
      if (event.key === "/" && !typing) {
        event.preventDefault();
        setView("search");
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (["c", "n"].includes(event.key.toLowerCase()) && !typing) {
        event.preventDefault();
        quickRef.current?.focus();
      }
      if ((event.key === "j" || event.key === "k") && !typing && view === "inbox") {
        event.preventDefault();
        const ids = filteredItems.map((item) => item.id);
        const index = Math.max(0, ids.indexOf(effectiveSelectedId));
        const nextIndex = event.key === "j" ? Math.min(ids.length - 1, index + 1) : Math.max(0, index - 1);
        if (ids[nextIndex]) setSelectedId(ids[nextIndex]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filteredItems, effectiveSelectedId, view]);

  const capture = async () => {
    if (!quickCapture.trim()) return;
    setBusy(true);
    try {
      const note = await api<Note>("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          title: quickCapture.trim().slice(0, 70),
          body: quickCapture.trim(),
          type: "scratch",
          companySlug: companyFilter === "all" ? null : companyFilter,
          workItemId: selected?.id || null,
        }),
      });
      setNotes((current) => [note, ...current]);
      setQuickCapture("");
      setNotice("Captured locally. Nothing was published.");
      await load(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not capture the note.");
    } finally {
      setBusy(false);
    }
  };

  const patchItem = async (body: Record<string, unknown>) => {
    if (!selected) return;
    setBusy(true);
    try {
      const updated = await api<WorkItem>(`/api/work-items/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setData((current) =>
        current ? { ...current, items: current.items.map((item) => (item.id === updated.id ? updated : item)) } : current,
      );
      setNotice("Saved locally.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The item could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  const completeInClickUp = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/work-items/${encodeURIComponent(selected.id)}/complete-clickup`, { method: "POST", body: JSON.stringify({}) });
      setNotice("ClickUp completion started. Command Center will keep the receipt on this card.");
      await load(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "ClickUp could not be updated.");
    } finally { setBusy(false); }
  };

  const processMeetingTranscript = async (candidatePath = "") => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await api<MeetingWorkflow>(`/api/meeting-workflows/${encodeURIComponent(selected.id)}/process`, { method: "POST", body: JSON.stringify({ candidatePath }) });
      setMeetingWorkflow(next);
      if (next.state === "waiting_for_transcript") setNotice("No matching transcript is in Downloads yet. Download it, then try again.");
      else if (next.state === "candidate_review") setNotice("I found more than one possible transcript. Choose the right one.");
      else setNotice("Processing the transcript. The note and proposed follow-ups will return to this card.");
      await load(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The transcript could not be processed.");
    } finally { setBusy(false); }
  };

  const decideMeetingSuggestion = async (suggestionId: string, decision: "accept" | "reject") => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await api<MeetingWorkflow>(`/api/meeting-workflows/${encodeURIComponent(selected.id)}/suggestions/${encodeURIComponent(suggestionId)}`, { method: "PATCH", body: JSON.stringify({ decision }) });
      setMeetingWorkflow(next);
      setNotice(decision === "accept" ? "Added to Command Center without writing to any external system." : "Ignored. It will not become a card.");
      await load(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : "The follow-up could not be updated."); }
    finally { setBusy(false); }
  };

  const saveMeetingSuggestionEdit = async () => {
    if (!selected || !meetingEdit?.title.trim()) return;
    setBusy(true);
    try {
      const next = await api<MeetingWorkflow>(`/api/meeting-workflows/${encodeURIComponent(selected.id)}/suggestions/${encodeURIComponent(meetingEdit.id)}`, { method: "PATCH", body: JSON.stringify({ decision: "edit", title: meetingEdit.title.trim(), suggestedAction: meetingEdit.suggestedAction.trim() }) });
      setMeetingWorkflow(next);
      setMeetingEdit(null);
      setNotice("Updated the proposed follow-up. It still needs your approval before becoming a card.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "The follow-up could not be edited."); }
    finally { setBusy(false); }
  };

  const finishMeetingReview = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await api<MeetingWorkflow>(`/api/meeting-workflows/${encodeURIComponent(selected.id)}/complete`, { method: "POST", body: JSON.stringify({}) });
      setMeetingWorkflow(next);
      setNotice("Meeting processed. The note is saved and accepted follow-ups are now in your work stream.");
      await load(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : "The meeting review could not be finished."); }
    finally { setBusy(false); }
  };

  const closeMeetingWithoutTranscript = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await api<MeetingWorkflow>(`/api/meeting-workflows/${encodeURIComponent(selected.id)}/no-transcript`, { method: "POST", body: JSON.stringify({}) });
      setMeetingWorkflow(next);
      setNotice("Closed. No transcript was recorded, so no transcript follow-through is required.");
      await load(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : "The meeting reminder could not be closed."); }
    finally { setBusy(false); }
  };

  const openCodexTask = async (instructionOverride = "") => {
    if (!selected) return;
    setBusy(true);
    try {
      const instruction = instructionOverride.trim() || composer.trim() || selected.suggestedAction;
      const task = await api<{ reused: boolean; deepLink?: string; threadId?: string; status: string }>(`/api/work-items/${encodeURIComponent(selected.id)}/codex-task`, { method: "POST", body: JSON.stringify({ instruction }) });
      setComposer("");
      if (task.deepLink) openDeepLink(task.deepLink);
      else if (task.threadId) await reopenCodexTask(task.threadId);
      setNotice(task.reused ? `Reopened the existing "${selected.companyName} - ${selected.title}" native Codex handoff.` : `Handed "${selected.companyName} - ${selected.title}" to a native Codex task. Progress returns through its receipt.`);
      await load(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The separate Codex task could not be created.");
    } finally { setBusy(false); }
  };

  const reopenCodexTask = async (threadId: string) => {
    try {
      await api(`/api/pm-agent/threads/${encodeURIComponent(threadId)}/open`, { method: "POST", body: JSON.stringify({}) });
      setNotice("Opened the linked Codex task. Continue refining there; its next callback will return the result to this card.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The linked Codex task could not be opened.");
    }
  };

  const acceptAction = async () => {
    await patchItem({ decisionState: "accepted", eventDetail: "Jake accepted this recommended action." });
    setNotice("Kept in your action stream. Command Center will continue tracking it.");
  };

  const submitCodexChoice = async () => {
    if (codexDestination === "task") return openCodexTask();
    if (!selected) return;
    const instruction = composer.trim() || selected.suggestedAction;
    if (!instruction) return;
    setBusy(true);
    try {
      const command = await api<CardCommandResponse>(`/api/work-items/${encodeURIComponent(selected.id)}/command`, { method: "POST", body: JSON.stringify({ instruction }) });
      if (command.handled) {
        setData((current) => current ? { ...current, items: current.items.map((item) => item.id === command.updated.id ? command.updated : item) } : current);
        setUndoCommandId(command.undoToken || "");
        setComposer("");
        if (command.clarification) {
          setNotice(command.clarification);
          return;
        }
        if (command.remainingIntent) {
          await openCodexTask(command.remainingIntent);
          setNotice(`${command.message} The remaining work was handed to a native Codex task.`);
        } else {
          setNotice(command.message);
        }
      } else {
        await openCodexTask(instruction);
        setNotice("This needs real Codex work, so Command Center handed it to a native task linked to this card.");
      }
      await load(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The instruction could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const undoCardCommand = async () => {
    if (!undoCommandId) return;
    setBusy(true);
    try {
      const result = await api<{ updated: WorkItem; message: string }>(`/api/card-commands/${encodeURIComponent(undoCommandId)}/undo`, { method: "POST", body: JSON.stringify({}) });
      setData((current) => current ? { ...current, items: current.items.map((item) => item.id === result.updated.id ? result.updated : item) } : current);
      setUndoCommandId("");
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The card change could not be undone.");
    } finally {
      setBusy(false);
    }
  };

  const requestNoteEdit = async () => {
    if (!activeNote || !noteCodexInstruction.trim()) return;
    setBusy(true);
    try {
      const updated = await api<Note>(`/api/notes/${encodeURIComponent(activeNote.id)}/codex-edit`, { method: "POST", body: JSON.stringify({ instruction: noteCodexInstruction.trim() }) });
      setNotes((current) => current.map((note) => note.id === updated.id ? updated : note));
      setNoteCodexInstruction("");
      setNotice("Codex is preparing a document edit. You can keep writing while it works.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Codex could not start the document edit.");
    } finally { setBusy(false); }
  };

  const decideNoteProposal = async (decision: "accept" | "reject") => {
    if (!activeNote?.latestProposal) return;
    setBusy(true);
    try {
      const updated = await api<Note>(`/api/notes/${encodeURIComponent(activeNote.id)}/proposals/${encodeURIComponent(activeNote.latestProposal.id)}`, { method: "PATCH", body: JSON.stringify({ decision }) });
      setNotes((current) => current.map((note) => note.id === updated.id ? updated : note));
      if (decision === "accept") { setNoteTitle(updated.title); setNoteDraft(bodyForEditor(updated.title, updated.body)); setNoteEditId(updated.id); setNoteDirty(false); }
      setNotice(decision === "accept" ? "Codex's edit was applied to the Markdown document." : "The proposed edit was rejected.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The proposal could not be updated.");
    } finally { setBusy(false); }
  };

  const refreshSource = async (source: string) => {
    setBusy(true);
    try {
      await api("/api/source-refresh", { method: "POST", body: JSON.stringify({ source }) });
      setNotice(`${source} is refreshing independently.`);
      await load(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Could not refresh ${source}.`);
    } finally {
      setBusy(false);
    }
  };

  const createContextNote = async () => {
    if (!selected) return;
    const note = await api<Note>("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title: `${selected.companyName} · ${selected.title}`, body: "", type: "project", companySlug: selected.companySlug, workItemId: selected.id }),
    });
    setNotes((current) => [note, ...current]);
    setActiveNoteId(note.id);
    setNoteTitle(note.title);
    setNoteDraft(bodyForEditor(note.title, note.body));
    setNoteEditId(note.id);
    setNoteDirty(false);
    setView("notes");
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return setSearchResults([]);
    try {
      setSearchResults(await api<SearchResult[]>(`/api/search?q=${encodeURIComponent(searchQuery.trim())}`));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Search failed.");
    }
  };

  const openResult = (result: SearchResult) => {
    if (result.kind === "mail") {
      setMailTargetId(result.id);
      setView("mail");
      return;
    }
    if (result.kind === "work_item" || result.workItemId) {
      const targetId = result.kind === "work_item" ? result.id : result.workItemId || "";
      const target = items.find((item) => item.id === targetId);
      setCompanyFilter("all");
      setSourceFilter("all");
      setTypeFilter("all");
      setPriorityFilter("all");
      if (target) setStatusFilter(workViewFor(target));
      setSelectedId(targetId);
      setView("inbox");
      if (window.innerWidth <= 1024) setMobileWorkbenchOpen(true);
    } else if (result.kind === "note") {
      const note = notes.find((item) => item.id === result.id);
      if (note) void selectNote(note).then(() => setView("notes"));
    }
  };

  const openSettings = async () => {
    setView("settings");
    try {
      setPolicies(await api<PreferenceRule[]>("/api/policies"));
    } catch {
      setPolicies([]);
    }
  };

  if (!data) {
    return (
      <main className="loading-shell" role="status">
        <div className="loading-mark">SERENT COMMAND CENTER</div>
        <p>{notice || "Opening your cached work home…"}</p>
        {notice ? <button type="button" onClick={() => void load()}>Retry</button> : null}
      </main>
    );
  }

  return (
    <main className={`app-shell view-${view}`}>
      <aside className="left-rail">
        <div className="workspace-switcher">
          <span className="workspace-logo" aria-hidden="true">S</span>
          <div><strong>Serent</strong><small>Command Center</small></div>
          <button type="button" onClick={() => setCommandOpen(true)} aria-label="Open command menu">...</button>
        </div>

        <nav className="primary-nav" aria-label="Serent Command Center">
          <NavGroup label="Focus" items={focusNavItems} view={view} onSelect={setView} itemCount={items.filter((item) => !["done", "dismissed"].includes(item.status)).length} mailCount={data.mailCounts.needs_reply || 0} />
          <NavGroup label="Workspace" items={workspaceNavItems} view={view} onSelect={setView} />
          <NavGroup label="Intelligence" items={intelligenceNavItems} view={view} onSelect={setView} />
        </nav>

        <section className="company-rail" aria-labelledby="company-filter-title">
          <div className="rail-section-heading">
            <span id="company-filter-title">Companies</span>
            <button type="button" onClick={() => { setCompanyFilter("all"); setView("companies"); }}>View</button>
          </div>
          <button className={companyFilter === "all" ? "company-filter active" : "company-filter"} onClick={() => { setCompanyFilter("all"); setView("inbox"); }} type="button">
            <span>All companies</span><b>{Object.values(data.companyCounts).reduce((sum, count) => sum + count, 0)}</b>
          </button>
          {data.companies.map((company) => (
            <button className={companyFilter === company.slug ? "company-filter active" : "company-filter"} data-company={company.slug} key={company.slug} onClick={() => { setCompanyFilter(company.slug); setView("inbox"); }} type="button">
              <span className="company-filter-name"><i className="company-dot" aria-hidden="true" />{company.displayName}</span><b>{data.companyCounts[company.slug] || 0}</b>
            </button>
          ))}
        </section>

        <div className="rail-footer">
          <button className={view === "settings" ? "settings-link active" : "settings-link"} onClick={() => void openSettings()} type="button">Learning &amp; sources</button>
          <div className="runner-state"><span className="ready-dot" />Local runner ready</div>
          <small>{data.runner.activeJobs} active · Cached {fullDate(data.generatedAt)}</small>
        </div>
      </aside>

      <section className="center-pane">
        <header className="top-bar">
          <form className="quick-capture" onSubmit={(event) => { event.preventDefault(); void capture(); }}>
            <span aria-hidden="true">+</span>
            <input ref={quickRef} aria-label="Quick capture" value={quickCapture} onChange={(event) => setQuickCapture(event.target.value)} placeholder="Capture a thought, commitment, or question…" />
            <kbd>C</kbd>
          </form>
          <button className="command-trigger" type="button" onClick={() => setCommandOpen(true)}><span>Search or jump to</span><kbd>Ctrl K</kbd></button>
          {notice ? <div className="notice-group"><button className="notice" onClick={() => setNotice("")} type="button">{notice}</button>{undoCommandId ? <button className="undo-command" disabled={busy} onClick={() => void undoCardCommand()} type="button">Undo</button> : null}</div> : null}
        </header>

        {view === "inbox" ? (
          <InboxView
            companies={data.companies}
            companyFilter={companyFilter}
            setCompanyFilter={setCompanyFilter}
            filteredItems={filteredItems}
            items={items}
            selectedId={effectiveSelectedId}
            setSelectedId={(id) => {
              setSelectedId(id);
              if (window.innerWidth <= 1024) setMobileWorkbenchOpen(true);
            }}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            sourceFilter={sourceFilter}
            setSourceFilter={setSourceFilter}
            typeFilter={typeFilter}
            setTypeFilter={setTypeFilter}
            priorityFilter={priorityFilter}
            setPriorityFilter={setPriorityFilter}
          />
        ) : null}

        {view === "mail" ? <MailWorkspace companies={data.companies} selectedMessageId={mailTargetId} onNotice={setNotice} onPromoted={() => void load(true)} /> : null}
        {view === "calendar" ? <CalendarWorkspace items={items} onNotice={setNotice} onUpdated={() => void load(true)} /> : null}
        {view === "projects" ? <ProjectWorkspace companyFilter={companyFilter} onNotice={setNotice} onUpdated={() => void load(true)} onOpenWorkItem={(id) => {
          const item = items.find((candidate) => candidate.id === id);
          setSelectedId(id);
          if (item) setStatusFilter(workViewFor(item));
          setView("inbox");
          if (window.innerWidth <= 1024) setMobileWorkbenchOpen(true);
        }} /> : null}
        {view === "pm" ? <PmAgentWorkspace onNotice={setNotice} onOpenWorkItem={(id) => {
          const item = items.find((candidate) => candidate.id === id);
          setSelectedId(id);
          if (item) setStatusFilter(workViewFor(item));
          setView("inbox");
          if (window.innerWidth <= 1024) setMobileWorkbenchOpen(true);
        }} /> : null}

        {view === "companies" ? (
          <section className="content-view">
            <div className="view-heading"><p className="kicker">COMPANY ROOMS</p><h2>Where the work lives</h2><p>Each room combines its complete action inbox with the context behind it.</p></div>
            <div className="company-grid">
              {data.companies.map((company) => {
                const companyItems = items.filter((item) => item.companySlug === company.slug);
                return (
                  <button className="company-card" data-company={company.slug} key={company.slug} onClick={() => { setCompanyFilter(company.slug); setView("inbox"); }} type="button">
                    <span className="company-card-count">{companyItems.filter((item) => !["done", "dismissed"].includes(item.status)).length}</span>
                    <span className="company-card-label"><i className="company-dot" aria-hidden="true" />Company room</span><h3>{company.displayName}</h3>
                    <p>{company.description}</p>
                    <div><span>{companyItems.filter((item) => item.status === "to_review").length} to review</span><span>{companyItems.filter((item) => item.status === "back_for_review").length} returned</span></div>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {view === "notes" ? (
          <section className={noteRailOpen ? "notes-layout" : "notes-layout list-collapsed"}>
            <aside className="note-list" aria-label="Document navigation">
              <div className="view-heading compact"><p className="kicker">DOCUMENTS</p><h2>Your workbench</h2><p>Find a document and keep writing.</p></div>
              <div className="note-list-actions"><button className="new-note" type="button" onClick={async () => {
                const note = await api<Note>("/api/notes", { method: "POST", body: JSON.stringify({ title: "Untitled note", body: "", type: "scratch", companySlug: companyFilter === "all" ? null : companyFilter }) });
                setNotes((current) => [note, ...current]); setActiveNoteId(note.id); setNoteTitle(note.title); setNoteDraft(bodyForEditor(note.title, note.body)); setNoteEditId(note.id); setNoteDirty(false);
              }}>+ New</button><button className="collapse-note-list" type="button" onClick={() => setNoteRailOpen(false)} aria-label="Hide document list">Hide</button></div>
              <input className="note-search" value={noteQuery} onChange={(event) => setNoteQuery(event.target.value)} placeholder="Search documents..." aria-label="Search documents" />
              <div className="note-groups">{noteGroups.map((group) => (
                <section className="note-group" key={group.id}>
                  <h3>{group.label}<span>{group.notes.length}</span></h3>
                  {group.notes.map((note) => (
                    <button className={activeNoteId === note.id ? "note-row active" : "note-row"} key={note.id} onClick={() => void selectNote(note)} type="button">
                      <strong>{note.title}</strong><small>{note.body.replace(/[#*_`>-]/g, "").slice(0, 92) || "Empty note"}</small>
                    </button>
                  ))}
                </section>
              ))}{!noteGroups.length ? <p className="note-empty">No documents match your search.</p> : null}</div>
            </aside>
            <article className="note-editor">
              {activeNote ? (
                <div className="note-page-shell">
                  <div className="note-editor-topbar"><button type="button" onClick={() => setNoteRailOpen((current) => !current)}>{noteRailOpen ? "Hide documents" : "Show documents"}</button><span className={noteDirty ? "save-state saving" : "save-state"}>{noteDirty ? "Saving..." : "Saved locally"}</span></div>
                  <div className="note-page">
                    <div className="note-editor-meta"><span>{activeNote.origin === "manual" ? "Jake's note" : "Agent-generated"}</span><span>{activeNote.type}</span></div>
                    <input className="note-title-input" value={noteEditId === activeNote.id ? noteTitle : activeNote.title} onChange={(event) => { setNoteEditId(activeNote.id); setNoteTitle(event.target.value); setNoteDirty(true); }} aria-label="Note title" placeholder="Untitled" />
                    <MarkdownEditor value={noteEditId === activeNote.id ? noteDraft : bodyForEditor(activeNote.title, activeNote.body)} onChange={(body) => { setNoteEditId(activeNote.id); setNoteDraft(body); setNoteDirty(true); }} placeholder="Start writing, or type Markdown shortcuts like #, -, and [ ]..." ariaLabel="Note body" />
                    {activeNote.latestProposal ? <section className={`note-proposal proposal-${activeNote.latestProposal.status}`}>
                      <div><strong>Codex edit</strong><span>{activeNote.latestProposal.status.replaceAll("_", " ")}</span></div>
                      <p>{activeNote.latestProposal.summary || activeNote.latestProposal.error || `Working on: ${activeNote.latestProposal.instruction}`}</p>
                      {activeNote.latestProposal.status === "ready" ? <><details><summary>Preview revised Markdown</summary><pre>{activeNote.latestProposal.proposedBody}</pre></details><div className="proposal-actions"><button type="button" disabled={busy} onClick={() => void decideNoteProposal("accept")}>Accept edit</button><button type="button" disabled={busy} onClick={() => void decideNoteProposal("reject")}>Reject</button></div></> : null}
                    </section> : null}
                    <details className="note-codex-drawer"><summary>Ask Codex to edit this document</summary>
                      <form className="note-codex-composer" onSubmit={(event) => { event.preventDefault(); void requestNoteEdit(); }}>
                        <label htmlFor="note-codex-instruction">Describe the change you want</label>
                        <textarea id="note-codex-instruction" value={noteCodexInstruction} onChange={(event) => setNoteCodexInstruction(event.target.value)} placeholder="Add an agenda for tomorrow's kickoff using the company context and open questions..." />
                        <button type="submit" disabled={busy || !noteCodexInstruction.trim()}>Propose edit</button>
                      </form>
                    </details>
                    <div className="note-actions"><span>{activeNote.companySlug ? data.companies.find((company) => company.slug === activeNote.companySlug)?.displayName : "Unfiled"}</span><div><details className="document-info"><summary>Document info</summary><small className="document-path">{activeNote.filePath || "Creating local file..."}</small></details><button type="button" onClick={async () => { await api(`/api/notes/${activeNote.id}/promote`, { method: "POST", body: JSON.stringify({}) }); setNotice("Promoted to the action inbox."); await load(); }}>Promote to action</button></div></div>
                  </div>
                </div>
              ) : <p>Select a note.</p>}
            </article>
          </section>
        ) : null}

        {view === "agents" ? (
          <section className="content-view">
            <div className="view-heading"><p className="kicker">AGENTS</p><h2>Background work</h2><p>Every assignment keeps its scope, permitted sources, and result history.</p></div>
            <div className="run-list">
              {allRuns.length ? allRuns.map((run) => (
                <button className="run-row" key={run.id} type="button" onClick={() => { if (run.workItemId) { setSelectedId(run.workItemId); setView("inbox"); } }}>
                  <span className={`run-dot run-${run.status}`} /><div><strong>{run.title}</strong><p>{run.result || run.error || run.waitingReason || "Codex is working in the background."}</p><small>{run.skillId} · {run.scope} · {run.allowedSources.join(", ") || "local context"}</small></div><ItemBadge status={run.status === "review" ? "back_for_review" : run.status as WorkStatus} />
                </button>
              )) : <div className="empty-message">No agent work has been launched from the new workbench yet.</div>}
            </div>
          </section>
        ) : null}

        {view === "search" ? (
          <section className="content-view">
            <div className="view-heading"><p className="kicker">SEARCH</p><h2>Find the thread of work</h2><p>Search actions, notes, and returned agent results together.</p></div>
            <form className="search-form" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}><input ref={searchRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search companies, decisions, notes, and outputs…" /><button type="submit">Search</button></form>
            <div className="search-results">{searchResults.map((result) => <button type="button" key={`${result.kind}-${result.id}`} onClick={() => openResult(result)}><span>{result.kind.replace("_", " ")}</span><strong>{result.title}</strong><p>{result.excerpt}</p></button>)}</div>
          </section>
        ) : null}

        {view === "settings" ? (
          <section className="content-view">
            <div className="view-heading"><p className="kicker">LEARNING &amp; SOURCES</p><h2>What Command Center sees and learns</h2><p>Sources refresh independently. Lasting behavior changes apply only after you accept a proposed rule.</p></div>
            <div className="source-list">{data.sources.map((source) => <div className="source-row" key={source.source}><div><strong>{source.source}</strong><span className={`source-state source-${source.status}`}>{source.status}</span></div><p>{source.error || source.detail}</p><small>{fullDate(source.checkedAt)}</small><button disabled={busy || source.status === "working"} onClick={() => void refreshSource(source.source)} type="button">{source.status === "working" ? "Refreshing…" : "Refresh"}</button></div>)}</div>
            <div className="policy-section"><h3>Reviewed learning</h3>{policies.length ? policies.map((policy) => <article key={policy.id} className={`policy-${policy.status}`}><div className="policy-heading"><strong>{policy.title}</strong><span>{policy.status}</span></div><p>{policy.rationale}</p><textarea value={policy.instruction} onChange={(event) => setPolicies((current) => current.map((item) => item.id === policy.id ? { ...item, instruction: event.target.value } : item))} aria-label={`Rule instruction for ${policy.title}`} /><small>{policy.scopeType}{policy.scopeValue ? ` · ${policy.scopeValue}` : ""} · {policy.category}</small><div className="policy-actions">{policy.status === "proposed" ? <><button type="button" onClick={async () => { const updated = await api<PreferenceRule>(`/api/policies/${policy.id}`, { method: "PATCH", body: JSON.stringify({ status: "accepted", instruction: policy.instruction }) }); setPolicies((current) => current.map((item) => item.id === updated.id ? updated : item)); }}>Accept rule</button><button type="button" onClick={async () => { const updated = await api<PreferenceRule>(`/api/policies/${policy.id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) }); setPolicies((current) => current.map((item) => item.id === updated.id ? updated : item)); }}>Reject</button></> : null}{policy.status === "accepted" ? <button type="button" onClick={async () => { const updated = await api<PreferenceRule>(`/api/policies/${policy.id}`, { method: "PATCH", body: JSON.stringify({ status: "retired" }) }); setPolicies((current) => current.map((item) => item.id === updated.id ? updated : item)); }}>Retire</button> : null}</div></article>) : <p>No learning rules have been proposed yet. Command Center will suggest them after meaningful corrections, dismissals, and edited replies.</p>}</div>
          </section>
        ) : null}
      </section>

      <aside className={mobileWorkbenchOpen ? "workbench mobile-open" : "workbench"} data-company={selected?.companySlug || "unassigned"}>
        {view === "inbox" && selected ? (
          <>
            <button className="mobile-close" type="button" onClick={() => setMobileWorkbenchOpen(false)}>← Back to inbox</button>
            <header className="workbench-header">
              <div><span className="company-badge">{selected.companyName}</span><span className="owner-pill">{cardState(selected).owner}</span><span className={`state-pill state-${workViewFor(selected)}`}>{cardState(selected).label}</span><span className={`action-kind kind-${actionKind(selected).id}`}>{actionKind(selected).label}</span><span className={`priority priority-${selected.priority}`}>{selected.priority}</span></div>
              <h2>{selected.title}</h2>
              <p className="workbench-summary">{selected.summary}</p>
              <div className="card-routing-row">
                <label>Company<select aria-label="Card company assignment" value={selected.companySlug || ""} disabled={busy} onChange={(event) => void patchItem({ companySlug: event.target.value || null, eventDetail: `Jake assigned this card to ${event.target.selectedOptions[0]?.text || "Unassigned"}.` })}><option value="">Unassigned</option>{data.companies.map((company) => <option key={company.slug} value={company.slug}>{company.displayName}</option>)}</select></label>
                <div className="due-date-field">
                  <label htmlFor={`card-due-date-${selected.id}`}>Due date</label>
                  <div>
                    <input id={`card-due-date-${selected.id}`} aria-label="Card due date" type="date" value={dueDateInputValue(selected.dueAt)} disabled={busy} onChange={(event) => { const localDate = event.target.value; void patchItem({ dueAt: dueDateEndOfLocalDayIso(localDate), eventDetail: localDate ? `Jake set the due date to ${localDate}.` : "Jake cleared the due date." }); }} />
                    <button aria-label="Clear due date" type="button" disabled={busy || !selected.dueAt} onClick={() => void patchItem({ dueAt: null, eventDetail: "Jake cleared the due date." })}>Clear</button>
                  </div>
                </div>
                <span>{selected.type.replaceAll("_", " ")}</span>
              </div>
            </header>

            {selected.projectContext ? <button className="project-context-link" type="button" onClick={() => { setCompanyFilter(selected.companySlug || "all"); setView("projects"); }}>
              <span>PROJECT PLAN</span><strong>{selected.projectContext.workstream}</strong><small>{selected.projectContext.phaseTitle} · Due {selected.projectContext.dueDate ? relativeTime(`${selected.projectContext.dueDate}T17:00:00-07:00`) : "not scheduled"}</small>
            </button> : null}

            <section className="why-card"><span>Why Command Center surfaced this</span><p>{selected.whyNow}</p><small>{Math.round(selected.confidence * 100)}% confidence · {relativeTime(selected.dueAt)}</small>{selected.activeRules.length ? <div className="rule-chips">{selected.activeRules.map((rule) => <span key={rule.id}>{rule.title}</span>)}</div> : null}</section>

            {selectedLatestResult ? <section className={`returned-result returned-${selectedLatestResult.status}`}>
              <div><span>{selectedLatestResult.status === "review" ? "Ready for your review" : "Codex needs attention"}</span><time>{fullDate(selectedLatestResult.updatedAt)}</time></div>
              <h3>{selectedLatestResult.title}</h3>
              <p>{selectedLatestResult.result || selectedLatestResult.error}</p>
            </section> : null}

            <details className="workbench-section" open>
              <summary>Likely next action</summary>
              <p className="suggested-action">{selected.suggestedAction}</p>
            </details>

            {selected.type === "meeting_follow_up" ? <section className="meeting-followthrough" aria-live="polite">
              <div className="meeting-followthrough-heading"><div><span>MEETING TO ACTIONS</span><h3>{activeMeetingWorkflow?.state === "processing" ? "Processing the transcript" : activeMeetingWorkflow?.state === "review" ? "Review the follow-ups" : activeMeetingWorkflow?.state === "complete" ? "Meeting processed" : "Add the transcript when it is ready"}</h3></div><span className={`meeting-state meeting-${activeMeetingWorkflow?.state || "loading"}`}>{(activeMeetingWorkflow?.state || "loading").replaceAll("_", " ")}</span></div>
              {!activeMeetingWorkflow ? <p>Loading the meeting workflow...</p> : null}
              {activeMeetingWorkflow && ["waiting_for_transcript", "candidate_review", "error"].includes(activeMeetingWorkflow.state) ? <>
                {activeMeetingWorkflow.noteId ? <div className="meeting-note-receipt"><div><span>Meeting note already saved</span><strong>{activeMeetingWorkflow.noteTitle}</strong><small>Processing the transcript now will extract follow-up cards without creating another note.</small></div><button type="button" onClick={async () => { const nextNotes = await api<Note[]>("/api/notes"); setNotes(nextNotes); const note = nextNotes.find((item) => item.id === activeMeetingWorkflow.noteId); if (note) await selectNote(note); setView("notes"); }}>Open note</button></div> : null}
                <ol className="meeting-steps"><li className="complete">Meeting ended</li><li>Download the Zoom transcript</li><li>Process it here</li><li>Review proposed actions</li></ol>
                {activeMeetingWorkflow.error ? <p className="meeting-error">{activeMeetingWorkflow.error}</p> : null}
                {activeMeetingWorkflow.candidates.length ? <div className="transcript-candidates"><p>{activeMeetingWorkflow.candidates.length === 1 ? "I found this likely transcript:" : "Choose the transcript for this meeting:"}</p>{activeMeetingWorkflow.candidates.map((candidate) => <button key={candidate.path} type="button" disabled={busy} onClick={() => void processMeetingTranscript(candidate.path)}><strong>{candidate.name}</strong><span>{candidate.reasons.join(" · ") || `Downloaded ${fullDate(candidate.modifiedAt)}`}</span></button>)}</div> : <div className="transcript-empty"><p>Download the transcript to your Downloads folder. Command Center will not process anything until you click below.</p><button type="button" disabled={busy} onClick={() => void processMeetingTranscript()}>{busy ? "Checking..." : "I downloaded it — find transcript"}</button></div>}
                <button className="no-transcript-action" type="button" disabled={busy} onClick={() => void closeMeetingWithoutTranscript()}>No transcript was recorded</button>
              </> : null}
              {activeMeetingWorkflow?.state === "processing" ? <div className="meeting-processing"><span className="processing-dot" /><div><strong>Codex is reading the transcript</strong><p>It will save one meeting note and return proposed actions to this card. Nothing is being sent or written to ClickUp.</p></div></div> : null}
              {activeMeetingWorkflow && ["review", "complete"].includes(activeMeetingWorkflow.state) ? <>
                <div className="meeting-note-receipt"><div><span>Saved meeting note</span><strong>{activeMeetingWorkflow.noteTitle}</strong>{activeMeetingWorkflow.noteFilePath ? <small>{activeMeetingWorkflow.noteFilePath}</small> : null}</div>{activeMeetingWorkflow.noteId ? <button type="button" onClick={async () => { const nextNotes = await api<Note[]>("/api/notes"); setNotes(nextNotes); const note = nextNotes.find((item) => item.id === activeMeetingWorkflow.noteId); if (note) await selectNote(note); setView("notes"); }}>Open note</button> : null}</div>
                <div className="meeting-suggestions"><div className="meeting-suggestions-title"><strong>Proposed follow-ups</strong><span>{activeMeetingWorkflow.suggestions.filter((item) => item.decision === "proposed").length} to review</span></div>
                  {activeMeetingWorkflow.suggestions.length ? activeMeetingWorkflow.suggestions.map((suggestion) => <article key={suggestion.id} className={`meeting-suggestion decision-${suggestion.decision}`}>
                    <div className="meeting-suggestion-meta"><span>{suggestion.ownerState === "jake" ? "Jake owns" : "Waiting on someone else"}</span><span>{suggestion.priority}</span>{suggestion.existingWorkItemId ? <span>Matches existing card</span> : null}</div>
                    {meetingEdit?.id === suggestion.id ? <div className="meeting-suggestion-editor"><label>Action<input value={meetingEdit.title} onChange={(event) => setMeetingEdit({ ...meetingEdit, title: event.target.value })} /></label><label>Next step<textarea value={meetingEdit.suggestedAction} onChange={(event) => setMeetingEdit({ ...meetingEdit, suggestedAction: event.target.value })} /></label><div><button type="button" disabled={busy || !meetingEdit.title.trim()} onClick={() => void saveMeetingSuggestionEdit()}>Save edit</button><button className="secondary" type="button" disabled={busy} onClick={() => setMeetingEdit(null)}>Cancel</button></div></div> : <><h4>{suggestion.title}</h4><p>{suggestion.summary}</p><strong className="meeting-next-step">Next: {suggestion.suggestedAction}</strong>{suggestion.evidenceTimestamp ? <small>Evidence: {suggestion.evidenceTimestamp}</small> : null}{suggestion.decision === "proposed" ? <div><button type="button" disabled={busy} onClick={() => void decideMeetingSuggestion(suggestion.id, "accept")}>{suggestion.existingWorkItemId ? "Link to existing card" : suggestion.ownerState === "external" ? "Add to Waiting" : "Add to Open Work"}</button><button className="secondary" type="button" disabled={busy} onClick={() => setMeetingEdit({ id: suggestion.id, title: suggestion.title, suggestedAction: suggestion.suggestedAction })}>Edit</button><button className="secondary" type="button" disabled={busy} onClick={() => void decideMeetingSuggestion(suggestion.id, "reject")}>Ignore</button></div> : <div className="suggestion-decision">{suggestion.decision === "accepted" ? "Added" : "Ignored"}</div>}</>}
                  </article>) : <p className="muted-copy">No follow-up actions were identified. The meeting note is still saved.</p>}
                </div>
                {activeMeetingWorkflow.state === "review" ? <button className="finish-meeting-review" type="button" disabled={busy || activeMeetingWorkflow.suggestions.some((item) => item.decision === "proposed")} onClick={() => void finishMeetingReview()}>Finish meeting review</button> : null}
              </> : null}
            </section> : null}

            <details className="workbench-section optional-workspace" open={Boolean(visibleDraft)}>
              <summary>{selectedWorkingSurface?.label || "Working notes"} <span>Optional</span></summary>
              <textarea className="draft-editor" value={visibleDraft} onChange={(event) => { setDraftItemId(selected.id); setDraft(event.target.value); }} placeholder={selectedWorkingSurface?.placeholder || "Capture optional working notes..."} aria-label={selectedWorkingSurface?.label || "Working notes"} />
              <div className="inline-actions"><button type="button" disabled={busy || !visibleDraft.trim()} onClick={() => void patchItem({ draft: visibleDraft, eventDetail: `${selectedWorkingSurface?.label || "Working notes"} updated.` })}>Save to card</button></div>
              <small className="approval-copy">This stays on the card. It is not a Codex instruction and is not sent anywhere.</small>
            </details>

            <details className="workbench-section" open>
              <summary>Sources &amp; history</summary>
              <div className="source-chips">{selected.sources.map((source) => source.sourceUrl ? <a href={source.sourceUrl} target="_blank" rel="noreferrer" key={source.id}>{source.provider} · {source.freshness}</a> : <span key={source.id} title={source.sourcePath}>{source.provider} · {source.freshness}</span>)}</div>
              <ol className="history-list">{selected.events.slice(0, 6).map((event) => <li key={event.id}><span>{event.type.replaceAll("_", " ")}</span><p>{event.detail}</p><time>{fullDate(event.createdAt)}</time></li>)}</ol>
            </details>

            <details className="workbench-section" open={selected.agentRuns.length > 0}>
              <summary>Codex work {selected.agentRuns.length ? `(${selected.agentRuns.length})` : ""}</summary>
              {selected.agentRuns.length ? selected.agentRuns.map((run) => <article className={`agent-result agent-${run.status}`} key={run.id}>
                <div><strong>{run.status === "review" ? "Ready for your review" : run.status === "error" ? "Needs attention" : run.status === "waiting_on_user" ? "Waiting for you" : "Codex is working"}</strong><time>{fullDate(run.updatedAt)}</time></div>
                {["queued", "working"].includes(run.status) ? <div className="activity-receipt"><p><span>Working on</span>{requestedOutcome(run)}</p><p><span>Using</span>{run.allowedSources.map(sourceName).join(", ") || "card context"}</p><p><span>Returns to</span>This card for your review</p><p><span>External actions</span>None</p><small>Started {relativeTime(run.createdAt)}</small></div> : <p>{run.result || run.error || run.waitingReason || "No result was returned."}</p>}
                {run.status === "review" ? <button type="button" onClick={() => setComposer("Revise this result: ")}>Revise with feedback</button> : null}
              </article>) : <p className="muted-copy">Codex has not worked on this item yet.</p>}
            </details>

            {selected.codexTasks.length ? <details className="workbench-section" open>
              <summary>Separate Codex tasks ({selected.codexTasks.length})</summary>
               {selected.codexTasks.map((task) => {
                 const presentation = codexTaskPresentation(task);
                 return <article className={`codex-task-receipt task-${task.status}`} key={task.id}><div><strong>{task.title}</strong><span>{presentation.label}</span></div><p>{presentation.detail}</p>{task.threadId ? <footer><small>Verified native task receipt; Command Center does not control execution</small><button type="button" onClick={() => void reopenCodexTask(task.threadId)}>Open task</button></footer> : task.status === "waiting_on_user" ? <footer><small>Prepared only; no task is running</small><button type="button" onClick={() => void openCodexTask(task.instruction)}>Open in Codex</button></footer> : null}</article>;
               })}
            </details> : null}

            {selected.externalActions.length ? <details className="workbench-section" open>
              <summary>System receipts</summary>
              {selected.externalActions.map((action) => <article className={`external-receipt receipt-${action.status}`} key={action.id}><div><strong>{action.provider} · {action.actionType.replaceAll("_", " ")}</strong><span>{action.status}</span></div><p>{action.receipt || action.error || `Updating ${action.targetId}...`}</p></article>)}
            </details> : null}

            <details className="workbench-section">
              <summary>Linked notes {selected.notes.length ? `(${selected.notes.length})` : ""}</summary>
              {selected.notes.map((note) => <button className="linked-note" key={note.id} type="button" onClick={() => void selectNote(note).then(() => setView("notes"))}><strong>{note.title}</strong><span>{note.body.slice(0, 100) || "Empty note"}</span></button>)}
              <button className="text-action" type="button" onClick={() => void createContextNote()}>+ Add contextual note</button>
            </details>

            <div className="resolution-actions">
              {selected.decisionState === "proposed" ? <button className="accept-action" disabled={busy} type="button" onClick={() => void acceptAction()}>I&apos;ll handle it</button> : null}
              {selected.status === "waiting_external" ? <button className="accept-action" disabled={busy} type="button" onClick={() => void patchItem({ status: "to_review", eventDetail: "Jake is following up on this waiting item." })}>Follow up now</button> : null}
              {selected.status === "error" ? <button className="accept-action" disabled={busy} type="button" onClick={() => void patchItem({ status: "to_review", eventDetail: "Returned to Jake's work after an error." })}>Return to Open Work</button> : null}
              {selected.type !== "meeting_follow_up" && !['queued','working'].includes(selected.status) ? <button disabled={busy} type="button" onClick={() => void patchItem({ status: "done", resolution: "Completed from the Command Center workbench." })}>{selected.status === "back_for_review" ? "Accept & mark done" : "Done"}</button> : null}
              {!['queued','working'].includes(selected.status) && selected.sources.some((source) => source.provider === "clickup" && Boolean(source.sourceId || /\/t\/[a-zA-Z0-9_-]+/.test(source.sourceUrl))) ? <button className="clickup-complete" disabled={busy || selected.externalActions.some((action) => ["queued","working"].includes(action.status))} type="button" onClick={() => void completeInClickUp()}>Done in ClickUp</button> : null}
              {!['queued','working','done','dismissed'].includes(selected.status) ? <button disabled={busy} type="button" onClick={() => void patchItem({ status: "dismissed", eventDetail: "Jake marked this item as not needed." })}>Not needed</button> : null}
            </div>

            {selectedPreparedTask ? <section className="codex-active-banner codex-ready-banner"><strong>Ready to open in Codex</strong><p>{selectedPreparedTask.instruction}</p><small>This handoff is prepared, but no Codex task is running yet.</small><button type="button" disabled={busy} onClick={() => void openCodexTask(selectedPreparedTask.instruction)}>Open native Codex task</button></section> : null}
            {selectedActiveRun || selectedActiveTask ? <section className="codex-active-banner"><strong>{selectedActiveRun?.status === "waiting_on_user" ? "Waiting for your input" : selectedActiveTask?.status === "accepted" ? "Accepted by Codex; waiting to start" : "Codex is working on this"}</strong><p>{selectedActiveRun ? selectedActiveRun.waitingReason || requestedOutcome(selectedActiveRun) : selectedActiveTask?.instruction}</p><small>{selectedActiveTask ? "This status comes from a verified native task callback." : "The result will return to this card. No external action will be taken."}</small></section> : null}
            <form className="codex-composer" onSubmit={(event) => { event.preventDefault(); void submitCodexChoice(); }}>
              {selected.preparationMode === "auto" ? <p className="auto-prep-note">PM agent: this preparation is ready to delegate. A native Codex task starts only when you open the handoff.</p> : null}
              <div><span>Change this card or ask Codex to work on it</span><select value={codexDestination} onChange={(event) => setCodexDestination(event.target.value as "card" | "task")} aria-label="Where Codex should work"><option value="card">Smart: update card or open Codex task</option><option value="task">Always open a separate Codex task</option></select></div>
              <textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="Try: Move this to Friday, set priority high, or draft the follow-up email..." aria-label="Card instruction" />
              <div className="composer-actions"><button className="open-codex-task" type="submit" disabled={busy}>{codexDestination === "task" ? "Open native Codex task" : "Apply or open"}</button></div>
            </form>
          </>
        ) : (
          <div className="workbench-placeholder"><p className="kicker">WORKBENCH</p><h2>{view === "notes" ? "Write alongside the work" : "Select an action to begin"}</h2><p>Your sources, notes, drafts, approvals, and Codex assignments stay together here.</p></div>
        )}
      </aside>

      {commandOpen ? <div className="command-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setCommandOpen(false); }}>
        <section className="command-menu" role="dialog" aria-modal="true" aria-label="Command menu">
          <header><span>Command Center</span><kbd>Esc</kbd></header>
          <div className="command-menu-search"><span aria-hidden="true">/</span><input autoFocus aria-label="Command search" placeholder="Search or choose a destination..." onKeyDown={(event) => { if (event.key === "Enter") { setView("search"); setCommandOpen(false); window.setTimeout(() => searchRef.current?.focus(), 0); } }} /></div>
          <p>Go to</p>
          <div className="command-actions">{navItems.map(([id, label]) => <button type="button" key={id} onClick={() => { setView(id); setCommandOpen(false); }}><span className="command-action-mark" aria-hidden="true" />{label}<small>{id === "inbox" ? "J / K to move" : ""}</small></button>)}</div>
          <footer><span><kbd>C</kbd> Create</span><span><kbd>/</kbd> Search</span><span><kbd>J</kbd><kbd>K</kbd> Navigate</span></footer>
        </section>
      </div> : null}
    </main>
  );
}

function NavGroup({ label, items, view, onSelect, itemCount, mailCount }: {
  label: string;
  items: ReadonlyArray<(typeof navItems)[number]>;
  view: (typeof navItems)[number][0] | "settings";
  onSelect: (view: (typeof navItems)[number][0]) => void;
  itemCount?: number;
  mailCount?: number;
}) {
  return <section className="nav-group"><p>{label}</p>{items.map(([id, itemLabel]) => (
    <button key={id} data-nav={id} className={view === id ? "nav-item active" : "nav-item"} onClick={() => onSelect(id)} type="button">
      <span className="nav-mark" aria-hidden="true" />{itemLabel}
      {id === "inbox" && itemCount !== undefined ? <span className="nav-count">{itemCount}</span> : null}
      {id === "mail" && mailCount !== undefined ? <span className="nav-count">{mailCount}</span> : null}
    </button>
  ))}</section>;
}

function InboxView({
  companies,
  companyFilter,
  setCompanyFilter,
  filteredItems,
  items,
  selectedId,
  setSelectedId,
  statusFilter,
  setStatusFilter,
  sourceFilter,
  setSourceFilter,
  typeFilter,
  setTypeFilter,
  priorityFilter,
  setPriorityFilter,
}: {
  companies: Company[];
  companyFilter: string;
  setCompanyFilter: (company: string) => void;
  filteredItems: WorkItem[];
  items: WorkItem[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  statusFilter: WorkView;
  setStatusFilter: (status: WorkView) => void;
  sourceFilter: string;
  setSourceFilter: (source: string) => void;
  typeFilter: string;
  setTypeFilter: (type: string) => void;
  priorityFilter: string;
  setPriorityFilter: (priority: string) => void;
}) {
  const [dayAnchor] = useState(() => new Date());
  const [layoutMode, setLayoutMode] = useState<"list" | "board">("list");
  const companyName = companyFilter === "all" ? "All companies" : companies.find((company) => company.slug === companyFilter)?.displayName || "Company";
  const sources = [...new Set(items.flatMap((item) => item.sources.map((source) => source.provider)))];
  const types = [...new Set(items.map((item) => item.type))];
  const viewCopy: Record<WorkView, string> = {
    open: "Everything still outstanding, including work waiting on someone else, ordered by when it needs to happen.",
    codex_working: "Work Codex is actively processing or preparing to start.",
    done: "Completed work and items you decided were not needed.",
  };
  const viewLabel = workViews.find((workView) => workView.id === statusFilter)?.label || "Open Work";
  const sortedItems = [...filteredItems].sort((left, right) => {
    const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return leftDue - rightDue || right.updatedAt.localeCompare(left.updatedAt);
  });
  const groupedItems = dueBuckets.map((bucket) => ({ ...bucket, items: sortedItems.filter((item) => dueBucketFor(item, dayAnchor) === bucket.id) })).filter((bucket) => bucket.items.length);
  const renderCard = (item: WorkItem, board = false) => {
    const state = cardState(item);
    const dueBucket = dueBucketFor(item, dayAnchor);
    return (
      <button className={`${board ? "issue-board-card" : "feed-card issue-row"}${selectedId === item.id ? " selected" : ""}`} data-company={item.companySlug || "unassigned"} key={item.id} onClick={() => setSelectedId(item.id)} type="button">
        <span className={`issue-status-icon status-${item.status}`} aria-label={statusMeta[item.status].label} />
        <span className="issue-row-main"><strong>{item.title}</strong><span><span className="feed-company"><i className="company-dot" aria-hidden="true" />{item.companyName}</span>{state.label !== "Ready" ? <span className={item.status === "error" ? "feed-state feed-state-critical" : item.status === "waiting_external" ? "feed-state feed-state-waiting" : "feed-state"}>{state.label}</span> : null}</span></span>
        <span className={`issue-priority priority-${item.priority}`} aria-label={`${item.priority} priority`}>{item.priority === "urgent" ? "!!!" : item.priority === "high" ? "!!" : item.priority === "normal" ? "-" : ""}</span>
        <time className={`due-chip due-${dueBucket}`}>{dueLabel(item, dayAnchor)}</time>
      </button>
    );
  };
  return (
    <section className="inbox-view">
      <div className="inbox-heading">
        <div><p className="issue-breadcrumb">Workspace / My work</p><h2>{viewLabel}</h2><p>{companyName} / {filteredItems.length} items. {viewCopy[statusFilter]}</p></div>
        <div className="layout-toggle" aria-label="Layout"><button className={layoutMode === "list" ? "active" : ""} type="button" onClick={() => setLayoutMode("list")}>List</button><button className={layoutMode === "board" ? "active" : ""} type="button" onClick={() => setLayoutMode("board")}>Board</button></div>
      </div>

      <div className="status-tabs work-view-tabs" role="tablist" aria-label="Work view">
        {workViews.map((workView) => {
          const inCompany = items.filter((item) => companyFilter === "all" || item.companySlug === companyFilter);
          const count = inCompany.filter((item) => workViewFor(item) === workView.id).length;
          return <button className={statusFilter === workView.id ? "active" : ""} key={workView.id} type="button" onClick={() => setStatusFilter(workView.id)}>{workView.label}<span>{count}</span></button>;
        })}
      </div>

      <div className="filter-row" aria-label="View filters">
        <select value={companyFilter} onChange={(event) => setCompanyFilter(event.target.value)} aria-label="Filter by company"><option value="all">All companies</option>{companies.map((company) => <option key={company.slug} value={company.slug}>{company.displayName}</option>)}</select>
        <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)} aria-label="Filter by priority"><option value="all">All urgency</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select>
        <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} aria-label="Filter by source"><option value="all">All sources</option>{sources.map((source) => <option key={source} value={source}>{source}</option>)}</select>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter by work type"><option value="all">All work types</option>{types.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}</select>
      </div>

      <div className={layoutMode === "board" ? "feed-list issue-board" : "feed-list issue-list"}>
        {layoutMode === "list" && filteredItems.length && statusFilter === "open" ? groupedItems.map((bucket) => <section className={`due-group due-group-${bucket.id}`} key={bucket.id} aria-labelledby={`due-group-${bucket.id}`}>
          <header className="due-group-heading"><span className="due-group-dot" aria-hidden="true" /><h3 id={`due-group-${bucket.id}`}>{bucket.label}</h3><b>{bucket.items.length}</b></header>
          <div className="due-group-list">{bucket.items.map((item) => renderCard(item))}</div>
        </section>) : null}
        {layoutMode === "list" && filteredItems.length && statusFilter !== "open" ? <section className="due-group"><header className="due-group-heading"><span className="due-group-dot" aria-hidden="true" /><h3>{viewLabel}</h3><b>{sortedItems.length}</b></header><div className="due-group-list">{sortedItems.map((item) => renderCard(item))}</div></section> : null}
        {layoutMode === "board" && filteredItems.length ? groupedItems.map((bucket) => <section className={`issue-board-column due-group-${bucket.id}`} key={bucket.id}><header><span className="due-group-dot" aria-hidden="true" /><h3>{bucket.label}</h3><b>{bucket.items.length}</b></header><div>{bucket.items.map((item) => renderCard(item, true))}</div></section>) : null}
        {!filteredItems.length ? <div className="empty-message"><strong>Nothing in this view.</strong><p>Choose another view or clear a filter.</p></div> : null}
      </div>
    </section>
  );
}
