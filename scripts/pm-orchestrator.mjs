const companyAliases = new Map([
  ["avionte", ["avionte", "aviante"]],
  ["stockiq", ["stockiq", "stock iq", "siq"]],
  ["govworx", ["govworx", "gov works", "govworks", "gov-worx"]],
  ["edulog", ["edulog", "edu log"]],
  ["firm", ["serent", "pricing coe", "firm"]],
]);

const stopWords = new Set([
  "about", "after", "again", "against", "along", "also", "another", "around", "avionte", "because", "before", "being", "below", "between", "build", "card", "codex", "command", "company", "could", "create", "current", "edulog", "from", "govworx", "have", "into", "jake", "more", "need", "needs", "next", "originating", "project", "serent", "should", "stockiq", "task", "that", "their", "there", "these", "thing", "this", "through", "using", "want", "where", "which", "with", "work", "working", "would",
]);

export function normalizePmText(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/stock\s*iq/g, "stockiq")
    .replace(/gov[\s-]*wor(?:ks|x)/g, "govworx")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pmTokens(value = "") {
  return [...new Set(normalizePmText(value).split(" ").filter((token) => token.length >= 3 && !stopWords.has(token)))];
}

export function inferPmCompany(value = "") {
  const normalized = ` ${normalizePmText(value)} `;
  for (const [slug, aliases] of companyAliases) {
    if (aliases.some((alias) => normalized.includes(` ${normalizePmText(alias)} `))) return slug;
  }
  return null;
}

function workItemIdFromThread(thread) {
  const text = `${thread.name || ""}\n${thread.preview || ""}`;
  return text.match(/work item id:\s*([0-9a-f-]{36})/i)?.[1] || "";
}

function threadCompanyText(thread) {
  const preview = String(thread.preview || "");
  const explicitCompany = preview.match(/^Company:\s*(.+)$/im)?.[1] || "";
  return `${thread.name || ""} ${explicitCompany}`;
}

function threadMatchText(thread) {
  const preview = String(thread.preview || "")
    .split(/\nRelevant (?:notes|transcript|sources)|\nSource manifest:/i)[0]
    .slice(0, 2600);
  return `${thread.name || ""} ${preview}`;
}

function statusType(thread) {
  return typeof thread.status === "string" ? thread.status : String(thread.status?.type || "unknown");
}

export function isPmThreadActive(status = "") {
  return new Set(["active", "inProgress", "in_progress", "working", "running"]).has(String(status));
}

function unixTime(value) {
  const numeric = Number(value || 0);
  return numeric > 0 ? new Date(numeric * 1000).toISOString() : "";
}

function matchThread(thread, workItems, explicitLinks) {
  const explicit = explicitLinks.get(thread.id);
  if (explicit) {
    const item = workItems.find((candidate) => candidate.id === explicit.workItemId) || null;
    if (item) return { item, type: explicit.type || "confirmed", confidence: 1, rationale: explicit.type === "codex_task" ? "This Codex task was created from the Command Center card." : "Jake confirmed this task-to-card link." };
    return { item: null, type: "closed_link", confidence: 1, rationale: "This task belongs to a card that is already closed." };
  }

  const embeddedId = workItemIdFromThread(thread);
  if (embeddedId) {
    const item = workItems.find((candidate) => candidate.id === embeddedId) || null;
    if (item) return { item, type: "embedded_id", confidence: 1, rationale: "The Codex task includes this Command Center work-item ID." };
    return { item: null, type: "closed_link", confidence: 1, rationale: "This task belongs to a card that is already closed." };
  }

  const text = threadMatchText(thread);
  const companySlug = inferPmCompany(threadCompanyText(thread));
  if (!companySlug) return { item: null, type: "unmatched", confidence: 0, rationale: "No company or card match was found." };
  const threadTokens = new Set(pmTokens(text));
  const candidates = workItems.filter((item) => item.company_slug === companySlug).map((item) => {
    const titleTokens = pmTokens(item.title);
    const allTokens = pmTokens(`${item.title} ${item.summary || ""} ${item.suggested_action || ""}`);
    const titleOverlap = titleTokens.filter((token) => threadTokens.has(token)).length;
    const overlap = allTokens.filter((token) => threadTokens.has(token)).length;
    const score = titleOverlap * 3 + overlap;
    return { item, titleOverlap, overlap, score };
  }).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 7 || (candidates[1] && best.score === candidates[1].score)) {
    return { item: null, type: "company_only", confidence: 0.45, rationale: `This looks like ${companySlug} work, but there is not one clear matching card.` };
  }
  const confidence = Math.min(0.94, 0.58 + best.titleOverlap * 0.08 + Math.min(best.overlap, 4) * 0.035);
  return { item: best.item, type: "likely", confidence, rationale: `The company and ${best.titleOverlap || best.overlap} key topic${(best.titleOverlap || best.overlap) === 1 ? "" : "s"} match this card.` };
}

