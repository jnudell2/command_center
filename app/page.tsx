"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MailWorkspace from "./mail-workspace";
import CalendarWorkspace from "./calendar-workspace";
import MarkdownEditor from "./markdown-editor";
import ProjectWorkspace from "./project-workspace";
import TranscriptWorkspace from "./transcript-workspace";
import { type Assignment } from "./card-workbench-model";
import { cardState as simplifiedCardState, nextAction, showPriority, workingSurface as simplifiedWorkingSurface } from "./card-view-model";
import { dueDateEndOfLocalDayIso, dueDateInputValue } from "./due-date";
import { workViewFor, workViews, type WorkView } from "./work-view";
import { type IntelligenceReviewView, type RelationshipView } from "./ceo-read";
import { buildExecutiveCardRead } from "./executive-card-read";
import { UILab } from "./ui-lab";

type WorkStatus =
  | "to_review"
  | "queued"
  | "working"
  | "waiting_on_user"
  | "waiting_external"
  | "needs_attention"
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
  waitingOn: string;
  followUpAt: string | null;
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
  assignments: Assignment[];
  relationships: RelationshipView[];
  intelligenceReview: IntelligenceReviewView | null;
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

type CompletionUndo = {
  token: string;
  itemId: string;
  title: string;
};

type DeterministicUndo = {
  mutationId: string;
  title: string;
  message: string;
};

const runnerUrl = "http://127.0.0.1:4318";

const navItems = [
  ["inbox", "Open Work"],
  ["mail", "Mail"],
  ["calendar", "Calendar"],
  ["projects", "Projects"],
  ["documents", "Documents"],
  ["transcripts", "Transcripts"],
  ["notes", "Notes"],
  ["companies", "Companies"],
  ["search", "Search"],
] as const;
type ViewId = (typeof navItems)[number][0] | "settings" | "ui_lab";
const focusNavItems = navItems.filter(([id]) => ["inbox", "mail", "calendar"].includes(id));
const workspaceNavItems = navItems.filter(([id]) => ["projects", "documents", "transcripts", "notes", "companies"].includes(id));
const intelligenceNavItems = navItems.filter(([id]) => id === "search");

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

function directBusinessStatusValue(status: WorkStatus) {
  return ["to_review", "waiting_on_user", "waiting_external", "back_for_review", "needs_attention", "done", "dismissed", "queued", "working"].includes(status) ? status : "to_review";
}

