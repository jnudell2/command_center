"use client";

import { useEffect, useMemo, useState } from "react";

type ProjectPlanItem = {
  id: string;
  phaseId: string | null;
  phaseTitle: string;
  workstream: string;
  title: string;
  description: string;
  owner: string;
  startDate: string | null;
  dueDate: string | null;
  status: "planned" | "active" | "blocked" | "complete";
  suggestedAction: string;
  whyNow: string;
  priority: string;
  workItemId: string | null;
  workItemStatus: string | null;
  workItemDecision: string | null;
  followUpWorkItemId: string | null;
  executionState: "do_now" | "waiting" | "up_next" | "complete" | "plan_only";
  executionReason: string;
  ownerState: "jake" | "codex" | "external";
  blockedBy: Array<{ id: string; title: string }>;
  daysUntilDue: number | null;
  guidanceKind?: "follow_up";
};

type Project = {
  id: string;
  companySlug: string;
  companyName: string;
  title: string;
  objective: string;
  status: string;
  startDate: string;
  targetDate: string;
  source: { provider: string; id: string; label: string; url: string };
  approvedAt: string;
  health: { status: "at_risk" | "on_track" | "complete"; label: string; reason: string };
  activePhase: { id: string; title: string; summary: string; startDate: string; endDate: string; status: string } | null;
  nextMilestone: { id: string; title: string; scheduledDate: string; decision: string; status: string } | null;
  phases: Array<{ id: string; title: string; summary: string; startDate: string; endDate: string; status: string }>;
  milestones: Array<{ id: string; title: string; scheduledDate: string; decision: string; status: string }>;
  planItems: ProjectPlanItem[];
  stayAhead: ProjectPlanItem[];
  guidance: { doNow: ProjectPlanItem[]; waiting: ProjectPlanItem[]; upNext: ProjectPlanItem[] };
  progress: { completed: number; total: number; percent: number };
};

const runnerUrl = "http://127.0.0.1:4318";

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
  if (!response.ok) throw new Error(payload.error || "The project plan could not be loaded.");
  return payload as T;
}