function threadTitle(thread) {
  return String(thread.name || thread.preview || "Untitled Codex task").split(/\r?\n/)[0].slice(0, 220);
}

function recommendation({ action, workItem = null, observation = null, rationale }) {
  return {
    action,
    workItemId: workItem?.id || observation?.linkedWorkItemId || null,
    workItemTitle: workItem?.title || observation?.linkedWorkItemTitle || "",
    threadId: observation?.threadId || null,
    threadTitle: observation?.title || "",
    companySlug: workItem?.company_slug || observation?.companySlug || null,
    rationale,
  };
}

export function buildPmSnapshot({ threads = [], workItems = [], explicitLinks = [], recentAwarenessLimit = 20 }) {
  const links = new Map(explicitLinks.map((link) => [link.threadId, link]));
  const observations = [];

  for (const [threadIndex, thread] of threads.entries()) {
    const title = threadTitle(thread);
    const match = matchThread(thread, workItems, links);
    if (match.type === "closed_link") continue;
    if (match.type === "likely" && /^create a durable codex task\b/i.test(title)) continue;
    const companySlug = match.item?.company_slug || inferPmCompany(threadCompanyText(thread));
    const recentAwareness = threadIndex < recentAwarenessLimit;
    if (!companySlug && !match.item && !recentAwareness) continue;
    const updatedAt = unixTime(thread.recencyAt || thread.updatedAt);
    const ageMs = updatedAt ? Date.now() - Date.parse(updatedAt) : Number.POSITIVE_INFINITY;
    if (!recentAwareness && !match.item && (companySlug === "firm" || ageMs > 2 * 86400000)) continue;
    const latestSummary = String(thread.latestSummary || "").trim();
    const preview = String(thread.preview || "").slice(0, 1100);
    observations.push({
      threadId: thread.id,
      title,
      preview: `${preview}${latestSummary ? `\nLatest Codex update: ${latestSummary.slice(0, 450)}` : ""}`.slice(0, 1600),
      status: statusType(thread),
      companySlug,
      linkedWorkItemId: match.item?.id || null,
      linkedWorkItemTitle: match.item?.title || "",
      matchType: match.type,
      confidence: match.confidence,
      rationale: match.rationale,
      updatedAt,
      cwd: String(thread.cwd || ""),
    });
  }

  const recommendations = [];
  const coveredItems = new Set();
  for (const observation of observations) {
    if (observation.linkedWorkItemId) coveredItems.add(observation.linkedWorkItemId);
    if (observation.matchType === "likely") {
      recommendations.push(recommendation({ action: "link", observation, rationale: `Confirm that “${observation.title}” is the Codex task for this card so the PM agent will not dispatch duplicate work.` }));
    } else if (observation.linkedWorkItemId && isPmThreadActive(observation.status)) {
      recommendations.push(recommendation({ action: "monitor", observation, rationale: "Codex is actively working on this linked assignment. The PM agent should monitor it, not create another task." }));
    } else if (observation.linkedWorkItemId) {
      recommendations.push(recommendation({ action: "review", observation, rationale: "This linked Codex task is not currently running. Check its latest result or continue the existing task before creating another one." }));
    }
  }

  for (const item of workItems) {
    if (coveredItems.has(item.id)) continue;
    if (item.status === "waiting_external" || /external/i.test(item.owner || "")) {
      recommendations.push(recommendation({ action: "wait", workItem: item, rationale: item.suggested_action || "This is waiting on someone outside Codex." }));
      continue;
    }
    if (item.status === "back_for_review") {
      recommendations.push(recommendation({ action: "review", workItem: item, rationale: "Work has returned and needs Jake's review before anything else happens." }));
      continue;
    }
    if (item.decision_state === "proposed") {
      recommendations.push(recommendation({ action: "needs_jake", workItem: item, rationale: "This action is still proposed. Jake should accept, edit, or dismiss it before the PM agent delegates it." }));
      continue;
    }
    const codexOwned = /codex/i.test(item.owner || "");
    const autoPreparation = item.preparation_mode === "auto";
    if ((codexOwned || autoPreparation) && !["working", "queued"].includes(item.status)) {
      const rationale = autoPreparation
        ? "This accepted item is marked for automatic preparation and has no linked Codex task."
        : `This accepted ${item.owner} item has no linked Codex task and is eligible for a bounded assignment.`;
      recommendations.push(recommendation({ action: "dispatch", workItem: item, rationale }));
      continue;
    }
    if (!["working", "queued"].includes(item.status)) {
      recommendations.push(recommendation({ action: "needs_jake", workItem: item, rationale: item.suggested_action || "Jake owns the next move." }));
    }
  }

  const count = (actions) => recommendations.filter((item) => actions.includes(item.action)).length;
  const activeWorkItems = new Set(observations.filter((item) => item.linkedWorkItemId && isPmThreadActive(item.status)).map((item) => item.linkedWorkItemId));
  return {
    observations: observations.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")),
    recommendations,
    summary: {
      underway: activeWorkItems.size,
      likelyMatches: observations.filter((item) => item.matchType === "likely").length,
      wouldDispatch: count(["dispatch"]),
      needsJake: count(["needs_jake", "link", "review"]),
      waiting: count(["wait"]),
    },
  };
}

