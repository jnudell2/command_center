"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const runnerUrl = "http://127.0.0.1:4318";

type Company = { slug: string; displayName: string };
type Rule = { id: string; title: string; instruction: string; status: string; scopeType: string; scopeValue: string };
type Draft = { id: string; generatedBody: string; currentBody: string; status: string; skillId: string; sourceBasis: string; updatedAt: string };
type Note = { id: string; title: string; body: string; type: string; origin: string };
type Mail = {
  id: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  recipients: Array<{ name: string; email: string }>;
  receivedAt: string;
  preview: string;
  body: string;
  webLink: string;
  isRead: boolean | null;
  attachments: Array<{ id: string; name: string; size: number; contentType: string }>;
  importance: string;
  companySlug: string | null;
  replyState: "needs_reply" | "responded" | "informational";
  replyConfidence: number;
  replyReason: string;
  reviewState: string;
  snoozedUntil: string | null;
  draftState: string;
  actionWorkItemId: string | null;
  freshness: string;
  lastSyncedAt: string;
  draft: Draft | null;
  activeRules: Rule[];
  notes: Note[];
};

type MailResponse = {
  items: Mail[];
  counts: Record<string, number>;
  receipt: { status: string; checkedAt: string; detail: string; error: string } | null;
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${runnerUrl}${path}`, {
    cache: "no-store",
    ...options,
    headers: { "X-Serent-Command-Center": "1", ...(options?.body ? { "Content-Type": "application/json" } : {}), ...(options?.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Command Center could not complete the mail request.");
  return payload as T;
}

function mailDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function tomorrowMorning() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

export default function MailWorkspace({ companies, selectedMessageId, onNotice, onPromoted }: { companies: Company[]; selectedMessageId?: string; onNotice: (message: string) => void; onPromoted: () => void }) {
  const [view, setView] = useState("needs_reply");
  const [mail, setMail] = useState<MailResponse>({ items: [], counts: {}, receipt: null });
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Mail | null>(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const loadedDraftId = useRef("");
  const draftSaveVersion = useRef(0);

  const loadList = useCallback(async (quiet = false) => {
    try {
      const query = new URLSearchParams({ view });
      if (appliedSearch) query.set("search", appliedSearch);
      const next = await api<MailResponse>(`/api/mail?${query.toString()}`);
      setMail(next);
      setSelectedId((current) => current && next.items.some((item) => item.id === current) ? current : next.items[0]?.id || "");
    } catch (error) {
      if (!quiet) onNotice(error instanceof Error ? error.message : "Mail could not be loaded.");
    }
  }, [appliedSearch, onNotice, view]);

  const refresh = useCallback(async (announce = false) => {
    try {
      await api("/api/mail/refresh", { method: "POST", body: "{}" });
      if (announce) onNotice("Mail is refreshing in the background.");
    } catch (error) {
      if (announce) onNotice(error instanceof Error ? error.message : "Mail refresh could not start.");
    }
  }, [onNotice]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), 0);
    return () => window.clearTimeout(timer);
  }, [loadList]);

  useEffect(() => {
    void refresh(false);
    const refreshTimer = window.setInterval(() => void refresh(false), 5 * 60_000);
    const pollTimer = window.setInterval(() => void loadList(true), 5_000);
    return () => { window.clearInterval(refreshTimer); window.clearInterval(pollTimer); };
  }, [loadList, refresh]);

  useEffect(() => {
    const closeFromHash = () => { if (window.location.hash === "#mail-list") setMobileDetailOpen(false); };
    window.addEventListener("hashchange", closeFromHash);
    return () => window.removeEventListener("hashchange", closeFromHash);
  }, []);

  const selectedDraftState = mail.items.find((item) => item.id === selectedId)?.draftState || "";

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    api<Mail>(`/api/mail/${encodeURIComponent(selectedId)}`).then((next) => {
      if (cancelled) return;
      setDetail(next);
      if (loadedDraftId.current !== next.draft?.id) {
        setDraft(next.draft?.currentBody || "");
        setDraftDirty(false);
        loadedDraftId.current = next.draft?.id || "";
      }
    }).catch((error) => onNotice(error instanceof Error ? error.message : "The message could not be opened."));
    return () => { cancelled = true; };
  }, [onNotice, selectedDraftState, selectedId]);

  const detailId = detail?.id || "";
  const detailDraftId = detail?.draft?.id || "";

  const saveDraftSnapshot = useCallback(async (mailId: string, body: string, version: number) => {
    const next = await api<Mail>(`/api/mail/${mailId}/draft`, { method: "PATCH", body: JSON.stringify({ body }) });
    setDetail((current) => current?.id === next.id ? next : current);
    if (version === draftSaveVersion.current) setDraftDirty(false);
    return next;
  }, []);

  useEffect(() => {
    if (!draftDirty || !detailId || !detailDraftId) return;
    const version = ++draftSaveVersion.current;
    const body = draft;
    const timer = window.setTimeout(async () => {
      try {
        await saveDraftSnapshot(detailId, body, version);
      } catch (error) { onNotice(error instanceof Error ? error.message : "Draft autosave failed."); }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [detailDraftId, detailId, draft, draftDirty, onNotice, saveDraftSnapshot]);

  const selectMessage = async (id: string) => {
    if (draftDirty && detailId && detailDraftId) {
      const version = ++draftSaveVersion.current;
      try { await saveDraftSnapshot(detailId, draft, version); }
      catch (error) { onNotice(error instanceof Error ? error.message : "The current draft could not be saved."); return; }
    }
    setSelectedId(id);
    setMobileDetailOpen(true);
  };

  useEffect(() => {
    if (!selectedMessageId) return;
    const timer = window.setTimeout(() => {
      setView("all");
      setAppliedSearch("");
      setSelectedId(selectedMessageId);
      setMobileDetailOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedMessageId]);

  const patchMail = async (body: Record<string, unknown>) => {
    if (!detail) return;
    setBusy(true);
    try {
      const next = await api<Mail>(`/api/mail/${detail.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setDetail(next);
      await loadList(true);
      if (body.reviewState === "reviewed") onNotice(view === "needs_reply" ? "Reviewed. Removed from Needs reply and kept in All mail." : "Marked reviewed.");
      if (body.promote) onPromoted();
    } catch (error) { onNotice(error instanceof Error ? error.message : "The mail update failed."); }
    finally { setBusy(false); }
  };

  const generateDraft = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/mail/${detail.id}/draft`, { method: "POST", body: "{}" });
      onNotice("The Executive Email Draft skill is working in the background.");
      await loadList(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : "The reply could not be queued."); }
    finally { setBusy(false); }
  };

  const copyDraft = async () => {
    if (!detail?.draft || !draft.trim()) return;
    if (draftDirty) {
      const version = ++draftSaveVersion.current;
      await saveDraftSnapshot(detail.id, draft, version);
    }
    await navigator.clipboard.writeText(draft);
    await api("/api/feedback-events", { method: "POST", body: JSON.stringify({ eventType: "draft_copied", mailMessageId: detail.id, companySlug: detail.companySlug, skillId: "draft-executive-email", detail: "Jake copied the reviewed reply for use in Outlook." }) });
    onNotice("Reply copied. Any material edits are waiting in Learning & Sources for your review.");
  };

  const tabs = [
    ["needs_reply", "Needs reply", mail.counts.needs_reply || 0],
    ["all", "All mail", mail.counts.all || 0],
    ["unread", "Unread", mail.counts.unread || 0],
    ["drafts", "Drafts", mail.counts.drafts || 0],
    ["snoozed", "Snoozed", mail.counts.snoozed || 0],
  ] as const;

  const selectedSummary = useMemo(() => mail.items.find((item) => item.id === selectedId), [mail.items, selectedId]);

  return (
    <section className="mail-shell" aria-label="Mail workspace">
      <div className="mail-list-pane" id="mail-list">
        <header className="mail-heading">
          <div><p className="kicker">MAIL</p><h2>What needs a reply</h2><p>Every incoming message stays visible. Command Center drafts only when you likely owe a response.</p></div>
          <button type="button" disabled={mail.receipt?.status === "working"} onClick={() => void refresh(true)}>{mail.receipt?.status === "working" ? "Refreshing…" : "Refresh"}</button>
        </header>
        <div className="mail-coverage"><span className={`source-state source-${mail.receipt?.status || "cached"}`}>{mail.receipt?.status || "cached"}</span><p>{mail.receipt?.error || mail.receipt?.detail || "Cached mail is ready."}</p></div>
        <div className="mail-tabs">{tabs.map(([id, label, count]) => <button className={view === id ? "active" : ""} key={id} type="button" onClick={() => setView(id)}>{label}<span>{count}</span></button>)}</div>
        <form className="mail-search" onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search.trim()); }}><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search active mail…" aria-label="Search mail" /><button type="submit">Search</button></form>
        <div className="mail-list">
          {mail.items.length ? mail.items.map((item) => (
            <button className={item.id === selectedId ? "mail-row active" : "mail-row"} data-company={item.companySlug || "unassigned"} type="button" key={item.id} onClick={() => void selectMessage(item.id)}>
              <div><span className={item.replyState === "needs_reply" ? "reply-dot needs" : "reply-dot"} /><strong>{item.senderName || item.senderEmail}</strong><time>{mailDate(item.receivedAt)}</time></div>
              <h3>{item.subject}</h3><p>{item.preview}</p>
              <footer><span className="mail-company">{item.companySlug ? companies.find((company) => company.slug === item.companySlug)?.displayName : "Unfiled"}</span><span>{item.draftState !== "none" ? `Draft ${item.draftState}` : item.replyState.replace("_", " ")}</span></footer>
            </button>
          )) : <div className="empty-message"><strong>No mail in this view</strong><p>Cached mail remains available while the next refresh runs.</p></div>}
        </div>
      </div>

      <article className={mobileDetailOpen ? "mail-workbench mobile-open" : "mail-workbench"} data-company={detail?.companySlug || "unassigned"}>
        {detail ? (
          <>
            <div className="mail-company-context company-badge">{detail.companySlug ? companies.find((company) => company.slug === detail.companySlug)?.displayName : "Unfiled"}</div>
            <a className="mobile-close" href="#mail-list" onClick={() => setMobileDetailOpen(false)}>← Back to mail</a>
            <header className="mail-message-header"><div><span className={`mail-reply-state state-${detail.replyState}`}>{detail.replyState.replace("_", " ")}</span><span>{Math.round(detail.replyConfidence * 100)}% confidence</span></div><p>From {detail.senderName || detail.senderEmail} &lt;{detail.senderEmail}&gt;</p><h2>{detail.subject}</h2><small>{new Date(detail.receivedAt).toLocaleString()} · {detail.freshness}</small></header>
            <section className="why-card mail-next-step"><span>Recommended next step</span><h3>{detail.replyState === "needs_reply" ? "Review the draft, then reply in Outlook" : detail.replyState === "responded" ? "Confirm this is handled" : "Review, then file or promote it"}</h3><p>{detail.replyReason}</p>{detail.activeRules.length ? <div className="rule-chips">{detail.activeRules.map((rule) => <span key={rule.id}>{rule.title}</span>)}</div> : <small>No accepted rule changed this recommendation.</small>}</section>
            <div className="mail-review-controls mail-review-controls-top"><select value={detail.companySlug || ""} onChange={(event) => void patchMail({ companySlug: event.target.value || null, detail: "Corrected the company assignment." })} aria-label="Company assignment"><option value="">Unfiled</option>{companies.map((company) => <option key={company.slug} value={company.slug}>{company.displayName}</option>)}</select><button disabled={busy || detail.reviewState === "reviewed"} type="button" onClick={() => void patchMail({ reviewState: "reviewed" })}>{detail.reviewState === "reviewed" ? "Reviewed" : "Mark reviewed"}</button><button disabled={busy} type="button" onClick={() => void patchMail({ snoozedUntil: tomorrowMorning(), detail: "Snoozed until tomorrow morning." })}>Snooze</button><button disabled={busy || Boolean(detail.actionWorkItemId)} type="button" onClick={() => void patchMail({ promote: true, detail: "Promoted mail to the action inbox." })}>{detail.actionWorkItemId ? "In action inbox" : "Promote to action"}</button></div>
            <details className="workbench-section" open><summary>Proposed reply</summary><div className="skill-route-line"><span>Using</span><strong>Executive Email Draft</strong><small>draft-executive-email</small></div>{detail.draft ? <><textarea className="mail-draft-editor" value={draft} onChange={(event) => { setDraft(event.target.value); setDraftDirty(true); }} placeholder={detail.draft.status === "queued" || detail.draft.status === "working" ? "Codex is drafting…" : "Edit the proposed reply here."} /><div className="mail-actions"><button type="button" disabled={!draft.trim()} onClick={() => void copyDraft()}>Copy reply</button><button type="button" disabled={busy} onClick={() => void generateDraft()}>Regenerate</button>{detail.webLink ? <a href={detail.webLink} target="_blank" rel="noreferrer">Open in Outlook</a> : null}</div><small className="approval-copy">{draftDirty ? "Saving locally…" : "Saved locally"}. Command Center cannot create or send Outlook drafts.</small></> : <button className="primary-action" type="button" disabled={busy} onClick={() => void generateDraft()}>{detail.draftState === "queued" ? "Drafting…" : "Draft proposed reply"}</button>}</details>
            <details className="workbench-section" open><summary>Incoming message</summary><div className="mail-body">{detail.body || detail.preview}</div>{detail.attachments.length ? <div className="attachment-list">{detail.attachments.map((item) => <span key={item.id}>{item.name} · {Math.max(1, Math.round(item.size / 1024))} KB</span>)}</div> : null}</details>
            <details className="workbench-section"><summary>Relevant context</summary>{detail.notes.length ? detail.notes.map((note) => <div className="context-note" key={note.id}><span>{note.origin === "manual" ? "Jake's note" : "Agent output"} · {note.type}</span><strong>{note.title}</strong><p>{note.body.slice(0, 400)}</p></div>) : <p className="muted-copy">No linked or company decision notes were included.</p>}</details>
          </>
        ) : <div className="workbench-placeholder"><p className="kicker">MAIL</p><h2>{selectedSummary ? "Opening message…" : "Select a message"}</h2><p>Incoming mail, recommendations, drafts, notes, and learning stay together here.</p></div>}
      </article>
    </section>
  );
}