function planDate(value: string | null) {
  if (!value) return "No date";
  return new Date(`${value}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
}

function executionLabel(item: ProjectPlanItem) {
  if (item.executionState === "do_now") return "Do now";
  if (item.executionState === "waiting") return "Waiting";
  if (item.executionState === "up_next") return "Up next";
  if (item.executionState === "complete") return "Complete";
  return "Plan only";
}

export default function ProjectWorkspace({
  companyFilter,
  onNotice,
  onOpenWorkItem,
  onUpdated,
}: {
  companyFilter: string;
  onNotice: (message: string) => void;
  onOpenWorkItem: (id: string) => void;
  onUpdated: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    let cancelled = false;
    void api<Project[]>("/api/projects").then((next) => {
      if (!cancelled) setProjects(next);
    }).catch((error) => {
      if (!cancelled) onNotice(error instanceof Error ? error.message : "The project plan could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [onNotice]);

  const companyProject = companyFilter !== "all" ? projects.find((project) => project.companySlug === companyFilter) : null;
  const selected = projects.find((project) => project.id === selectedId) || companyProject || projects[0] || null;
  const workstreams = useMemo(() => {
    if (!selected) return [];
    const groups = new Map<string, ProjectPlanItem[]>();
    for (const item of selected.planItems) groups.set(item.workstream, [...(groups.get(item.workstream) || []), item]);
    return [...groups.entries()];
  }, [selected]);

  const updatePlanItem = async (item: ProjectPlanItem, status: ProjectPlanItem["status"]) => {
    setBusyId(item.id);
    try {
      const updated = await api<Project>(`/api/project-plan-items/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      onNotice(status === "complete" ? "Completed in Command Center. Its linked action was closed too." : `Plan item moved to ${status}.`);
      onUpdated();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "The project-plan item could not be updated.");
    } finally {
      setBusyId("");
    }
  };

  if (!selected) {
    return <section className="project-workspace"><div className="empty-message"><strong>No project plans yet.</strong><p>Approved company workplans will appear here.</p></div></section>;
  }

  return (
    <section className="project-workspace">
      <aside className="project-navigator" aria-label="Project plans">
        <div className="view-heading compact"><p className="kicker">PROJECTS</p><h2>Stay ahead</h2><p>Your approved plans and the work needed to keep them moving.</p></div>
        <div className="project-list">
          {projects.map((project) => <button type="button" key={project.id} data-company={project.companySlug} className={project.id === selected.id ? "project-nav-card active" : "project-nav-card"} onClick={() => setSelectedId(project.id)}>
            <span>{project.companyName}</span><strong>{project.title}</strong><small className={`project-health project-health-${project.health.status}`}>{project.health.label}</small>
          </button>)}
        </div>
        <p className="project-source-note">Command Center is the execution source of truth. Box remains the approved project evidence and baseline.</p>
      </aside>

      <article className="project-detail" data-company={selected.companySlug}>
        <header className="project-hero">
          <div className="project-hero-meta"><span className="company-badge">{selected.companyName}</span><span className={`project-health project-health-${selected.health.status}`}>{selected.health.label}</span></div>
          <h2>{selected.title}</h2>
          <p>{selected.objective}</p>
          <div className="project-source-row"><span>Baseline approved from {selected.source.label}</span><a href={selected.source.url} target="_blank" rel="noreferrer">Open in Box</a></div>
        </header>

        <section className="project-status-grid" aria-label="Project status">
          <div><span>Current phase</span><strong>{selected.activePhase?.title || "No active phase"}</strong><small>{selected.activePhase?.summary}</small></div>
          <div><span>Next decision</span><strong>{selected.nextMilestone?.title || "Plan complete"}</strong><small>{selected.nextMilestone ? `${planDate(selected.nextMilestone.scheduledDate)} · ${selected.nextMilestone.decision}` : "All milestones complete"}</small></div>
          <div><span>Project health</span><strong>{selected.health.label}</strong><small>{selected.health.reason}</small></div>
          <div><span>Plan progress</span><strong>{selected.progress.percent}%</strong><small>{selected.progress.completed} of {selected.progress.total} plan items complete</small></div>
        </section>

        <section className="execution-panel">
          <div className="project-section-heading"><div><p className="kicker">EXECUTION GUIDANCE</p><h3>Keep the project moving</h3><p className="section-explainer">The engine works backward from the plan, tracks dependencies, and keeps the next concrete move visible.</p></div><span>{selected.guidance.doNow.length} to move now</span></div>
          <div className="execution-lanes">
            <section className="execution-lane execution-now" aria-label="Do now">
              <header><div><span className="execution-dot" />Do now</div><small>{selected.guidance.doNow.length}</small></header>
              {selected.guidance.doNow.length ? selected.guidance.doNow.map((item) => <article key={`${item.id}-${item.guidanceKind || "action"}`} className="execution-card">
                <div className="execution-card-meta"><span>{item.workstream}</span><time>{planDate(item.dueDate)}</time></div>
                <h4>{item.title}</h4><p>{item.executionReason || item.whyNow}</p><strong>{item.suggestedAction}</strong>
                <footer><small>{item.guidanceKind === "follow_up" ? "Jake follows up" : item.owner}</small>{item.workItemId ? <button type="button" onClick={() => onOpenWorkItem(item.workItemId!)}>Open action</button> : null}</footer>
              </article>) : <div className="execution-empty">Nothing is ready for you right now.</div>}
            </section>
            <section className="execution-lane execution-waiting" aria-label="Waiting for">
              <header><div><span className="execution-dot" />Waiting for</div><small>{selected.guidance.waiting.length}</small></header>
              {selected.guidance.waiting.length ? selected.guidance.waiting.map((item) => <article key={item.id} className="execution-card">
                <div className="execution-card-meta"><span>{item.workstream}</span><time>{planDate(item.dueDate)}</time></div>
                <h4>{item.title}</h4><p>{item.executionReason}</p><strong>{item.suggestedAction}</strong>
                <footer><small>{item.owner}</small>{item.followUpWorkItemId ? <button type="button" onClick={() => onOpenWorkItem(item.followUpWorkItemId!)}>Open follow-up</button> : item.workItemId ? <button type="button" onClick={() => onOpenWorkItem(item.workItemId!)}>Open waiting item</button> : null}</footer>
              </article>) : <div className="execution-empty">No external inputs are holding the plan.</div>}
            </section>
            <section className="execution-lane execution-next" aria-label="Up next">
              <header><div><span className="execution-dot" />Up next</div><small>{selected.guidance.upNext.length}</small></header>
              {selected.guidance.upNext.length ? selected.guidance.upNext.slice(0,6).map((item) => <article key={item.id} className="execution-card">
                <div className="execution-card-meta"><span>{item.workstream}</span><time>{planDate(item.startDate || item.dueDate)}</time></div>
                <h4>{item.title}</h4><p>{item.executionReason}</p><strong>{item.suggestedAction}</strong>
                <footer><small>{item.owner}</small></footer>
              </article>) : <div className="execution-empty">No later work is waiting to unlock.</div>}
            </section>
          </div>
        </section>

        <section className="milestone-section">
          <div className="project-section-heading"><div><p className="kicker">DECISION ROADMAP</p><h3>Milestones</h3></div><span>{planDate(selected.startDate)} – {planDate(selected.targetDate)}</span></div>
          <div className="milestone-track">{selected.milestones.map((milestone) => <article key={milestone.id} className={`milestone milestone-${milestone.status}`}>
            <span>{planDate(milestone.scheduledDate)}</span><strong>{milestone.title}</strong><p>{milestone.decision}</p>
          </article>)}</div>
        </section>

        <section className="project-plan-section">
          <div className="project-section-heading"><div><p className="kicker">FULL WORKPLAN</p><h3>Workstreams and deliverables</h3></div><span>Updates stay local</span></div>
          <div className="workstream-list">{workstreams.map(([workstream, items]) => <details key={workstream} open={items.some((item) => ["active","blocked"].includes(item.status))}>
            <summary><strong>{workstream}</strong><span>{items.filter((item) => item.status === "complete").length}/{items.length} complete</span></summary>
            <div>{items.map((item) => <article className={`plan-row plan-${item.status}`} key={item.id}>
              <span className="plan-status-dot" aria-hidden="true" /><div><strong>{item.title}</strong><p>{item.description}</p><small>{executionLabel(item)} · {item.phaseTitle} · {item.owner} · Due {planDate(item.dueDate)}</small></div>
              <select aria-label={`Status for ${item.title}`} value={item.status} disabled={busyId === item.id} onChange={(event) => void updatePlanItem(item, event.target.value as ProjectPlanItem["status"])}>
                <option value="planned">Planned</option><option value="active">Active</option><option value="blocked">Blocked</option><option value="complete">Complete</option>
              </select>
            </article>)}</div>
          </details>)}</div>
        </section>
      </article>
    </section>
  );
}
