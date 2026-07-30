"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const runnerUrl = "http://127.0.0.1:4318";
const requestHeaders = { "Content-Type": "application/json", "X-Serent-Command-Center": "1" };
const dayStartMinutes = 7 * 60;
const dayEndMinutes = 19 * 60;
const pixelsPerMinute = 1.15;
const timelineHeight = (dayEndMinutes - dayStartMinutes) * pixelsPerMinute;

type CalendarEvent = { id: string; subject: string; startAt: string; endAt: string; isAllDay: boolean; organizer: { name: string; email: string }; attendees: Array<{ name?: string; email?: string }>; location: string; webLink: string; freshness: string; lastSyncedAt: string };
type CalendarReceipt = { status: string; checkedAt: string; detail: string; error: string } | null;
type Action = { id: string; title: string; type: string; companyName: string; priority: string; status: string; decisionState: string; dueAt: string | null; plannedAt: string | null; plannedMinutes: number; suggestedAction: string };
type LocalWorkBlock = { id: string; title: string; startAt: string; endAt: string; state: "active" | "cancelled"; source: "manual"; createdAt: string; updatedAt: string };
type PlanOverride = { plannedAt: string | null; plannedMinutes: number };
type DragState = { kind: "action"; item: Action; minutes: number } | { kind: "manual"; block: LocalWorkBlock; minutes: number } | null;
type LaidOutEvent = { event: CalendarEvent; column: number; columns: number };
type CalendarUndo = { kind: "manual"; block: LocalWorkBlock } | { kind: "action"; item: Action; plannedAt: string; plannedMinutes: number };