function recentChatLines(items = [], emptyLabel, limit = 20) {
  if (!items.length) return `- ${emptyLabel}`;
  return items.slice(0, limit).map((item) => {
    const company = item.companyName || item.companySlug || "Unassigned";
    const latest = String(item.preview || "").match(/Latest Codex update:\s*([\s\S]*)$/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
    return `- [${item.status || "unknown"}] ${item.title} | ${company}${latest ? ` | Latest: ${latest.slice(0, 220)}` : ""}`;
  }).join("\n");
}

function pmChatLines(items, emptyLabel, limit = 8) {
  if (!items.length) return `- ${emptyLabel}`;
  return items.slice(0, limit).map((item) => {
    const company = item.companyName || item.companySlug || "Unassigned";
    const title = item.workItemTitle || item.linkedWorkItemTitle || item.threadTitle || item.title || "Untitled work";
    const status = item.status ? ` (${String(item.status).replaceAll("_", " ")})` : "";
    return `- ${company}: ${title}${status}`;
  }).join("\n");
}

function dispatchedTaskLines(items, emptyLabel, limit = 8) {
  if (!items.length) return `- ${emptyLabel}`;
  return items.slice(0, limit).map((item) => {
    const company = item.companyName || item.companySlug || "Unassigned";
    const title = item.workItemTitle || item.linkedWorkItemTitle || item.threadTitle || item.title || "Untitled work";
    const state = item.status === "linked" ? "existing task reused" : "new task launch accepted";
    return `- ${company}: ${title} (${state}; completion not yet established)`;
  }).join("\n");
}

function strategicProjectLines(projects = []) {
  if (!projects.length) return "- No approved active project plans are available.";
  return projects.slice(0, 6).map((project) => {
    const critical = pmChatLines(project.criticalPath || [], "No current critical-path action.", 5);
    const blocked = pmChatLines(project.blocked || [], "No material blocker.", 4);
    const upNext = pmChatLines(project.upNext || [], "No near-term dependency unlocked next.", 4);
    return `### ${project.companyName || project.companySlug || "Unassigned"}: ${project.title}
Objective: ${project.objective || "Not stated"}
Progress: ${Number(project.progress?.percent || 0)}% | Health: ${project.health || "unknown"}
Active phase: ${project.activePhase || "Not set"}
Next decision gate: ${project.nextMilestone || "Not set"}
Critical path now:
${critical}
Blocked or externally dependent:
${blocked}
Next work likely to unlock:
${upNext}`;
  }).join("\n\n");
}

function compactSignalLines(items = [], emptyLabel, limit = 8) {
  if (!items.length) return `- ${emptyLabel}`;
  return items.slice(0, limit).map((item) => {
    const company = item.companyName || item.companySlug || "Unassigned";
    const title = item.title || item.subject || "Untitled";
    const timing = item.dueAt || item.startAt || item.receivedAt || "";
    return `- ${company}: ${title}${timing ? ` | ${timing}` : ""}`;
  }).join("\n");
}

export function buildPmChatPrompt({ kind = "pulse", payload = {}, generatedAt = new Date().toISOString() } = {}) {
  const observations = Array.isArray(payload.observations) ? payload.observations : [];
  const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  const strategy = payload.strategy || {};
  const underway = observations.filter((item) => item.linkedWorkItemId && isPmThreadActive(item.status));
  const review = recommendations.filter((item) => ["review", "needs_jake", "link"].includes(item.action));
  const waiting = recommendations.filter((item) => item.action === "wait");
  const dispatched = recommendations.filter((item) => item.action === "dispatch" && ["executed", "linked"].includes(item.status));
  const isMorning = kind === "morning";
  const format = isMorning
    ? "Write a CEO/PM morning brief under 600 words with: Executive judgment, Today's critical path, Work you started or continued, Decisions only Jake can make, Risks to the plan, and Recommended sequence."
    : "Write a delta-based CEO/PM update under 260 words with: What changed, Actions taken, Critical-path implications, and Decisions needed from Jake. If nothing material changed, say that in one sentence and mention only the single most important risk or next move.";
  return `You are Jake's persistent Command Center CEO and PM Agent. You are responsible for choosing priorities, protecting the critical path, and driving safe execution across his work. This is a ${isMorning ? "morning briefing" : kind === "manual" ? "manual strategic check" : "30-minute strategic pulse"} generated at ${generatedAt}.

${format}

Lead with judgment, not inventory. Explain what matters, what is off track, what can move now, and what should deliberately wait. Compare projects and make tradeoffs. Do not repeat every card. Never call a linked task "underway" unless its latest Codex turn is actually active. Completed or idle linked tasks belong in review, not in motion.

Use the Recent Codex work radar to detect overlap, newly completed deliverables, relevant evidence, and dependencies across Jake's other tasks. Recent does not mean authoritative, active, or complete. Do not create a duplicate assignment when an existing task appears to cover the work; call out a likely overlap for confirmation when the match is uncertain.

The backend has already performed the allowlisted local actions shown below. A launch means only that a task was created or resumed; it does not mean the deliverable completed. Describe those actions as started or resumed until Actual Codex work or Ready for Jake proves a later state. Do not create another Codex task from this status turn and do not claim an action was taken unless it appears under New or reused preparation tasks. Do not send messages or write to external systems. Jake may reply in this task with questions or corrections; when he does, treat this as the continuing CEO/PM conversation and consult the live Command Center before making current-state claims.

Snapshot totals:
- Active Codex turns: ${Number(payload.summary?.underway || 0)}
- Automatically started this run: ${Number(payload.summary?.autoStarted || 0)}
- Needs Jake: ${Number(payload.summary?.needsJake || 0)}
- Waiting: ${Number(payload.summary?.waiting || 0)}

Approved project strategy:
${strategicProjectLines(strategy.projects || [])}

Actual Codex work running now:
${pmChatLines(underway, "No Codex turn is actively running.")}

Recent Codex work radar (20 most recent tasks, for awareness):
${recentChatLines(observations, "No recent Codex tasks were available.")}

New or reused preparation tasks:
${dispatchedTaskLines(dispatched, "No preparation task was started in this check.")}

Ready for Jake:
${pmChatLines(review, "Nothing currently needs Jake's review or decision.")}

Waiting or blocked:
${pmChatLines(waiting, "No external waits were identified.")}

Upcoming fixed commitments:
${compactSignalLines(strategy.calendar || [], "No upcoming fixed commitment in the planning window.", 6)}

Current reply obligations:
${compactSignalLines(strategy.mail || [], "No high-signal reply obligation is currently surfaced.", 6)}`;
}
