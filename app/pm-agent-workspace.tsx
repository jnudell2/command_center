"use client";

import { useEffect, useMemo, useState } from "react";

const runnerUrl = "http://127.0.0.1:4318";

type PmObservation = {
  threadId: string;
  title: string;
  preview: string;
  status: string;
  companySlug: string | null;
  companyName: string;
  linkedWorkItemId: string | null;
  linkedWorkItemTitle: string;
  matchType: string;
  confidence: number;
  rationale: string;
  updatedAt: string;
};

type PmRecommendation = {
  id: string;
  action: "link" | "monitor" | "review" | "dispatch" | "needs_jake" | "wait";
  workItemId: string | null;
  workItemTitle: string;
  threadId: string | null;
  threadTitle: string;
  companySlug: string | null;
  companyName: string;
  rationale: string;
  status: string;
};

type PmPayload = {
  config: {
    mode: string;
    enabled: boolean;
    morningTime: string;
    pulseMinutes: number;
    maxConcurrent: number;
    lastRunAt: string;
    lastMorningDate: string;
    chatThreadId: string;
    chatStatus: string;
    chatUpdatedAt: string;
    chatError: string;
  };
  latestRun: null | { id: string; kind: string; status: string; summary: string; error: string; startedAt: string; finishedAt: string };
  summary: { underway: number; likelyMatches: number; wouldDispatch: number; autoStarted: number; needsJake: number; waiting: number };
  observations: PmObservation[];
  recommendations: PmRecommendation[];
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${runnerUrl}${path}`, {
    ...options,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-serent-command-center": "1", ...(options?.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "The PM agent request failed.");
  return payload;
}

function relativeTime(value: string) {
  if (!value) return "Unknown";
  const elapsed = Date.now() - Date.parse(value);
  const minutes = Math.max(0, Math.round(elapsed / 60000));
  if (minutes < 2) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const actionLabels = {
  link: "Confirm link",
  monitor: "Already underway",
  review: "Review existing work",
  dispatch: "Ready to prepare",
  needs_jake: "Needs Jake",
  wait: "Waiting",
};

function threadStatusLabel(status: string) {
  if (["active", "inProgress", "in_progress", "working", "running"].includes(status)) return "Working now";
  if (status === "completed") return "Completed";
  if (status === "interrupted") return "Interrupted";
  if (["failed", "cancelled", "error"].includes(status)) return "Needs attention";
  return "Not running";
}

export default function PmAgentWorkspace({ onNotice, onOpenWorkItem }: { onNotice: (message: string) => void; onOpenWorkItem: (id: string) => void }) {
  const [data, setData] = useState<PmPayload | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const initialLoad = async () => {
      try {
        const next = await api<PmPayload>("/api/pm-agent");
        if (!cancelled) setData(next);
      } catch (error) {
        if (!cancelled) onNotice(error instanceof Error ? error.message : "The PM agent is unavailable.");
      }
    };
    void initialLoad();
    return () => { cancelled = true; };
  }, [onNotice]);

  const run = async () => {
    setBusy(true);
    try {
      const next = await api<PmPayload>("/api/pm-agent/run", { method: "POST", body: JSON.stringify({ kind: "manual" }) });
      setData(next);
      onNotice(`PM check complete: ${next.summary.autoStarted} new preparation task${next.summary.autoStarted === 1 ? "" : "s"} started, ${next.summary.underway} already linked or underway.`);
    } catch (error) { onNotice(error instanceof Error ? error.message : "The PM check failed."); }
    finally { setBusy(false); }
  };

  const openPmChat = async () => {
    setBusy(true);
    try {
      const next = await api<PmPayload>("/api/pm-agent/chat/open", { method: "POST", body: "{}" });
      setData(next);
      onNotice(next.config.chatThreadId ? "Opened the continuing PM Agent chat in Codex." : "The PM Agent chat is still being created.");
    } catch (error) { onNotice(error instanceof Error ? error.message : "The PM Agent chat could not be opened."); }
    finally { setBusy(false); }
  };

  const confirmLink = async (recommendation: PmRecommendation) => {
    if (!recommendation.threadId || !recommendation.workItemId) return;
    setBusy(true);
    try {
      const next = await api<PmPayload>("/api/pm-agent/links", { method: "POST", body: JSON.stringify({ threadId: recommendation.threadId, workItemId: recommendation.workItemId, title: recommendation.threadTitle }) });
      setData(next);
      onNotice("Task linked. Future PM checks will continue this task instead of proposing duplicate work.");
    } catch (error) { onNotice(error instanceof Error ? error.message : "The link could not be saved."); }
    finally { setBusy(false); }
  };

  const openThread = async (threadId: string) => {
    try { await api(`/api/pm-agent/threads/${encodeURIComponent(threadId)}/open`, { method: "POST", body: "{}" }); }
    catch (error) { onNotice(error instanceof Error ? error.message : "The Codex task could not be opened."); }
  };

  const groups = useMemo(() => {
    const recommendations = data?.recommendations || [];
    return [
      { id: "link", title: "Connections to confirm", help: "Likely matches between open Codex tasks and Command Center cards.", items: recommendations.filter((item) => item.action === "link") },
      { id: "dispatch", title: "Ready to delegate", help: "Safe drafting and analysis work can move to a native Codex task when Jake or the company PM opens the handoff.", items: recommendations.filter((item) => item.action === "dispatch") },
      { id: "review", title: "Needs your attention", help: "Results, proposed work, and decisions that should come back to you.", items: recommendations.filter((item) => ["review", "needs_jake"].includes(item.action)) },
      { id: "wait", title: "Waiting", help: "External dependencies the PM agent should monitor without creating work.", items: recommendations.filter((item) => item.action === "wait") },
    ];
  }, [data]);

  if (!data) return <section className="pm-workspace"><div className="pm-loading">Reading Command Center receipts and project state...</div></section>;

  return (
    <section className="pm-workspace">
      <header className="pm-hero">
        <div><p className="kicker">CEO + PM AGENT</p><h2>Your orchestration partner</h2><p>Protects the critical path, reads native-task receipts for overlap and new evidence, and brings delegation and decisions back to you.</p></div>
        <div className="pm-hero-actions">
          <button type="button" disabled={busy} onClick={() => void openPmChat()}>{data.config.chatThreadId ? "Open PM conversation in Codex" : "Create PM conversation"}</button>
          <button type="button" disabled={busy} onClick={() => void run()}>{busy ? "Working..." : "Run PM check"}</button>
        </div>
      </header>

      <div className="pm-mode-bar">
        <div><span className="pm-mode-dot" /><strong>Control-plane observer</strong><span>Prioritizes and prepares handoffs. Native Codex tasks own execution; external actions remain review-gated.</span></div>
        <div><span>Persistent conversation</span><strong>{data.config.chatStatus.replaceAll("_", " ")}</strong><span>Deep plan</span><strong>{data.config.morningTime} every morning</strong><span>Pulse</span><strong>every {data.config.pulseMinutes} minutes</strong></div>
      </div>
      {data.config.chatError ? <p className="pm-chat-error">PM chat needs attention: {data.config.chatError}</p> : null}

      <div className="pm-summary-grid">
        <article><span>Actually running</span><strong>{data.summary.underway}</strong><small>Codex turns active right now</small></article>
        <article><span>Matches to confirm</span><strong>{data.summary.likelyMatches}</strong><small>Prevents duplicate assignments</small></article>
        <article><span>Started automatically</span><strong>{data.summary.autoStarted}</strong><small>{data.summary.wouldDispatch ? `${data.summary.wouldDispatch} ready to delegate` : "Native results return by callback"}</small></article>
        <article><span>Needs Jake</span><strong>{data.summary.needsJake}</strong><small>Review, accept, edit, or decide</small></article>
        <article><span>Waiting</span><strong>{data.summary.waiting}</strong><small>Monitor external dependencies</small></article>
      </div>

      <section className="pm-section">
        <div className="pm-section-heading"><div><p className="kicker">RECENT CODEX RADAR</p><h3>What is happening across your recent tasks</h3></div><small>{data.latestRun ? `${data.latestRun.kind} check ${relativeTime(data.latestRun.finishedAt || data.latestRun.startedAt)}` : "Not checked yet"}</small></div>
        <div className="pm-thread-list">
          {data.observations.length ? data.observations.map((thread) => (
            <article className="pm-thread" data-company={thread.companySlug || "unassigned"} key={thread.threadId}>
              <span className="pm-company-line"><i />{thread.companyName || "Unassigned"}</span>
              <div className="pm-thread-main"><div><h4>{thread.title}</h4><p>{thread.linkedWorkItemTitle || thread.rationale}</p></div><span className={`pm-thread-status status-${thread.status}`}>{threadStatusLabel(thread.status)}</span></div>
              <div className="pm-thread-footer"><span>{thread.matchType === "likely" ? `${Math.round(thread.confidence * 100)}% likely match` : thread.matchType.replaceAll("_", " ")}</span><span>Updated {relativeTime(thread.updatedAt)}</span><button type="button" onClick={() => void openThread(thread.threadId)}>Open in Codex</button></div>
            </article>
          )) : <div className="pm-empty">No recent Codex tasks were available.</div>}
        </div>
      </section>

      <section className="pm-section">
        <div className="pm-section-heading"><div><p className="kicker">ORCHESTRATION QUEUE</p><h3>What the PM agent recommends next</h3></div></div>
        <div className="pm-recommendation-grid">
          {groups.map((group) => (
            <section className={`pm-lane lane-${group.id}`} key={group.id}>
              <header><div><h4>{group.title}</h4><p>{group.help}</p></div><span>{group.items.length}</span></header>
              <div>{group.items.length ? group.items.slice(0, 8).map((item) => (
                <article className="pm-recommendation" data-company={item.companySlug || "unassigned"} key={item.id}>
                  <div><span className="pm-company-line"><i />{item.companyName || "Unassigned"}</span><span>{item.action === "dispatch" && item.status === "executed" ? "Started automatically" : item.action === "dispatch" && item.status === "linked" ? "Existing task linked" : actionLabels[item.action]}</span></div>
                  <h5>{item.workItemTitle || item.threadTitle}</h5>
                  <p>{item.rationale}</p>
                  <footer>
                    {item.workItemId ? <button type="button" onClick={() => onOpenWorkItem(item.workItemId!)}>Open card</button> : null}
                    {item.action === "link" ? <button className="primary" type="button" disabled={busy} onClick={() => void confirmLink(item)}>Confirm link</button> : null}
                    {item.threadId ? <button type="button" onClick={() => void openThread(item.threadId!)}>Open task</button> : null}
                  </footer>
                </article>
              )) : <p className="pm-lane-empty">Nothing here right now.</p>}</div>
            </section>
          ))}
        </div>
      </section>
    </section>
  );
}