function dayStart(date: Date) { const next = new Date(date); next.setHours(0, 0, 0, 0); return next; }
function addDays(date: Date, days: number) { const next = new Date(date); next.setDate(next.getDate() + days); return next; }
function sameDay(value: string | null, day: Date) { if (!value) return false; const date = new Date(value); return date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate(); }
function time(value: string) { return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function dateKey(day: Date) { return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`; }
function estimate(action: Action) { const text = `${action.type} ${action.title}`.toLowerCase(); if (/deck|presentation|model|artifact/.test(text)) return 90; if (/meeting_prep|prepare|agenda/.test(text)) return 45; if (/email|reply|follow.?up|outreach/.test(text)) return 30; if (/schedul/.test(text)) return 20; return 45; }
function roundQuarter(date: Date) { const next = new Date(date); next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15, 0, 0); return next; }
function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)); }
function minutesOfDay(value: string | Date) { const date = typeof value === "string" ? new Date(value) : value; return date.getHours() * 60 + date.getMinutes(); }
function startAtMinute(day: Date, minute: number) { const next = new Date(day); next.setHours(Math.floor(minute / 60), minute % 60, 0, 0); return next; }
function timeInputValue(date: Date) { return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }
function blockStartFor(day: Date, value: string) {
  const [hour, minute] = value.split(":").map(Number);
  const next = new Date(day);
  next.setHours(hour, minute, 0, 0);
  return next;
}
function defaultBlockTime(day: Date, now: Date) {
  if (day.toDateString() !== now.toDateString()) return "09:00";
  const next = roundQuarter(new Date(now));
  const minute = clamp(minutesOfDay(next), dayStartMinutes, dayEndMinutes - 15);
  return timeInputValue(startAtMinute(day, minute));
}
function workBlockMinutes(block: LocalWorkBlock) { return Math.max(15, Math.round((Date.parse(block.endAt) - Date.parse(block.startAt)) / 60_000)); }
function blockPosition(startAt: string, endAt?: string, minutes?: number) {
  const start = minutesOfDay(startAt);
  const duration = endAt ? Math.max(15, (new Date(endAt).getTime() - new Date(startAt).getTime()) / 60_000) : Math.max(15, minutes || 45);
  const visibleStart = clamp(start, dayStartMinutes, dayEndMinutes);
  const visibleEnd = clamp(start + duration, dayStartMinutes, dayEndMinutes);
  return { top: (visibleStart - dayStartMinutes) * pixelsPerMinute, height: Math.max(28, (visibleEnd - visibleStart) * pixelsPerMinute) };
}

function layoutEvents(events: CalendarEvent[]) {
  const laidOut: LaidOutEvent[] = [];
  let group: Array<{ event: CalendarEvent; column: number }> = [];
  let columnEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    const columns = Math.max(1, ...group.map((entry) => entry.column + 1));
    laidOut.push(...group.map((entry) => ({ ...entry, columns })));
    group = []; columnEnds = []; groupEnd = -Infinity;
  };
  for (const event of events) {
    const start = new Date(event.startAt).getTime();
    const end = new Date(event.endAt).getTime();
    if (group.length && start >= groupEnd) flush();
    const openColumn = columnEnds.findIndex((columnEnd) => columnEnd <= start);
    const column = openColumn >= 0 ? openColumn : columnEnds.length;
    columnEnds[column] = end;
    group.push({ event, column });
    groupEnd = Math.max(groupEnd, end);
  }
  if (group.length) flush();
  return laidOut;
}

function suggestBlocks(selectedDay: Date, now: Date, actions: Action[], events: CalendarEvent[]) {
  const workdayStart = new Date(selectedDay); workdayStart.setHours(8, 30, 0, 0);
  const workdayEnd = new Date(selectedDay); workdayEnd.setHours(18, 0, 0, 0);
  let cursor = selectedDay.toDateString() === now.toDateString() ? roundQuarter(new Date(Math.max(now.getTime(), workdayStart.getTime()))) : workdayStart;
  const planned = actions.filter((item) => sameDay(item.plannedAt, selectedDay));
  const occupied: Array<[Date, Date]> = [
    ...events.filter((event) => !event.isAllDay).map((event) => [new Date(event.startAt), new Date(event.endAt)] as [Date, Date]),
    ...planned.map((item) => [new Date(item.plannedAt!), new Date(new Date(item.plannedAt!).getTime() + (item.plannedMinutes || estimate(item)) * 60_000)] as [Date, Date]),
  ].sort((a, b) => a[0].getTime() - b[0].getTime());

  const available = (minutes: number) => {
    for (const [busyStart, busyEnd] of occupied) {
      if (cursor >= busyEnd) continue;
      if (cursor.getTime() + minutes * 60_000 <= busyStart.getTime()) break;
      if (cursor < busyEnd) cursor = roundQuarter(busyEnd);
    }
    if (cursor.getTime() + minutes * 60_000 > workdayEnd.getTime()) return null;
    const slot = new Date(cursor);
    cursor = new Date(cursor.getTime() + minutes * 60_000);
    occupied.push([slot, new Date(cursor)]);
    occupied.sort((a, b) => a[0].getTime() - b[0].getTime());
    return slot;
  };

  const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as Record<string, number>;
  return actions.filter((item) => !item.plannedAt)
    .sort((a, b) => (Date.parse(a.dueAt || "9999-12-31") - Date.parse(b.dueAt || "9999-12-31")) || ((rank[a.priority] ?? 4) - (rank[b.priority] ?? 4)))
    .map((item) => ({ item, minutes: estimate(item), start: available(estimate(item)) }));
}

export default function CalendarWorkspace({ items, onUpdated, onNotice }: { items: Action[]; onUpdated: () => void; onNotice: (message: string) => void }) {
  const [now] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(() => dayStart(now.getHours() >= 16 ? addDays(now, 1) : now));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [workBlocks, setWorkBlocks] = useState<LocalWorkBlock[]>([]);
  const [receipt, setReceipt] = useState<CalendarReceipt>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<DragState>(null);
  const [dragOverTimeline, setDragOverTimeline] = useState(false);
  const [planOverrides, setPlanOverrides] = useState<Record<string, PlanOverride>>({});
  const [resizePreview, setResizePreview] = useState<{ id: string; minutes: number } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualTime, setManualTime] = useState(() => defaultBlockTime(selectedDay, now));
  const [manualMinutes, setManualMinutes] = useState(45);
  const [manualWorkItemId, setManualWorkItemId] = useState("");
  const [editingBlockId, setEditingBlockId] = useState("");
  const [calendarUndo, setCalendarUndo] = useState<CalendarUndo | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const manualRequestKey = useRef("");

  const load = useCallback(async () => {
    const start = dayStart(selectedDay); const end = addDays(start, 1);
    const response = await fetch(`${runnerUrl}/api/calendar?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`, { cache: "no-store", headers: { "X-Serent-Command-Center": "1" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Calendar could not load.");
    setEvents(data.events || []); setWorkBlocks(data.workBlocks || []); setReceipt(data.receipt || null);
  }, [selectedDay]);

  const refresh = useCallback(async (manual = false) => {
    setBusy(true);
    try {
      await fetch(`${runnerUrl}/api/calendar/refresh`, { method: "POST", headers: requestHeaders, body: "{}" });
      const deadline = Date.now() + 7000;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        await load();
        const response = await fetch(`${runnerUrl}/api/calendar?start=${encodeURIComponent(dayStart(selectedDay).toISOString())}&end=${encodeURIComponent(addDays(dayStart(selectedDay), 1).toISOString())}`, { cache: "no-store", headers: { "X-Serent-Command-Center": "1" } });
        const next = await response.json();
        if (next.receipt?.status !== "working") break;
      } while (Date.now() < deadline);
      if (manual) onNotice("Calendar refreshed from Outlook.");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Calendar could not refresh.");
    } finally {
      setBusy(false);
    }
  }, [load, onNotice, selectedDay]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error) => onNotice(error instanceof Error ? error.message : "Calendar could not load.")), 0);
    return () => window.clearTimeout(timer);
  }, [load, onNotice]);
  useEffect(() => { void fetch(`${runnerUrl}/api/calendar/refresh`, { method: "POST", headers: requestHeaders, body: "{}" }); }, []);
  useEffect(() => {
    if (!calendarUndo) return;
    const timer = window.setTimeout(() => setCalendarUndo(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [calendarUndo]);

  const effectiveItems = useMemo(() => items.map((item) => planOverrides[item.id] ? { ...item, ...planOverrides[item.id] } : item), [items, planOverrides]);
  const timed = useMemo(() => events.filter((event) => !event.isAllDay).sort((a, b) => a.startAt.localeCompare(b.startAt)), [events]);
  const timedLayout = useMemo(() => layoutEvents(timed), [timed]);
  const allDay = useMemo(() => events.filter((event) => event.isAllDay), [events]);
  const dayActions = useMemo(() => effectiveItems.filter((item) => !["done", "dismissed", "queued", "working"].includes(item.status) && item.decisionState !== "proposed" && (sameDay(item.plannedAt, selectedDay) || (!item.plannedAt && (!item.dueAt || new Date(item.dueAt) <= addDays(selectedDay, 1))))), [effectiveItems, selectedDay]);
  const planned = useMemo(() => dayActions.filter((item) => sameDay(item.plannedAt, selectedDay)).sort((a, b) => String(a.plannedAt).localeCompare(String(b.plannedAt))), [dayActions, selectedDay]);
  const suggestions = useMemo(() => suggestBlocks(selectedDay, now, dayActions, events), [selectedDay, now, dayActions, events]);
  const linkableItems = useMemo(() => effectiveItems.filter((item) => !["done", "dismissed", "queued", "working"].includes(item.status) && item.decisionState !== "proposed"), [effectiveItems]);
  const selectedLinkedItem = linkableItems.find((item) => item.id === manualWorkItemId) || null;
  const manualStart = useMemo(() => blockStartFor(selectedDay, manualTime), [manualTime, selectedDay]);
  const manualEnd = useMemo(() => new Date(manualStart.getTime() + manualMinutes * 60_000), [manualMinutes, manualStart]);
  const manualConflict = useMemo(() => {
    const intervals = [
      ...timed.map((event) => ({ title: event.subject, start: Date.parse(event.startAt), end: Date.parse(event.endAt) })),
      ...planned.filter((item) => item.id !== manualWorkItemId).map((item) => ({ title: item.title, start: Date.parse(item.plannedAt!), end: Date.parse(item.plannedAt!) + (item.plannedMinutes || estimate(item)) * 60_000 })),
      ...workBlocks.filter((block) => block.id !== editingBlockId).map((block) => ({ title: block.title, start: Date.parse(block.startAt), end: Date.parse(block.endAt) })),
    ];
    return intervals.find((interval) => manualStart.getTime() < interval.end && manualEnd.getTime() > interval.start)?.title || "";
  }, [editingBlockId, manualEnd, manualStart, manualWorkItemId, planned, timed, workBlocks]);

  const plan = async (item: Action, start: Date, minutes: number) => {
    const override = { plannedAt: start.toISOString(), plannedMinutes: clamp(Math.round(minutes / 15) * 15, 15, 240) };
    setPlanOverrides((current) => ({ ...current, [item.id]: override }));
    setBusy(true);
    try {
      const response = await fetch(`${runnerUrl}/api/work-items/${encodeURIComponent(item.id)}`, { method: "PATCH", headers: requestHeaders, body: JSON.stringify({ ...override, eventDetail: `Planned for ${start.toLocaleString()}.` }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The work block could not be saved.");
      onNotice(`Planned "${item.title}" for ${time(start.toISOString())}.`);
      onUpdated();
    } catch (error) {
      setPlanOverrides((current) => { const next = { ...current }; delete next[item.id]; return next; });
      onNotice(error instanceof Error ? error.message : "The work block could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const closeManualForm = () => {
    setManualOpen(false);
    setEditingBlockId("");
    setManualTitle("");
    setManualWorkItemId("");
    setManualMinutes(45);
    setManualTime(defaultBlockTime(selectedDay, now));
    manualRequestKey.current = "";
  };

  const openManualForm = (block?: LocalWorkBlock) => {
    setManualOpen(true);
    setManualWorkItemId("");
    if (block) {
      setEditingBlockId(block.id);
      setManualTitle(block.title);
      setManualTime(timeInputValue(new Date(block.startAt)));
      setManualMinutes(workBlockMinutes(block));
    } else {
      setEditingBlockId("");
      setManualTitle("");
      setManualTime(defaultBlockTime(selectedDay, now));
      setManualMinutes(45);
      manualRequestKey.current = globalThis.crypto?.randomUUID?.() || `calendar-${Date.now()}`;
    }
  };

  const saveManualBlock = async (block: LocalWorkBlock, start: Date, minutes: number, title = block.title) => {
    const nextMinutes = clamp(Math.round(minutes / 15) * 15, 15, 480);
    const optimistic = { ...block, title, startAt: start.toISOString(), endAt: new Date(start.getTime() + nextMinutes * 60_000).toISOString() };
    setWorkBlocks((current) => current.map((candidate) => candidate.id === block.id ? optimistic : candidate));
    setBusy(true);
    try {
      const response = await fetch(`${runnerUrl}/api/calendar/work-blocks/${encodeURIComponent(block.id)}`, {
        method: "PATCH",
        headers: requestHeaders,
        body: JSON.stringify({ title, startAt: optimistic.startAt, endAt: optimistic.endAt, expectedUpdatedAt: block.updatedAt }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The work block could not be saved.");
      setWorkBlocks((current) => current.map((candidate) => candidate.id === block.id ? data : candidate));
      onNotice(`Updated "${title}".`);
    } catch (error) {
      setWorkBlocks((current) => current.map((candidate) => candidate.id === block.id ? block : candidate));
      onNotice(error instanceof Error ? error.message : "The work block could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const submitManualBlock = async () => {
    if (minutesOfDay(manualStart) < dayStartMinutes || minutesOfDay(manualEnd) > dayEndMinutes || manualEnd.getDate() !== manualStart.getDate()) {
      onNotice("Keep the work block between 7:00 AM and 7:00 PM.");
      return;
    }
    if (selectedLinkedItem) {
      await plan(selectedLinkedItem, manualStart, manualMinutes);
      closeManualForm();
      return;
    }
    if (!manualTitle.trim()) return;
    setBusy(true);
    try {
      const endpoint = editingBlockId
        ? `${runnerUrl}/api/calendar/work-blocks/${encodeURIComponent(editingBlockId)}`
        : `${runnerUrl}/api/calendar/work-blocks`;
      const current = workBlocks.find((block) => block.id === editingBlockId);
      const response = await fetch(endpoint, {
        method: editingBlockId ? "PATCH" : "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          title: manualTitle.trim(),
          startAt: manualStart.toISOString(),
          endAt: manualEnd.toISOString(),
          expectedUpdatedAt: current?.updatedAt,
          requestKey: editingBlockId ? undefined : manualRequestKey.current || `calendar-${Date.now()}`,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The work block could not be saved.");
      setWorkBlocks((blocks) => editingBlockId ? blocks.map((block) => block.id === data.id ? data : block) : [...blocks, data].sort((left, right) => left.startAt.localeCompare(right.startAt)));
      onNotice(`${editingBlockId ? "Updated" : "Added"} "${data.title}" locally.`);
      closeManualForm();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "The work block could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const removeManualBlock = async (block: LocalWorkBlock) => {
    setWorkBlocks((current) => current.filter((candidate) => candidate.id !== block.id));
    setBusy(true);
    try {
      const response = await fetch(`${runnerUrl}/api/calendar/work-blocks/${encodeURIComponent(block.id)}`, { method: "DELETE", headers: requestHeaders });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The work block could not be removed.");
      setCalendarUndo({ kind: "manual", block });
      onNotice(`Removed "${block.title}".`);
    } catch (error) {
      setWorkBlocks((current) => [...current, block].sort((left, right) => left.startAt.localeCompare(right.startAt)));
      onNotice(error instanceof Error ? error.message : "The work block could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  const unplan = async (item: Action) => {
    if (!item.plannedAt) return;
    const previous = { plannedAt: item.plannedAt, plannedMinutes: item.plannedMinutes || estimate(item) };
    setPlanOverrides((current) => ({ ...current, [item.id]: { plannedAt: null, plannedMinutes: 0 } }));
    setBusy(true);
    try {
      const response = await fetch(`${runnerUrl}/api/work-items/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: requestHeaders,
        body: JSON.stringify({ plannedAt: null, plannedMinutes: 0, eventDetail: "Removed from the local calendar plan." }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The work block could not be removed.");
      setCalendarUndo({ kind: "action", item, ...previous });
      onNotice(`Removed "${item.title}" from the local plan.`);
      onUpdated();
    } catch (error) {
      setPlanOverrides((current) => ({ ...current, [item.id]: previous }));
      onNotice(error instanceof Error ? error.message : "The work block could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  const undoCalendarChange = async () => {
    const undo = calendarUndo;
    if (!undo) return;
    setCalendarUndo(null);
    if (undo.kind === "action") {
      await plan(undo.item, new Date(undo.plannedAt), undo.plannedMinutes);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${runnerUrl}/api/calendar/work-blocks/${encodeURIComponent(undo.block.id)}/restore`, { method: "POST", headers: requestHeaders, body: "{}" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The work block could not be restored.");
      setWorkBlocks((current) => [...current.filter((block) => block.id !== data.id), data].sort((left, right) => left.startAt.localeCompare(right.startAt)));
      onNotice(`Restored "${data.title}".`);
    } catch (error) {
      setCalendarUndo(undo);
      onNotice(error instanceof Error ? error.message : "The work block could not be restored.");
    } finally {
      setBusy(false);
    }
  };

  const dropOnTimeline = (clientY: number) => {
    if (!dragging || !timelineRef.current) return;
    const bounds = timelineRef.current.getBoundingClientRect();
    const rawMinute = dayStartMinutes + Math.round(((clientY - bounds.top) / pixelsPerMinute) / 15) * 15;
    const startMinute = clamp(rawMinute, dayStartMinutes, dayEndMinutes - dragging.minutes);
    if (dragging.kind === "action") void plan(dragging.item, startAtMinute(selectedDay, startMinute), dragging.minutes);
    else void saveManualBlock(dragging.block, startAtMinute(selectedDay, startMinute), dragging.minutes);
    setDragging(null); setDragOverTimeline(false);
  };

  const moveBy = (item: Action, minutes: number, delta: number) => {
    if (!item.plannedAt) return;
    const nextMinute = clamp(minutesOfDay(item.plannedAt) + delta, dayStartMinutes, dayEndMinutes - minutes);
    void plan(item, startAtMinute(selectedDay, nextMinute), minutes);
  };

  const moveManualBy = (block: LocalWorkBlock, minutes: number, delta: number) => {
    const nextMinute = clamp(minutesOfDay(block.startAt) + delta, dayStartMinutes, dayEndMinutes - minutes);
    void saveManualBlock(block, startAtMinute(selectedDay, nextMinute), minutes);
  };

  const beginResize = (item: Action, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    const initialY = event.clientY; const initialMinutes = item.plannedMinutes || estimate(item);
    const move = (pointer: PointerEvent) => {
      const minutes = clamp(Math.round((initialMinutes + (pointer.clientY - initialY) / pixelsPerMinute) / 15) * 15, 15, 240);
      setResizePreview({ id: item.id, minutes });
    };
    const finish = (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      const minutes = clamp(Math.round((initialMinutes + (pointer.clientY - initialY) / pixelsPerMinute) / 15) * 15, 15, 240);
      setResizePreview(null);
      if (item.plannedAt && minutes !== initialMinutes) void plan(item, new Date(item.plannedAt), minutes);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish);
  };

  const beginManualResize = (block: LocalWorkBlock, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    const initialY = event.clientY; const initialMinutes = workBlockMinutes(block);
    const move = (pointer: PointerEvent) => {
      const minutes = clamp(Math.round((initialMinutes + (pointer.clientY - initialY) / pixelsPerMinute) / 15) * 15, 15, 480);
      setResizePreview({ id: block.id, minutes });
    };
    const finish = (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      const minutes = clamp(Math.round((initialMinutes + (pointer.clientY - initialY) / pixelsPerMinute) / 15) * 15, 15, 480);
      setResizePreview(null);
      if (minutes !== initialMinutes) void saveManualBlock(block, new Date(block.startAt), minutes);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish);
  };

  const chooseDay = (day: Date) => {
    setSelectedDay(day);
    setManualOpen(false);
    setEditingBlockId("");
    setManualTitle("");
    setManualWorkItemId("");
    setManualMinutes(45);
    setManualTime(defaultBlockTime(day, now));
    manualRequestKey.current = "";
  };

  const hours = Array.from({ length: (dayEndMinutes - dayStartMinutes) / 60 + 1 }, (_, index) => dayStartMinutes / 60 + index);
  const days = [0, 1, 2, 3].map((offset) => addDays(dayStart(now), offset));
  const nowMinute = sameDay(now.toISOString(), selectedDay) ? minutesOfDay(now) : -1;

  return <section className="calendar-view calendar-timeline-view">
    <header className="calendar-heading">
      <div><p className="kicker">DAY AHEAD</p><h2>{selectedDay.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h2><p>Outlook meetings and local work blocks on one visual timeline.</p></div>
      <div className="calendar-heading-actions">
        <button className="primary-calendar-action" type="button" onClick={() => openManualForm()}>Add work block</button>
        <button disabled={busy} type="button" onClick={() => void refresh(true)}>{busy ? "Refreshing..." : "Refresh"}</button>
      </div>
    </header>
    <nav className="calendar-days" aria-label="Calendar days">{days.map((day, index) => <button className={dateKey(day) === dateKey(selectedDay) ? "active" : ""} key={dateKey(day)} type="button" onClick={() => chooseDay(day)}><span>{index === 0 ? "Today" : index === 1 ? "Tomorrow" : day.toLocaleDateString([], { weekday: "short" })}</span><strong>{day.getDate()}</strong></button>)}</nav>
    {receipt ? <div className={`calendar-coverage coverage-${receipt.status}`}><span>{receipt.status}</span><p>{receipt.error || receipt.detail}</p><time>{new Date(receipt.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div> : null}
    {manualOpen ? <form className="manual-work-block-form" onSubmit={(event) => { event.preventDefault(); void submitManualBlock(); }}>
      <div className="manual-work-block-heading">
        <div><span>{editingBlockId ? "EDIT WORK BLOCK" : "NEW WORK BLOCK"}</span><h3>{editingBlockId ? "Adjust your block" : "Block time your way"}</h3></div>
        <button type="button" onClick={closeManualForm} aria-label="Close work block form">×</button>
      </div>
      {!editingBlockId ? <label className="manual-work-item-link"><span>Use an Open Work card <small>Optional</small></span><select value={manualWorkItemId} onChange={(event) => { setManualWorkItemId(event.target.value); const item = linkableItems.find((candidate) => candidate.id === event.target.value); if (item) { setManualTitle(item.title); setManualMinutes((minutes) => Math.min(minutes, 240)); } }}><option value="">Standalone block</option>{linkableItems.map((item) => <option key={item.id} value={item.id}>{item.companyName} · {item.title}</option>)}</select></label> : null}
      <label className="manual-work-block-title"><span>Title</span><input autoFocus={!editingBlockId} disabled={Boolean(selectedLinkedItem)} maxLength={180} required={!selectedLinkedItem} value={selectedLinkedItem?.title || manualTitle} onChange={(event) => setManualTitle(event.target.value)} placeholder="What will you work on?" /></label>
      <label><span>Start</span><input type="time" min="07:00" max={timeInputValue(startAtMinute(selectedDay, dayEndMinutes - manualMinutes))} step={900} value={manualTime} onChange={(event) => setManualTime(event.target.value)} /></label>
      <label><span>Duration</span><select value={manualMinutes} onChange={(event) => setManualMinutes(Number(event.target.value))}>{[15, 30, 45, 60, 90, 120, 180, 240, 360, 480].filter((minutes) => !selectedLinkedItem || minutes <= 240).map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`}</option>)}</select></label>
      <div className="manual-work-block-actions">
        <p>{selectedLinkedItem ? "This schedules the existing Open Work card." : "Saved locally in Command Center. Outlook is not changed."}</p>
        <button type="button" onClick={closeManualForm}>Cancel</button>
        <button className="primary-calendar-action" disabled={busy || (!selectedLinkedItem && !manualTitle.trim())} type="submit">{busy ? "Saving..." : editingBlockId ? "Save changes" : "Add block"}</button>
      </div>
      {manualConflict ? <p className="manual-block-conflict" role="status"><strong>Time overlap:</strong> {manualConflict}. You can still save this block.</p> : null}
    </form> : null}
    {calendarUndo ? <div className="calendar-undo" role="status"><span>{calendarUndo.kind === "manual" ? `"${calendarUndo.block.title}" removed.` : `"${calendarUndo.item.title}" removed from the plan.`}</span><button disabled={busy} type="button" onClick={() => void undoCalendarChange()}>Undo</button></div> : null}
    {allDay.length ? <div className="all-day-row"><strong>All day</strong>{allDay.map((event) => <a href={event.webLink || undefined} target="_blank" rel="noreferrer" key={event.id}>{event.subject}</a>)}</div> : null}

    <div className="calendar-planner">
      <section className="timeline-panel" aria-label="Day timeline">
        <div className="timeline-panel-heading"><div><h3>Schedule</h3><span>{timed.length} meetings · {planned.length + workBlocks.length} work blocks</span></div><div className="calendar-legend"><span className="legend-outlook">Outlook meeting</span><span className="legend-local">Open Work</span><span className="legend-manual">Manual block</span></div></div>
        <div className="day-timeline-scroll">
          <div
            className={dragOverTimeline ? "day-timeline drop-ready" : "day-timeline"}
            ref={timelineRef}
            style={{ height: `${timelineHeight}px` }}
            onDragOver={(event) => { if (dragging) { event.preventDefault(); setDragOverTimeline(true); } }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverTimeline(false); }}
            onDrop={(event) => { event.preventDefault(); dropOnTimeline(event.clientY); }}
          >
            {hours.map((hour) => <div className="timeline-hour" key={hour} style={{ top: `${(hour * 60 - dayStartMinutes) * pixelsPerMinute}px` }}><time>{startAtMinute(selectedDay, hour * 60).toLocaleTimeString([], { hour: "numeric" })}</time><span /></div>)}
            {nowMinute >= dayStartMinutes && nowMinute <= dayEndMinutes ? <div className="current-time-line" style={{ top: `${(nowMinute - dayStartMinutes) * pixelsPerMinute}px` }}><span /></div> : null}
            {timedLayout.map(({ event, column, columns }) => { const position = blockPosition(event.startAt, event.endAt); const laneWidth = 55 / columns; const gutterShare = 18 / columns; return <article className="timeline-block outlook-event-block" key={event.id} style={{ top: `${position.top}px`, height: `${position.height}px`, left: `calc(10px + ${laneWidth * column}% - ${gutterShare * column}px)`, width: `calc(${laneWidth}% - ${gutterShare + 2}px)` }}><div><time>{time(event.startAt)}–{time(event.endAt)}</time><strong>{event.subject}</strong>{position.height > 52 ? <small>{event.organizer.name}{event.location ? ` · ${event.location}` : ""}</small> : null}</div>{event.webLink ? <a href={event.webLink} target="_blank" rel="noreferrer" aria-label={`Open ${event.subject} in Outlook`}>Open</a> : null}</article>; })}
            {planned.map((item) => { const minutes = resizePreview?.id === item.id ? resizePreview.minutes : item.plannedMinutes || estimate(item); const position = blockPosition(item.plannedAt!, undefined, minutes); return <article
              className={`timeline-block local-work-block priority-${item.priority}${dragging?.kind === "action" && dragging.item.id === item.id ? " dragging" : ""}`}
              draggable
              key={item.id}
              style={{ top: `${position.top}px`, height: `${position.height}px` }}
              onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setDragging({ kind: "action", item, minutes }); }}
              onDragEnd={() => { setDragging(null); setDragOverTimeline(false); }}
            ><div className="work-block-copy"><time>{time(item.plannedAt!)} · {minutes}m</time><strong>{item.title}</strong>{position.height > 54 ? <small>{item.companyName}</small> : null}</div><div className="work-block-controls"><button type="button" onClick={() => moveBy(item, minutes, -15)} aria-label={`Move ${item.title} 15 minutes earlier`}>↑</button><button type="button" onClick={() => moveBy(item, minutes, 15)} aria-label={`Move ${item.title} 15 minutes later`}>↓</button><button type="button" onClick={() => void unplan(item)} aria-label={`Remove ${item.title} from the calendar`}>×</button></div><button className="resize-handle" type="button" onPointerDown={(event) => beginResize(item, event)} onKeyDown={(event) => { if (!item.plannedAt || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); const delta = event.key === "ArrowUp" ? -15 : 15; void plan(item, new Date(item.plannedAt), clamp(minutes + delta, 15, 240)); }} aria-label={`Resize ${item.title}. Use up and down arrow keys for 15 minute increments.`}><span /></button></article>; })}
            {workBlocks.map((block) => { const minutes = resizePreview?.id === block.id ? resizePreview.minutes : workBlockMinutes(block); const position = blockPosition(block.startAt, undefined, minutes); return <article
              className={`timeline-block local-work-block manual-calendar-block${dragging?.kind === "manual" && dragging.block.id === block.id ? " dragging" : ""}`}
              draggable
              key={block.id}
              style={{ top: `${position.top}px`, height: `${position.height}px` }}
              onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); setDragging({ kind: "manual", block, minutes }); }}
              onDragEnd={() => { setDragging(null); setDragOverTimeline(false); }}
            ><div className="work-block-copy"><time>{time(block.startAt)} · {minutes}m</time><strong>{block.title}</strong>{position.height > 54 ? <small>Manual block</small> : null}</div><div className="work-block-controls"><button type="button" onClick={() => moveManualBy(block, minutes, -15)} aria-label={`Move ${block.title} 15 minutes earlier`}>↑</button><button type="button" onClick={() => moveManualBy(block, minutes, 15)} aria-label={`Move ${block.title} 15 minutes later`}>↓</button><button type="button" onClick={() => openManualForm(block)} aria-label={`Edit ${block.title}`}>✎</button><button type="button" onClick={() => void removeManualBlock(block)} aria-label={`Remove ${block.title} from the calendar`}>×</button></div><button className="resize-handle" type="button" onPointerDown={(event) => beginManualResize(block, event)} onKeyDown={(event) => { if (!["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); const delta = event.key === "ArrowUp" ? -15 : 15; void saveManualBlock(block, new Date(block.startAt), clamp(minutes + delta, 15, 480)); }} aria-label={`Resize ${block.title}. Use up and down arrow keys for 15 minute increments.`}><span /></button></article>; })}
            {dragOverTimeline ? <div className="timeline-drop-hint">Drop to schedule locally</div> : null}
          </div>
        </div>
      </section>

      <aside className="calendar-backlog" aria-label="Unscheduled work">
        <div className="calendar-section-title"><div><h3>Unscheduled work</h3><p>Drag a card onto the timeline.</p></div><span>{suggestions.length}</span></div>
        <div className="backlog-list">{suggestions.map(({ item, start, minutes }) => <article className={`backlog-card priority-${item.priority}`} draggable key={item.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setDragging({ kind: "action", item, minutes }); }} onDragEnd={() => { setDragging(null); setDragOverTimeline(false); }}><div><span>{item.companyName}</span><small>{minutes} min</small></div><h4>{item.title}</h4><p>{item.suggestedAction}</p>{start ? <button disabled={busy} type="button" onClick={() => void plan(item, start, minutes)}>Add to plan · {time(start.toISOString())}</button> : <small>No open block found. Drag it to choose a time.</small>}</article>)}</div>
        {!suggestions.length ? <div className="calendar-empty">Everything committed for this day is already planned.</div> : null}
      </aside>
    </div>
    <small className="calendar-boundary">Manual blocks and Open Work planning stay in Command Center. Outlook meetings remain fixed and read-only.</small>
  </section>;
}