export default function Home() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<ViewId>("inbox");
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
  const [cardEditItemId, setCardEditItemId] = useState("");
  const [detailAnchor] = useState(() => new Date());
  const [quickCapture, setQuickCapture] = useState("");
  const [draft, setDraft] = useState("");
  const [draftItemId, setDraftItemId] = useState("");
  const [waitingFor, setWaitingFor] = useState("");
  const [waitingFollowUp, setWaitingFollowUp] = useState("");
  const [waitingItemId, setWaitingItemId] = useState("");
  const [evidenceLabel, setEvidenceLabel] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [canonicalWorkItemId, setCanonicalWorkItemId] = useState("");
  const [completingItemId, setCompletingItemId] = useState("");
  const [completionUndo, setCompletionUndo] = useState<CompletionUndo | null>(null);
  const [deterministicUndo, setDeterministicUndo] = useState<DeterministicUndo | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNoteId, setActiveNoteId] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteEditId, setNoteEditId] = useState("");
  const [noteDirty, setNoteDirty] = useState(false);
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
  const completionUndoTimer = useRef<number | null>(null);
  const deterministicUndoTimer = useRef<number | null>(null);

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

  useEffect(() => () => {
    if (completionUndoTimer.current !== null) window.clearTimeout(completionUndoTimer.current);
    if (deterministicUndoTimer.current !== null) window.clearTimeout(deterministicUndoTimer.current);
  }, []);

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
  const workspaceNotes = useMemo(() => {
    if (view === "notes") return filteredNotes.filter((note) => ["daily", "scratch"].includes(note.type));
    if (view === "documents") return filteredNotes.filter((note) => ["meeting", "project", "decision"].includes(note.type));
    return filteredNotes;
  }, [filteredNotes, view]);
  const noteGroups = useMemo(() => [
    { id: "daily", label: "Daily", notes: workspaceNotes.filter((note) => note.type === "daily") },
    { id: "meetings", label: "Meetings", notes: workspaceNotes.filter((note) => note.type === "meeting") },
    { id: "projects", label: "Projects & decisions", notes: workspaceNotes.filter((note) => ["project", "decision"].includes(note.type)) },
    { id: "notes", label: "Notes", notes: workspaceNotes.filter((note) => note.type === "scratch") },
  ].filter((group) => group.notes.length), [workspaceNotes]);

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
  const selectedPool = view === "inbox" ? filteredItems : items;
  const effectiveSelectedId = selectedPool.some((item) => item.id === selectedId) ? selectedId : selectedPool[0]?.id || "";
  const selected = items.find((item) => item.id === effectiveSelectedId) || null;
  const executiveRead = selected ? buildExecutiveCardRead(selected, detailAnchor) : null;
  const cardEditOpen = Boolean(selected && cardEditItemId === selected.id);
  const selectedWorkingSurface = selected ? simplifiedWorkingSurface(selected) : null;
  const selectedLatestResult = selected?.agentRuns.filter((run) => ["review", "error"].includes(run.status)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
  const selectedLatestAssignment = selected?.assignments.filter((assignment) => ["completed", "failed", "needs_input", "needs_attention"].includes(assignment.status)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
  const selectedMeetingId = selected?.type === "meeting_follow_up" ? selected.id : "";
  const activeMeetingWorkflow = meetingWorkflow?.workItemId === selectedMeetingId ? meetingWorkflow : null;
  const visibleDraft = selected && draftItemId === selected.id ? draft : selected?.draft || "";

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

  const markWaiting = async () => {
    if (!selected || waitingItemId !== selected.id || !waitingFor.trim()) return;
    const person = waitingFor.trim();
    await mutateSelected("waiting", { waitingOn: person, followUpAt: waitingFollowUp ? dueDateEndOfLocalDayIso(waitingFollowUp) : null }, `Waiting on ${person}.`);
    setWaitingFor("");
    setWaitingFollowUp("");
    setWaitingItemId("");
  };

  const createCommittedTask = async (title: string, dueDate: string) => {
    setBusy(true);
    try {
      const created = await api<WorkItem>("/api/work-items", { method: "POST", body: JSON.stringify({ title, type: "task", companySlug: companyFilter === "all" ? null : companyFilter, dueAt: dueDateEndOfLocalDayIso(dueDate), sourceKey: `direct-ui:${crypto.randomUUID()}` }) });
      setData((current) => current ? { ...current, items: [created, ...current.items], companyCounts: { ...current.companyCounts, ...(created.companySlug ? { [created.companySlug]: (current.companyCounts[created.companySlug] || 0) + 1 } : {}) } } : current);
      setSelectedId(created.id);
      setNotice("Committed task captured locally. No agent was involved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The committed task could not be captured.");
    } finally {
      setBusy(false);
    }
  };

  const addEvidenceLink = async () => {
    if (!selected || !evidenceLabel.trim() || !evidenceUrl.trim()) return;
    await mutateSelected("add_evidence", { label: evidenceLabel.trim(), sourceUrl: evidenceUrl.trim(), provider: "manual" }, "Evidence link added locally.");
    setEvidenceLabel("");
    setEvidenceUrl("");
  };

  const linkCanonicalDuplicate = async () => {
    if (!selected || !canonicalWorkItemId.trim()) return;
    await mutateSelected("link_duplicate", { canonicalWorkItemId: canonicalWorkItemId.trim(), rationale: "Jake explicitly linked this card to its canonical commitment." }, "Duplicate relationship linked without changing either card's business status.");
    setCanonicalWorkItemId("");
  };

  const completeFromOpenWork = async (item: WorkItem) => {
    if (["done", "dismissed"].includes(item.status) || completingItemId) return;
    setCompletingItemId(item.id);
    try {
      const result = await api<{ updated: WorkItem; undoToken: string }>(`/api/work-items/${encodeURIComponent(item.id)}/command`, {
        method: "POST",
        body: JSON.stringify({ instruction: "Mark this done" }),
      });
      if (result.updated.status !== "done" || !result.undoToken) throw new Error("Completion could not be verified.");
      setData((current) => current ? { ...current, items: current.items.map((candidate) => candidate.id === result.updated.id ? result.updated : candidate) } : current);
      setCompletionUndo({ token: result.undoToken, itemId: item.id, title: item.title });
      setNotice("");
      if (completionUndoTimer.current !== null) window.clearTimeout(completionUndoTimer.current);
      completionUndoTimer.current = window.setTimeout(() => setCompletionUndo(null), 10_000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The item could not be completed.");
    } finally {
      setCompletingItemId("");
    }
  };

  const mutateSelected = async (type: "update" | "done" | "dismiss" | "waiting" | "add_evidence" | "link_duplicate", payload: Record<string, unknown>, confirmation: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api<{ mutationId: string; replayed: boolean; updated: WorkItem; undoAvailable: boolean }>(`/api/work-items/${encodeURIComponent(selected.id)}/mutations`, {
        method: "POST",
        body: JSON.stringify({ type, idempotencyKey: `ui:${selected.id}:${type}:${crypto.randomUUID()}`, ...payload }),
      });
      setData((current) => current ? { ...current, items: current.items.map((item) => item.id === result.updated.id ? result.updated : item) } : current);
      if (result.undoAvailable) {
        setDeterministicUndo({ mutationId: result.mutationId, title: selected.title, message: confirmation });
        if (deterministicUndoTimer.current !== null) window.clearTimeout(deterministicUndoTimer.current);
        deterministicUndoTimer.current = window.setTimeout(() => setDeterministicUndo(null), 12_000);
      }
      setNotice(confirmation);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The local change could not be verified.");
    } finally {
      setBusy(false);
    }
  };

  const undoDeterministicChange = async () => {
    const pending = deterministicUndo;
    if (!pending || busy) return;
    setBusy(true);
    try {
      const result = await api<{ updated: WorkItem; message: string }>(`/api/deterministic-mutations/${encodeURIComponent(pending.mutationId)}/undo`, { method: "POST", body: "{}" });
      setData((current) => current ? { ...current, items: current.items.map((item) => item.id === result.updated.id ? result.updated : item) } : current);
      setDeterministicUndo(null);
      if (deterministicUndoTimer.current !== null) window.clearTimeout(deterministicUndoTimer.current);
      deterministicUndoTimer.current = null;
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Undo is no longer safe for this change.");
    } finally {
      setBusy(false);
    }
  };

  const undoOpenWorkCompletion = async () => {
    const pending = completionUndo;
    if (!pending || completingItemId) return;
    setCompletingItemId(pending.itemId);
    try {
      const result = await api<{ updated: WorkItem; message: string }>(`/api/card-commands/${encodeURIComponent(pending.token)}/undo`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setData((current) => current ? { ...current, items: current.items.map((candidate) => candidate.id === result.updated.id ? result.updated : candidate) } : current);
      setCompletionUndo(null);
      if (completionUndoTimer.current !== null) window.clearTimeout(completionUndoTimer.current);
      completionUndoTimer.current = null;
      setNotice(`Restored “${pending.title}” to ${simplifiedCardState(result.updated).label}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The completion could not be undone.");
    } finally {
      setCompletingItemId("");
    }
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
          <button className={["settings", "ui_lab"].includes(view) ? "settings-link active" : "settings-link"} onClick={() => void openSettings()} type="button">Learning &amp; sources</button>
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
          {notice ? <div className="notice-group"><button className="notice" onClick={() => setNotice("")} type="button">{notice}</button></div> : null}
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
            onMarkDone={(item) => void completeFromOpenWork(item)}
            onCreateTask={(title, dueDate) => void createCommittedTask(title, dueDate)}
            completingItemId={completingItemId}
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

        {view === "mail" ? <MailWorkspace companies={data.companies} selectedMessageId={mailTargetId} onNotice={setNotice} onPromoted={() => void load(true)} onOpenWorkItem={(id) => { setSelectedId(id); setView("inbox"); setMobileWorkbenchOpen(true); }} /> : null}
        {view === "calendar" ? <CalendarWorkspace items={items} onNotice={setNotice} onUpdated={() => void load(true)} /> : null}
        {view === "projects" ? <ProjectWorkspace companyFilter={companyFilter} onNotice={setNotice} onUpdated={() => void load(true)} onOpenWorkItem={(id) => {
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

        {view === "transcripts" ? <TranscriptWorkspace items={items} notes={notes} onOpenItem={(id) => {
          const item = items.find((candidate) => candidate.id === id);
          setSelectedId(id);
          if (item) setStatusFilter(workViewFor(item));
          setView("inbox");
          if (window.innerWidth <= 1024) setMobileWorkbenchOpen(true);
        }} onOpenNote={(id) => {
          const note = notes.find((candidate) => candidate.id === id);
          if (note) void selectNote(note).then(() => setView("notes"));
        }} /> : null}

        {view === "notes" || view === "documents" ? (
          <section className={noteRailOpen ? "notes-layout" : "notes-layout list-collapsed"}>
            <aside className="note-list" aria-label="Document navigation">
              <div className="view-heading compact"><p className="kicker">{view === "notes" ? "NOTES" : "DOCUMENTS"}</p><h2>{view === "notes" ? "Your thinking space" : "Your workbench"}</h2><p>{view === "notes" ? "Keep decisions and working thoughts easy to find." : "Find a document and keep writing."}</p></div>
              <div className="note-list-actions"><button className="new-note" type="button" onClick={async () => {
                const note = await api<Note>("/api/notes", { method: "POST", body: JSON.stringify({ title: "Untitled note", body: "", type: view === "documents" ? "project" : "scratch", companySlug: companyFilter === "all" ? null : companyFilter }) });
                setNotes((current) => [note, ...current]); setActiveNoteId(note.id); setNoteTitle(note.title); setNoteDraft(bodyForEditor(note.title, note.body)); setNoteEditId(note.id); setNoteDirty(false);
              }}>+ New</button><button className="collapse-note-list" type="button" onClick={() => setNoteRailOpen(false)} aria-label="Hide document list">Hide</button></div>
              <input className="note-search" value={noteQuery} onChange={(event) => setNoteQuery(event.target.value)} placeholder={view === "notes" ? "Search notes..." : "Search documents..."} aria-label={view === "notes" ? "Search notes" : "Search documents"} />
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
                    <div className="note-actions"><span>{activeNote.companySlug ? data.companies.find((company) => company.slug === activeNote.companySlug)?.displayName : "Unfiled"}</span><div><details className="document-info"><summary>Document info</summary><small className="document-path">{activeNote.filePath || "Creating local file..."}</small></details><button type="button" onClick={async () => { await api(`/api/notes/${activeNote.id}/promote`, { method: "POST", body: JSON.stringify({}) }); setNotice("Promoted to the action inbox."); await load(); }}>Promote to action</button></div></div>
                  </div>
                </div>
              ) : <p>Select a note.</p>}
            </article>
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
            <div className="view-heading view-heading-actions"><div><p className="kicker">LEARNING &amp; SOURCES</p><h2>What Command Center sees and learns</h2><p>Sources refresh independently. Lasting behavior changes apply only after you accept a proposed rule.</p></div><button className="button-secondary" type="button" onClick={() => setView("ui_lab")}>Open UI lab</button></div>
            <div className="source-list">{data.sources.map((source) => <div className="source-row" key={source.source}><div><strong>{source.source}</strong><span className={`source-state source-${source.status}`}>{source.status}</span></div><p>{source.error || source.detail}</p><small>{fullDate(source.checkedAt)}</small><button disabled={busy || source.status === "working"} onClick={() => void refreshSource(source.source)} type="button">{source.status === "working" ? "Refreshing…" : "Refresh"}</button></div>)}</div>
            <div className="policy-section"><h3>Reviewed learning</h3>{policies.length ? policies.map((policy) => <article key={policy.id} className={`policy-${policy.status}`}><div className="policy-heading"><strong>{policy.title}</strong><span>{policy.status}</span></div><p>{policy.rationale}</p><textarea value={policy.instruction} onChange={(event) => setPolicies((current) => current.map((item) => item.id === policy.id ? { ...item, instruction: event.target.value } : item))} aria-label={`Rule instruction for ${policy.title}`} /><small>{policy.scopeType}{policy.scopeValue ? ` · ${policy.scopeValue}` : ""} · {policy.category}</small><div className="policy-actions">{policy.status === "proposed" ? <><button type="button" onClick={async () => { const updated = await api<PreferenceRule>(`/api/policies/${policy.id}`, { method: "PATCH", body: JSON.stringify({ status: "accepted", instruction: policy.instruction }) }); setPolicies((current) => current.map((item) => item.id === updated.id ? updated : item)); }}>Accept rule</button><button type="button" onClick={async () => { const updated = await api<PreferenceRule>(`/api/policies/${policy.id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) }); setPolicies((current) => current.map((item) => item.id === updated.id ? updated : item)); }}>Reject</button></> : null}{policy.status === "accepted" ? <button type="button" onClick={async () => { const updated = await api<PreferenceRule>(`/api/policies/${policy.id}`, { method: "PATCH", body: JSON.stringify({ status: "retired" }) }); setPolicies((current) => current.map((item) => item.id === updated.id ? updated : item)); }}>Retire</button> : null}</div></article>) : <p>No learning rules have been proposed yet. Command Center will suggest them after meaningful corrections, dismissals, and edited replies.</p>}</div>
          </section>
        ) : null}

        {view === "ui_lab" ? <UILab onClose={() => void openSettings()} /> : null}
      </section>

      <aside className={mobileWorkbenchOpen ? "workbench mobile-open" : "workbench"} data-company={selected?.companySlug || "unassigned"}>
        {view === "inbox" && selected && executiveRead ? (
          <>
            <button className="mobile-close" type="button" onClick={() => setMobileWorkbenchOpen(false)}>← Back to Open Work</button>
            <header className="decision-header">
              <div className="decision-header-meta"><span className="company-badge">{selected.companyName || "Personal"}</span><span className={`state-pill state-${workViewFor(selected)}`}>{executiveRead.stateLabel}</span><span className={`detail-risk due-${dueBucketFor(selected, detailAnchor)}`}>{dueLabel(selected, detailAnchor)}</span></div>
              <div className="decision-header-actions"><button className="edit-card-trigger" type="button" aria-expanded={cardEditOpen} onClick={() => setCardEditItemId(cardEditOpen ? "" : selected.id)}>{cardEditOpen ? "Close edit" : "Edit"}</button><details className="card-overflow"><summary aria-label="More card actions">…</summary><div>{selected.sources.find((source) => source.sourceUrl) ? <a href={selected.sources.find((source) => source.sourceUrl)!.sourceUrl} target="_blank" rel="noreferrer">Open source</a> : null}<button type="button" onClick={() => void createContextNote()}>Add contextual note</button></div></details></div>
              <h2>{selected.title}</h2>
            </header>

            {cardEditOpen ? <section className="card-edit-panel" aria-label="Edit card">
              <header><div><span className="eyebrow">CARD ADMINISTRATION</span><h3>Edit durable fields</h3></div><button type="button" onClick={() => setCardEditItemId("")}>Done editing</button></header>
              <div className="card-edit-fields">
                <label htmlFor={`card-due-date-${selected.id}`}>Due date<input id={`card-due-date-${selected.id}`} aria-label="Card due date" type="date" value={dueDateInputValue(selected.dueAt)} disabled={busy} onChange={(event) => { const localDate = event.target.value; void mutateSelected("update", { changes: { dueAt: dueDateEndOfLocalDayIso(localDate) } }, localDate ? `Due date set to ${localDate}.` : "Due date cleared."); }} /></label>
                <label>Priority<select aria-label="Card priority" value={selected.priority} disabled={busy} onChange={(event) => void mutateSelected("update", { changes: { priority: event.target.value } }, `Priority changed to ${event.target.value}.`)}><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
                <label>Owner<input key={`owner-${selected.id}-${selected.owner}`} aria-label="Card owner" defaultValue={selected.owner || "Jake"} disabled={busy} onBlur={(event) => { const owner = event.currentTarget.value.trim() || "Jake"; if (owner !== selected.owner) void mutateSelected("update", { changes: { owner } }, `Owner changed to ${owner}.`); }} /></label>
                <label>Status<select aria-label="Card business status" value={directBusinessStatusValue(selected.status)} disabled={busy} onChange={(event) => { if (event.target.value === "waiting_external") { setWaitingItemId(selected.id); setWaitingFor(selected.waitingOn || ""); setWaitingFollowUp(dueDateInputValue(selected.followUpAt)); } else void mutateSelected("update", { changes: { status: event.target.value } }, "Business status updated."); }}><option value="to_review">Open</option><option value="waiting_on_user">Waiting on Jake</option><option value="waiting_external">Waiting on someone</option><option value="back_for_review">Ready for Jake</option><option value="needs_attention">Needs attention</option><option value="done">Done</option><option value="dismissed">Not needed</option>{["queued", "working"].includes(selected.status) ? <option value={selected.status}>Legacy · needs reconciliation</option> : null}</select></label>
              </div>
              <button className="waiting-detail-trigger" type="button" onClick={() => { setWaitingItemId(selected.id); setWaitingFor(selected.waitingOn || ""); setWaitingFollowUp(dueDateInputValue(selected.followUpAt)); }}>Edit waiting dependency and follow-up</button>
              {waitingItemId === selected.id ? <form className="waiting-editor" onSubmit={(event) => { event.preventDefault(); void markWaiting(); }}><label htmlFor={`waiting-on-${selected.id}`}>Who or what are you waiting on?</label><div><input id={`waiting-on-${selected.id}`} autoFocus value={waitingFor} onChange={(event) => setWaitingFor(event.target.value)} placeholder="Kyle, customer data, legal review…" /><label htmlFor={`waiting-follow-up-${selected.id}`}>Follow up<input id={`waiting-follow-up-${selected.id}`} type="date" value={waitingFollowUp} onChange={(event) => setWaitingFollowUp(event.target.value)} /></label><button type="submit" disabled={busy || !waitingFor.trim()}>Save waiting state</button><button className="secondary" type="button" onClick={() => { setWaitingItemId(""); setWaitingFor(""); setWaitingFollowUp(""); }}>Cancel</button></div></form> : null}
              <details className="add-evidence-disclosure"><summary>Add evidence</summary><form className="add-evidence-form" onSubmit={(event) => { event.preventDefault(); void addEvidenceLink(); }}><label>Label<input value={evidenceLabel} onChange={(event) => setEvidenceLabel(event.target.value)} placeholder="Kickoff deck commitment" /></label><label>URL<input type="url" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} placeholder="https://…" /></label><button type="submit" disabled={busy || !evidenceLabel.trim() || !evidenceUrl.trim()}>Add locally</button></form></details>
            </section> : null}

            <section className="decision-section current-read" aria-labelledby="current-read-heading">
              <header><span className="decision-label">Current read</span>{executiveRead.authorityMeta ? <small>{executiveRead.authorityMeta}</small> : null}</header>
              <h3 id="current-read-heading">{executiveRead.currentTruth}</h3>
              {executiveRead.artifactLabel ? <div className="material-result"><span>Reviewable artifact</span><strong>{executiveRead.artifactLabel}</strong>{executiveRead.materialConclusion ? <p>{executiveRead.materialConclusion}</p> : null}</div> : null}
            </section>

            <section className="decision-section next-move" aria-labelledby="next-move-heading">
              <span className="decision-label">Your next move</span>
              <h3 id="next-move-heading">{executiveRead.nextMove}</h3>
              <dl className="next-move-facts"><div><dt>Actor</dt><dd>{executiveRead.actor}</dd></div><div><dt>Dependency</dt><dd>{executiveRead.dependency}</dd></div><div><dt>By when</dt><dd>{executiveRead.timing}</dd></div></dl>
              <p className="done-condition"><span>Done when</span>{executiveRead.doneWhen}</p>
            </section>

            {executiveRead.contradictions.length ? <section className="reconciliation-alert" role="status" aria-labelledby="reconciliation-alert-heading"><header><span>Needs reconciliation</span><strong id="reconciliation-alert-heading">The card and newer evidence do not agree.</strong></header><ul>{executiveRead.contradictions.map((contradiction) => <li key={contradiction}>{contradiction}</li>)}</ul></section> : null}

            <section className="decision-section why-now" aria-labelledby="why-now-heading"><span className="decision-label">Why now</span><h3 id="why-now-heading">{executiveRead.whyNow}</h3></section>

            <section className="decision-section evidence-related" aria-labelledby="evidence-related-heading">
              <span className="decision-label" id="evidence-related-heading">Evidence &amp; related work</span>
              <div className="evidence-related-grid"><div><h4>Evidence</h4>{executiveRead.evidence.length ? executiveRead.evidence.map((evidence) => evidence.url ? <a className="evidence-row" href={evidence.url} target="_blank" rel="noreferrer" key={evidence.key}><strong>{evidence.label}</strong><span>{evidence.meta}</span></a> : <div className="evidence-row" key={evidence.key}><strong>{evidence.label}</strong><span>{evidence.meta}</span></div>) : <p>No linked evidence yet.</p>}</div><div><h4>Related work</h4>{executiveRead.relatedWork.length ? executiveRead.relatedWork.map((related) => related.workItemId ? <button className="related-work-row" type="button" key={related.key} onClick={() => { setSelectedId(related.workItemId); setMobileWorkbenchOpen(true); }}><strong>{related.label}</strong><span>{related.relation}</span></button> : <button className="related-work-row" type="button" key={related.key} onClick={() => { setCompanyFilter(selected.companySlug || "all"); setView("projects"); }}><strong>{related.label}</strong><span>{related.relation}</span></button>) : <p>No related work linked.</p>}</div></div>
              {activeMeetingWorkflow?.event ? <dl className="meeting-evidence-facts"><div><dt>Meeting</dt><dd>{fullDate(activeMeetingWorkflow.event.startAt)}</dd></div><div><dt>Attendees</dt><dd>{activeMeetingWorkflow.event.attendees.map((attendee) => attendee.name || attendee.email).filter(Boolean).join(", ") || "Not listed"}</dd></div></dl> : null}
            </section>

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

            <details className="card-section optional-workspace">
              <summary><span><small>Working notes</small>{selectedWorkingSurface?.label || "Working notes"}</span></summary>
              <textarea className="draft-editor" value={visibleDraft} onChange={(event) => { setDraftItemId(selected.id); setDraft(event.target.value); }} placeholder={selectedWorkingSurface?.placeholder || "Capture optional working notes..."} aria-label={selectedWorkingSurface?.label || "Working notes"} />
              <div className="inline-actions"><button type="button" disabled={busy || !visibleDraft.trim()} onClick={() => void patchItem({ draft: visibleDraft, eventDetail: `${selectedWorkingSurface?.label || "Working notes"} updated.` })}>Save to card</button></div>
              <small className="approval-copy">This stays on the card and is not sent anywhere.</small>
            </details>

            <details className="card-section card-details">
              <summary><span><small>Administration</small>Card details</span></summary>
              <dl className="card-detail-facts"><div><dt>Status</dt><dd>{executiveRead.stateLabel}</dd></div><div><dt>Owner</dt><dd>{selected.owner || "Jake"}</dd></div><div><dt>Priority</dt><dd>{selected.priority}</dd></div><div><dt>Due</dt><dd>{dueLabel(selected, detailAnchor)}</dd></div><div><dt>Type</dt><dd>{selected.type.replaceAll("_", " ")}</dd></div><div><dt>Sources</dt><dd>{selected.sources.length}</dd></div></dl>
              <p className="card-detail-summary">{selected.summary}</p>
              <details className="canonical-link-control"><summary>Link an explicit duplicate</summary><p>This records a canonical relationship only. It does not dismiss or merge either card.</p><form onSubmit={(event) => { event.preventDefault(); void linkCanonicalDuplicate(); }}><label>Canonical work-item ID<input value={canonicalWorkItemId} onChange={(event) => setCanonicalWorkItemId(event.target.value)} placeholder="Existing work-item ID" /></label><button type="submit" disabled={busy || !canonicalWorkItemId.trim()}>Confirm link</button></form></details>
            </details>

            <details className="card-section card-history activity-receipts">
              <summary><span><small>Audit</small>Activity and technical receipts</span></summary>
              {selectedLatestAssignment || selectedLatestResult ? <div className="activity-material"><strong>{selectedLatestAssignment?.status === "completed" || selectedLatestResult?.status === "review" ? "New evidence" : "Activity receipt"}</strong><p>{selectedLatestAssignment?.result || selectedLatestAssignment?.error || selectedLatestResult?.result || selectedLatestResult?.error}</p></div> : null}
              <div className="source-chips">{selected.sources.map((source) => source.sourceUrl ? <a href={source.sourceUrl} target="_blank" rel="noreferrer" key={source.id}>{source.provider} · {source.freshness}</a> : <span key={source.id}>{source.provider} · {source.freshness}</span>)}</div>
              <ol className="history-list">{selected.events.map((event) => <li key={event.id}><span>{event.type.replaceAll("_", " ")}</span><p>{event.detail}</p><time>{fullDate(event.createdAt)}</time></li>)}</ol>
              {selected.assignments.length ? <div className="audit-group"><h4>Assignment receipts</h4>{selected.assignments.map((assignment) => <article key={assignment.id}><strong>{assignment.status.replaceAll("_", " ")}</strong><span>{assignment.ownerId || "No owner"}</span><p>{assignment.result || assignment.error || assignment.instruction}</p><small>{fullDate(assignment.updatedAt)}</small></article>)}</div> : null}
              {selected.agentRuns.length ? <div className="audit-group"><h4>Native work history</h4>{selected.agentRuns.map((run) => <article key={run.id}><strong>{run.status.replaceAll("_", " ")}</strong><p>{run.result || run.error || run.waitingReason || run.intent}</p><small>{fullDate(run.updatedAt)}</small></article>)}</div> : null}
              {selected.codexTasks.length ? <div className="audit-group"><h4>Legacy task receipts</h4>{selected.codexTasks.map((task) => <article key={task.id}><strong>{task.title}</strong><span>{task.status.replaceAll("_", " ")}</span><p>{task.result || task.error || task.instruction}</p></article>)}</div> : null}
              {selected.externalActions.length ? <div className="audit-group"><h4>System receipts</h4>{selected.externalActions.map((action) => <article key={action.id}><strong>{action.provider} · {action.actionType.replaceAll("_", " ")}</strong><span>{action.status}</span><p>{action.receipt || action.error || action.targetId}</p></article>)}</div> : null}
            </details>
          </>
        ) : (
          <div className="workbench-placeholder"><p className="kicker">DETAILS</p><h2>{view === "notes" || view === "documents" ? "Write alongside the work" : "Select an item to see its full context"}</h2><p>Command Center keeps commitments, evidence, notes, and verified results together.</p></div>
        )}
      </aside>

      {completionUndo ? <div className="completion-undo" role="status" aria-live="polite"><span>Marked “{completionUndo.title}” done.</span><button type="button" disabled={Boolean(completingItemId)} onClick={() => void undoOpenWorkCompletion()}>Undo</button></div> : null}
      {deterministicUndo ? <div className="deterministic-undo" role="status" aria-live="polite"><span>{deterministicUndo.message}</span><button type="button" disabled={busy} onClick={() => void undoDeterministicChange()}>Undo</button></div> : null}

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
  view: ViewId;
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
  onMarkDone,
  onCreateTask,
  completingItemId,
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
  onMarkDone: (item: WorkItem) => void;
  onCreateTask: (title: string, dueDate: string) => void;
  completingItemId: string;
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
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDue, setNewTaskDue] = useState("");
  const companyName = companyFilter === "all" ? "All companies" : companies.find((company) => company.slug === companyFilter)?.displayName || "Company";
  const sources = [...new Set(items.flatMap((item) => item.sources.map((source) => source.provider)))];
  const types = [...new Set(items.map((item) => item.type))];
  const viewCopy: Record<WorkView, string> = {
    open: "Everything still outstanding, including work waiting on someone else, ordered by when it needs to happen.",
    done: "Completed work and items you decided were not needed.",
  };
  const viewLabel = workViews.find((workView) => workView.id === statusFilter)?.label || "Open Work";
  const sortedItems = [...filteredItems].sort((left, right) => {
    const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return leftDue - rightDue || right.updatedAt.localeCompare(left.updatedAt);
  });
  const groupedItems = dueBuckets.map((bucket) => ({ ...bucket, items: sortedItems.filter((item) => dueBucketFor(item, dayAnchor) === bucket.id) })).filter((bucket) => bucket.items.length);
  const reconciliationItems = items.filter((item) => (companyFilter === "all" || item.companySlug === companyFilter) && ["new_evidence", "needs_reconciliation"].includes(item.intelligenceReview?.status || ""));
  const renderCard = (item: WorkItem, board = false) => {
    const state = simplifiedCardState(item);
    const dueBucket = dueBucketFor(item, dayAnchor);
    const unresolved = !["done", "dismissed"].includes(item.status);
    return (
      <article className={`${board ? "issue-board-card" : "feed-card issue-row"}${selectedId === item.id ? " selected" : ""}`} data-company={item.companySlug || "unassigned"} key={item.id}>
        {unresolved ? <button className="issue-completion" type="button" aria-label={`Mark ${item.title} done`} title="Mark done" disabled={completingItemId === item.id} onClick={(event) => { event.stopPropagation(); onMarkDone(item); }}><span className={`issue-status-icon status-${item.status}`} aria-hidden="true" /></button> : <span className="issue-completion-static" aria-label={state.label}><span className={`issue-status-icon status-${item.status}`} aria-hidden="true" /></span>}
        <button className="issue-card-open" type="button" aria-label={`Open ${item.title}`} onClick={() => setSelectedId(item.id)}>
          <span className="issue-row-main"><span className="issue-row-meta"><span className="feed-company"><i className="company-dot" aria-hidden="true" />{item.companyName || "Personal"}</span><span className={item.status === "error" ? "feed-state feed-state-critical" : item.status === "waiting_external" ? "feed-state feed-state-waiting" : "feed-state"}>{state.label}</span>{item.intelligenceReview?.status === "new_evidence" ? <span className="insight-indicator">New evidence</span> : item.intelligenceReview?.status === "needs_reconciliation" ? <span className="insight-indicator">Needs reconciliation</span> : null}</span><strong>{item.title}</strong><span className="issue-next"><b>Next</b>{nextAction(item)}</span></span>
          {showPriority(item.priority) ? <span className={`issue-priority-label priority-${item.priority}`}>{item.priority}</span> : null}
          <time className={`due-chip due-${dueBucket}`}>{dueLabel(item, dayAnchor)}</time>
        </button>
      </article>
    );
  };
  return (
    <section className="inbox-view">
      <div className="inbox-heading">
        <div><p className="issue-breadcrumb">Workspace / Open Work</p><h2>{viewLabel}</h2><p>{companyName} / {filteredItems.length} items. {viewCopy[statusFilter]}</p></div>
        <div className="inbox-heading-actions"><button className="new-task-trigger" type="button" onClick={() => setNewTaskOpen((current) => !current)}>+ New task</button><div className="layout-toggle" aria-label="Layout"><button className={layoutMode === "list" ? "active" : ""} type="button" onClick={() => setLayoutMode("list")}>List</button><button className={layoutMode === "board" ? "active" : ""} type="button" onClick={() => setLayoutMode("board")}>Board</button></div></div>
      </div>

      {newTaskOpen ? <form className="new-task-form" onSubmit={(event) => { event.preventDefault(); if (!newTaskTitle.trim()) return; onCreateTask(newTaskTitle.trim(), newTaskDue); setNewTaskTitle(""); setNewTaskDue(""); setNewTaskOpen(false); }}><label>Committed task<input autoFocus value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="What needs to happen?" /></label><label>Due date<input type="date" value={newTaskDue} onChange={(event) => setNewTaskDue(event.target.value)} /></label><button type="submit" disabled={!newTaskTitle.trim()}>Add to Open Work</button><button className="button-secondary" type="button" onClick={() => setNewTaskOpen(false)}>Cancel</button><small>Creates a committed local card. No agent is involved.</small></form> : null}

      <div className="status-tabs work-view-tabs" role="tablist" aria-label="Work view">
        {workViews.map((workView) => {
          const inCompany = items.filter((item) => companyFilter === "all" || item.companySlug === companyFilter);
          const count = inCompany.filter((item) => workViewFor(item) === workView.id).length;
          return <button className={statusFilter === workView.id ? "active" : ""} key={workView.id} type="button" onClick={() => setStatusFilter(workView.id)}>{workView.label}<span>{count}</span></button>;
        })}
      </div>

      {statusFilter === "open" && reconciliationItems.length ? <section className="reconciliation-queue" aria-labelledby="reconciliation-queue-heading"><header><div><span className="eyebrow">CEO INTELLIGENCE SHADOW</span><h3 id="reconciliation-queue-heading">Needs reconciliation</h3></div><b>{reconciliationItems.length}</b></header><p>New evidence or a contradiction needs CEO / PM judgment. Durable card status has not been changed.</p><div>{reconciliationItems.slice(0, 4).map((item) => <button type="button" key={item.id} onClick={() => setSelectedId(item.id)}><span>{item.companyName}</span><strong>{item.title}</strong><small>{item.intelligenceReview?.status === "new_evidence" ? "New evidence" : "Needs reconciliation"}</small></button>)}</div></section> : null}

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
