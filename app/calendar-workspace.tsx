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
type PlanOverride = { plannedAt: string; plannedMinutes: number };
type DragState = { item: Action; minutes: number } | null;
type LaidOutEvent = { event: CalendarEvent; column: number; columns: number };

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
  const [receipt, setReceipt] = useState<CalendarReceipt>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<DragState>(null);
  const [dragOverTimeline, setDragOverTimeline] = useState(false);
  const [planOverrides, setPlanOverrides] = useState<Record<string, PlanOverride>>({});
  const [resizePreview, setResizePreview] = useState<{ id: string; minutes: number } | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const start = dayStart(selectedDay); const end = addDays(start, 1);
    const response = await fetch(`${runnerUrl}/api/calendar?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`, { cache: "no-store", headers: { "X-Serent-Command-Center": "1" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Calendar could not load.");
    setEvents(data.events || []); setReceipt(data.receipt || null);
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

  const effectiveItems = useMemo(() => items.map((item) => planOverrides[item.id] ? { ...item, ...planOverrides[item.id] } : item), [items, planOverrides]);
  const timed = useMemo(() => events.filter((event) => !event.isAllDay).sort((a, b) => a.startAt.localeCompare(b.startAt)), [events]);
  const timedLayout = useMemo(() => layoutEvents(timed), [timed]);
  const allDay = useMemo(() => events.filter((event) => event.isAllDay), [events]);
  const dayActions = useMemo(() => effectiveItems.filter((item) => !["done", "dismissed", "queued", "working"].includes(item.status) && item.decisionState !== "proposed" && (sameDay(item.plannedAt, selectedDay) || (!item.plannedAt && (!item.dueAt || new Date(item.dueAt) <= addDays(selectedDay, 1))))), [effectiveItems, selectedDay]);
  const planned = useMemo(() => dayActions.filter((item) => sameDay(item.plannedAt, selectedDay)).sort((a, b) => String(a.plannedAt).localeCompare(String(b.plannedAt))), [dayActions, selectedDay]);
  const suggestions = useMemo(() => suggestBlocks(selectedDay, now, dayActions, events), [selectedDay, now, dayActions, events]);

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

  const dropOnTimeline = (clientY: number) => {
    if (!dragging || !timelineRef.current) return;
    const bounds = timelineRef.current.getBoundingClientRect();
    const rawMinute = dayStartMinutes + Math.round(((clientY - bounds.top) / pixelsPerMinute) / 15) * 15;
    const startMinute = clamp(rawMinute, dayStartMinutes, dayEndMinutes - dragging.minutes);
    void plan(dragging.item, startAtMinute(selectedDay, startMinute), dragging.minutes);
    setDragging(null); setDragOverTimeline(false);
  };

  const moveBy = (item: Action, minutes: number, delta: number) => {
    if (!item.plannedAt) return;
    const nextMinute = clamp(minutesOfDay(item.plannedAt) + delta, dayStartMinutes, dayEndMinutes - minutes);
    void plan(item, startAtMinute(selectedDay, nextMinute), minutes);
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

  const hours = Array.from({ length: (dayEndMinutes - dayStartMinutes) / 60 + 1 }, (_, index) => dayStartMinutes / 60 + index);
  const days = [0, 1, 2, 3].map((offset) => addDays(dayStart(now), offset));
  const nowMinute = sameDay(now.toISOString(), selectedDay) ? minutesOfDay(now) : -1;

  return <section className="calendar-view calendar-timeline-view">
    <header className="calendar-heading"><div><p className="kicker">DAY AHEAD</p><h2>{selectedDay.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h2><p>Outlook meetings and local work blocks on one visual timeline.</p></div><button disabled={busy} type="button" onClick={() => void refresh(true)}>{busy ? "Refreshing..." : "Refresh"}</button></header>
    <nav className="calendar-days" aria-label="Calendar days">{days.map((day, index) => <button className={dateKey(day) === dateKey(selectedDay) ? "active" : ""} key={dateKey(day)} type="button" onClick={() => setSelectedDay(day)}><span>{index === 0 ? "Today" : index === 1 ? "Tomorrow" : day.toLocaleDateString([], { weekday: "short" })}</span><strong>{day.getDate()}</strong></button>)}</nav>
    {receipt ? <div className={`calendar-coverage coverage-${receipt.status}`}><span>{receipt.status}</span><p>{receipt.error || receipt.detail}</p><time>{new Date(receipt.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div> : null}
    {allDay.length ? <div className="all-day-row"><strong>All day</strong>{allDay.map((event) => <a href={event.webLink || undefined} target="_blank" rel="noreferrer" key={event.id}>{event.subject}</a>)}</div> : null}

    <div className="calendar-planner">
      <section className="timeline-panel" aria-label="Day timeline">
        <div className="timeline-panel-heading"><div><h3>Schedule</h3><span>{timed.length} meetings · {planned.length} work blocks</span></div><div className="calendar-legend"><span className="legend-outlook">Outlook meeting</span><span className="legend-local">Local work block</span></div></div>
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
              className={`timeline-block local-work-block priority-${item.priority}${dragging?.item.id === item.id ? " dragging" : ""}`}
              draggable
              key={item.id}
              style={{ top: `${position.top}px`, height: `${position.height}px` }}
              onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setDragging({ item, minutes }); }}
              onDragEnd={() => { setDragging(null); setDragOverTimeline(false); }}
            ><div className="work-block-copy"><time>{time(item.plannedAt!)} · {minutes}m</time><strong>{item.title}</strong>{position.height > 54 ? <small>{item.companyName}</small> : null}</div><div className="work-block-controls"><button type="button" onClick={() => moveBy(item, minutes, -15)} aria-label={`Move ${item.title} 15 minutes earlier`}>↑</button><button type="button" onClick={() => moveBy(item, minutes, 15)} aria-label={`Move ${item.title} 15 minutes later`}>↓</button></div><button className="resize-handle" type="button" onPointerDown={(event) => beginResize(item, event)} onKeyDown={(event) => { if (!item.plannedAt || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); const delta = event.key === "ArrowUp" ? -15 : 15; void plan(item, new Date(item.plannedAt), clamp(minutes + delta, 15, 240)); }} aria-label={`Resize ${item.title}. Use up and down arrow keys for 15 minute increments.`}><span /></button></article>; })}
            {dragOverTimeline ? <div className="timeline-drop-hint">Drop to schedule locally</div> : null}
          </div>
        </div>
      </section>

      <aside className="calendar-backlog" aria-label="Unscheduled work">
        <div className="calendar-section-title"><div><h3>Unscheduled work</h3><p>Drag a card onto the timeline.</p></div><span>{suggestions.length}</span></div>
        <div className="backlog-list">{suggestions.map(({ item, start, minutes }) => <article className={`backlog-card priority-${item.priority}`} draggable key={item.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setDragging({ item, minutes }); }} onDragEnd={() => { setDragging(null); setDragOverTimeline(false); }}><div><span>{item.companyName}</span><small>{minutes} min</small></div><h4>{item.title}</h4><p>{item.suggestedAction}</p>{start ? <button disabled={busy} type="button" onClick={() => void plan(item, start, minutes)}>Add to plan · {time(start.toISOString())}</button> : <small>No open block found. Drag it to choose a time.</small>}</article>)}</div>
        {!suggestions.length ? <div className="calendar-empty">Everything committed for this day is already planned.</div> : null}
      </aside>
    </div>
    <small className="calendar-boundary">Outlook meetings are fixed and read-only. Dragging and resizing only changes local Command Center work blocks; it does not create or move Outlook events.</small>
  </section>;
}
