"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const runnerUrl = "http://127.0.0.1:4318";

type Company = { slug: string; displayName: string };
type Rule = { id: string; title: string; instruction: string; status: string; scopeType: string; scopeValue: string };
type Draft = { id: string; generatedBody: string; currentBody: string; status: string; skillId: string; sourceBasis: string; updatedAt: string };
type DraftRequest = { id: string; status: "requested" | "draft_ready" | "needs_attention"; requestedBy: string; error: string; provenance: string; sourceBasis: string; sourceFreshness: string; createdAt: string; updatedAt: string };
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
  actionWorkItemStatus: string | null;
  freshness: string;
  lastSyncedAt: string;
  draft: Draft | null;
  draftRequestState: "not_requested" | "requested" | "draft_ready" | "needs_attention";
  draftRequest: DraftRequest | null;
  activeRules: Rule[];
  notes: Note[];
};

type DraftRequestResponse = { reused: boolean; request: DraftRequest; mail: Mail; packet: { packetText: string } };
type DraftPacketResponse = { packetText: string };

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

export default function MailWorkspace({ companies, selectedMessageId, onNotice, onPromoted, onOpenWorkItem }: { companies: Company[]; selectedMessageId?: string; onNotice: (message: string) => void; onPromoted: () => void; onOpenWorkItem: (id: string) => void }) {
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
    const refreshTimer = window.setInterval(() => void refresh(false), 5 * 60_000);
    const pollTimer = window.setInterval(() => void loadList(true), 5_000);
    return () => { window.clearInterval(refreshTimer); window.clearInterval(pollTimer); };
  }, [loadList, refresh]);

  useEffect(() => {
    const closeFromHash = () => { if (window.location.hash === "#mail-list") setMobileDetailOpen(false); };
    window.addEventListener("hashchange", closeFromHash);
    return () => window.removeEventListener("hashchange", closeFromHash);
  }, []);

  const selectedDraftSignal = (() => { const selected = mail.items.find((item) => item.id === selectedId); return `${selected?.draftState || ""}:${selected?.draftRequestState || ""}`; })();

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
  }, [onNotice, selectedDraftSignal, selectedId]);

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
    if (!detail) return null;
    setBusy(true);
    try {
      const next = await api<Mail>(`/api/mail/${detail.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setDetail(next);
      await loadList(true);
      if (body.reviewState === "reviewed") onNotice(view === "needs_reply" ? "Reviewed. Removed from Needs reply and kept in All mail." : "Marked reviewed.");
      if (body.promote) onPromoted();
      return next;
    } catch (error) { onNotice(error instanceof Error ? error.message : "The mail update failed."); }
    finally { setBusy(false); }
    return null;
  };

  const requestDraft = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await api<DraftRequestResponse>(`/api/mail/${detail.id}/draft-request`, { method: "POST", body: "{}" });
      setDetail(result.mail);
      await loadList(true);
      onNotice(result.reused ? "The existing CEO / PM draft request is still recorded locally." : "CEO / PM draft request recorded locally. It has not been delivered automatically.");
    } catch (error) { onNotice(error instanceof Error ? error.message : "The draft request could not be recorded."); }
    finally { setBusy(false); }
  };

  const copyDraftRequest = async () => {
    if (!detail?.draftRequest) return;
    setBusy(true);
    try {
      const packet = await api<DraftPacketResponse>(`/api/mail-draft-requests/${detail.draftRequest.id}/packet`, { method: "POST", body: "{}" });
      await navigator.clipboard.writeText(packet.packetText);
      onNotice("Drafting request copied. Paste it into the persistent CEO / PM task; Command Center has not delivered it automatically.");
    } catch (error) { onNotice(error instanceof Error ? error.message : "The drafting request could not be copied."); }
    finally { setBusy(false); }
  };

  const promoteToOpenWork = async () => {
    if (!detail) return;
    const active = detail.actionWorkItemId && !["done", "dismissed"].includes(detail.actionWorkItemStatus || "");
    if (active) {
      onOpenWorkItem(detail.actionWorkItemId!);
      return;
    }
    const next = await patchMail({ promote: true, detail: "Jake explicitly promoted this email to Open Work." });
    if (next?.actionWorkItemId) onNotice("Added to Open Work. Drafting remains a separate CEO / PM request.");
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
            <section className="why-card mail-next-step"><span>Recommended next step</span><h3>{detail.replyState === "needs_reply" ? detail.draft ? "Review the local draft, then reply in Outlook" : detail.draftRequestState === "requested" ? "Copy the request to the CEO / PM, then review the returned draft" : "Request a CEO / PM draft or promote the obligation to Open Work" : detail.replyState === "responded" ? "Confirm this is handled" : "Review, then file or promote it"}</h3><p>{detail.replyReason}</p>{detail.activeRules.length ? <div className="rule-chips">{detail.activeRules.map((rule) => <span key={rule.id}>{rule.title}</span>)}</div> : <small>No accepted rule changed this recommendation.</small>}</section>
            <div className="mail-review-controls mail-review-controls-top"><select value={detail.companySlug || ""} onChange={(event) => void patchMail({ companySlug: event.target.value || null, detail: "Corrected the company assignment." })} aria-label="Company assignment"><option value="">Unfiled</option>{companies.map((company) => <option key={company.slug} value={company.slug}>{company.displayName}</option>)}</select><button disabled={busy || detail.reviewState === "reviewed"} type="button" onClick={() => void patchMail({ reviewState: "reviewed" })}>{detail.reviewState === "reviewed" ? "Reviewed" : "Mark reviewed"}</button><button disabled={busy} type="button" onClick={() => void patchMail({ snoozedUntil: tomorrowMorning(), detail: "Snoozed until tomorrow morning." })}>Snooze</button><button disabled={busy} type="button" onClick={() => void promoteToOpenWork()}>{detail.actionWorkItemId && !["done", "dismissed"].includes(detail.actionWorkItemStatus || "") ? "Open in Open Work" : detail.actionWorkItemId ? "Restore to Open Work" : "Promote to Open Work"}</button></div>
            <details className="workbench-section mail-draft-workspace" open>
              <summary>Proposed reply</summary>
              <div className="mail-draft-status-line" role="status"><span className={`mail-draft-state draft-state-${detail.draftRequestState}`}>{detail.draftRequestState === "not_requested" ? "Not requested" : detail.draftRequestState === "requested" ? "Requested" : detail.draftRequestState === "needs_attention" ? "Needs attention" : "Draft ready"}</span><small>{detail.draftRequest?.provenance ? `${detail.draftRequest.provenance} · ${detail.draftRequest.sourceFreshness || "Freshness not stated"}` : detail.draft ? "Existing local draft" : "Drafting requires the persistent CEO / PM intelligence layer."}</small></div>
              {detail.draftRequestState === "needs_attention" && detail.draftRequest?.error ? <p className="mail-draft-error">{detail.draftRequest.error}</p> : null}
              {detail.draft ? <>
                <textarea className="mail-draft-editor" value={draft} onChange={(event) => { setDraft(event.target.value); setDraftDirty(true); }} placeholder="Edit the proposed reply here." aria-label="Proposed reply draft" />
                <div className="mail-actions"><button type="button" disabled={!draft.trim()} onClick={() => void copyDraft()}>Copy reply</button><button type="button" disabled={busy || detail.draftRequestState === "requested"} onClick={() => void requestDraft()}>{detail.draftRequestState === "requested" ? "Revision requested" : "Request CEO revision"}</button>{detail.draftRequest ? <button className="secondary" type="button" disabled={busy} onClick={() => void copyDraftRequest()}>Copy drafting request</button> : null}{detail.webLink ? <a href={detail.webLink} target="_blank" rel="noreferrer">Open in Outlook</a> : null}</div>
                <small className="approval-copy">{draftDirty ? "Saving locally…" : "Saved locally"}. Command Center cannot create or send Outlook drafts.</small>
              </> : <div className="mail-draft-empty"><p>A browser click cannot invoke the native CEO / PM task because Codex exposes no host bridge. This records a local request only; it does not claim delivery or execution.</p><div className="mail-actions"><button className="primary-action" type="button" disabled={busy || detail.draftRequestState === "requested"} onClick={() => void requestDraft()}>{detail.draftRequestState === "requested" ? "CEO draft requested" : "Request CEO draft"}</button>{detail.draftRequest ? <button className="secondary" type="button" disabled={busy} onClick={() => void copyDraftRequest()}>Copy drafting request</button> : null}</div></div>}
            </details>
            <details className="workbench-section" open><summary>Incoming message</summary><div className="mail-body">{detail.body || detail.preview}</div>{detail.attachments.length ? <div className="attachment-list">{detail.attachments.map((item) => <span key={item.id}>{item.name} · {Math.max(1, Math.round(item.size / 1024))} KB</span>)}</div> : null}</details>
            <details className="workbench-section"><summary>Relevant context</summary>{detail.notes.length ? detail.notes.map((note) => <div className="context-note" key={note.id}><span>{note.origin === "manual" ? "Jake's note" : "Agent output"} · {note.type}</span><strong>{note.title}</strong><p>{note.body.slice(0, 400)}</p></div>) : <p className="muted-copy">No linked or company decision notes were included.</p>}</details>
          </>
        ) : <div className="workbench-placeholder"><p className="kicker">MAIL</p><h2>{selectedSummary ? "Opening message…" : "Select a message"}</h2><p>Incoming mail, recommendations, drafts, notes, and learning stay together here.</p></div>}
      </article>
    </section>
  );
}
