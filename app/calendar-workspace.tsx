"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const runnerUrl = "http://127.0.0.1:4318";
const requestHeaders = { "Content-Type": "application/json", "X-Serent-Command-Center": "1" };

type CalendarEvent = { id: string; subject: string; startAt: string; endAt: string; isAllDay: boolean; organizer: { name: string; email: string }; attendees: Array<{ name?: string; email?: string }>; location: string; webLink: string; freshness: string; lastSyncedAt: string };
type CalendarReceipt = { status: string; checkedAt: string; detail: string; error: string } | null;
type Action = { id: string; title: string; type: string; companyName: string; priority: string; status: string; decisionState: string; dueAt: string | null; plannedAt: string | null; plannedMinutes: number; suggestedAction: string };

function dayStart(date: Date) { const next = new Date(date); next.setHours(0, 0, 0, 0); return next; }
function addDays(date: Date, days: number) { const next = new Date(date); next.setDate(next.getDate() + days); return next; }
function sameDay(value: string | null, day: Date) { if (!value) return false; const date = new Date(value); return date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate(); }
function time(value: string) { return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function dateKey(day: Date) { return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`; }
function estimate(action: Action) { const text = `${action.type} ${action.title}`.toLowerCase(); if (/deck|presentation|model|artifact/.test(text)) return 90; if (/meeting_prep|prepare|agenda/.test(text)) return 45; if (/email|reply|follow.?up|outreach/.test(text)) return 30; if (/schedul/.test(text)) return 20; return 45; }
function roundQuarter(date: Date) { const next = new Date(date); next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15, 0, 0); return next; }

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

  const load = useCallback(async () => {
    const start = dayStart(selectedDay);
    const end = addDays(start, 1);
    const response = await fetch(`${runnerUrl}/api/calendar?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`, { cache: "no-store", headers: { "X-Serent-Command-Center": "1" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Calendar could not load.");
    setEvents(data.events || []);
    setReceipt(data.receipt || null);
    return data;
  }, [selectedDay]);

  const refresh = useCallback(async (announce = false) => {
    setBusy(true);
    try {
      await fetch(`${runnerUrl}/api/calendar/refresh`, { method: "POST", headers: requestHeaders, body: "{}" });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        const data = await load();
        if (data.receipt?.status !== "working") break;
      }
      if (announce) onNotice("Calendar refreshed.");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Calendar could not refresh.");
    } finally {
      setBusy(false);
    }
  }, [load, onNotice]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error) => onNotice(error instanceof Error ? error.message : "Calendar could not load.")), 0);
    return () => window.clearTimeout(timer);
  }, [load, onNotice]);
  useEffect(() => { void fetch(`${runnerUrl}/api/calendar/refresh`, { method: "POST", headers: requestHeaders, body: "{}" }); }, []);

  const timed = useMemo(() => events.filter((event) => !event.isAllDay).sort((a, b) => a.startAt.localeCompare(b.startAt)), [events]);
  const allDay = useMemo(() => events.filter((event) => event.isAllDay), [events]);
  const dayActions = useMemo(() => items.filter((item) => !["done", "dismissed", "queued", "working"].includes(item.status) && item.decisionState !== "proposed" && (sameDay(item.plannedAt, selectedDay) || (!item.plannedAt && (!item.dueAt || new Date(item.dueAt) <= addDays(selectedDay, 1))))), [items, selectedDay]);
  const planned = useMemo(() => dayActions.filter((item) => sameDay(item.plannedAt, selectedDay)).sort((a, b) => String(a.plannedAt).localeCompare(String(b.plannedAt))), [dayActions, selectedDay]);
  const suggestions = useMemo(() => suggestBlocks(selectedDay, now, dayActions, events), [selectedDay, now, dayActions, events]);

  const plan = async (item: Action, start: Date, minutes: number) => {
    setBusy(true);
    try {
      const response = await fetch(`${runnerUrl}/api/work-items/${encodeURIComponent(item.id)}`, { method: "PATCH", headers: requestHeaders, body: JSON.stringify({ plannedAt: start.toISOString(), plannedMinutes: minutes, eventDetail: `Planned for ${start.toLocaleString()}.` }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The work block could not be saved.");
      onNotice(`Planned “${item.title}” for ${time(start.toISOString())}.`);
      onUpdated();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "The work block could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const days = [0, 1, 2, 3].map((offset) => addDays(dayStart(now), offset));
  return <section className="calendar-view">
    <header className="calendar-heading"><div><p className="kicker">DAY AHEAD</p><h2>{selectedDay.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h2><p>Meetings from Outlook, with local work-block suggestions around them.</p></div><button disabled={busy} type="button" onClick={() => void refresh(true)}>{busy ? "Refreshing..." : "Refresh"}</button></header>
    <nav className="calendar-days" aria-label="Calendar days">{days.map((day, index) => <button className={dateKey(day) === dateKey(selectedDay) ? "active" : ""} key={dateKey(day)} type="button" onClick={() => setSelectedDay(day)}><span>{index === 0 ? "Today" : index === 1 ? "Tomorrow" : day.toLocaleDateString([], { weekday: "short" })}</span><strong>{day.getDate()}</strong></button>)}</nav>
    {receipt ? <div className={`calendar-coverage coverage-${receipt.status}`}><span>{receipt.status}</span><p>{receipt.error || receipt.detail}</p><time>{new Date(receipt.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div> : null}
    {allDay.length ? <div className="all-day-row"><strong>All day</strong>{allDay.map((event) => <a href={event.webLink || undefined} target="_blank" rel="noreferrer" key={event.id}>{event.subject}</a>)}</div> : null}
    <div className="calendar-columns">
      <section><div className="calendar-section-title"><h3>Meetings</h3><span>{timed.length}</span></div>{timed.length ? timed.map((event) => <article className="calendar-event" key={event.id}><time>{time(event.startAt)}–{time(event.endAt)}</time><div><h4>{event.subject}</h4><p>{event.organizer.name}{event.location ? ` · ${event.location}` : ""}</p></div>{event.webLink ? <a href={event.webLink} target="_blank" rel="noreferrer">Outlook</a> : null}</article>) : <div className="calendar-empty">No timed meetings.</div>}</section>
      <section><div className="calendar-section-title"><h3>Work blocks</h3><span>{planned.length + suggestions.filter((item) => item.start).length}</span></div>{planned.map((item) => <article className="planned-block" key={item.id}><time>{time(item.plannedAt!)}</time><div><h4>{item.title}</h4><p>{item.companyName} · {item.plannedMinutes || estimate(item)} minutes</p></div><span>Planned</span></article>)}{suggestions.map(({ item, start, minutes }) => <article className="suggested-block" key={item.id}><time>{start ? time(start.toISOString()) : "Unslotted"}</time><div><h4>{item.title}</h4><p>{item.companyName} · {minutes} minutes</p></div>{start ? <button disabled={busy} type="button" onClick={() => void plan(item, start, minutes)}>Add to plan</button> : <span>No open block</span>}</article>)}{!planned.length && !suggestions.length ? <div className="calendar-empty">No committed actions need a block on this day.</div> : null}</section>
    </div>
    <small className="calendar-boundary">Planning stays local to Command Center. It does not create or move Outlook events.</small>
  </section>;
}
