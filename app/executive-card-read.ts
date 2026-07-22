import { cardState, definitionOfDone, nextAction, type CardViewItem } from "./card-view-model.ts";

type EvidenceInput = { id?: string; provider?: string; label?: string; sourceUrl?: string; freshness?: string; retrievedAt?: string };
type RelationshipInput = { id: string; relationType: string; state: string; otherWorkItemId: string; otherTitle: string };
type ReviewInput = {
  status: "current" | "new_evidence" | "needs_reconciliation";
  whatItMeans: string;
  whyItMattersNow: string;
  recommendedNextMove: string;
  ownerDependency: string;
  definitionOfDone: string;
  reviewedBy: string;
  updatedAt: string;
  lastReconciledAt: string | null;
  evidence: EvidenceInput[];
} | null;

export type ExecutiveCardItem = CardViewItem & {
  id: string;
  companyName: string;
  dueAt: string | null;
  followUpAt: string | null;
  waitingOn: string;
  projectContext: null | { workstream: string; phaseTitle: string; projectTitle: string };
  sources: EvidenceInput[];
  notes: Array<{ id: string; title: string; type: string }>;
  relationships: RelationshipInput[];
  intelligenceReview: ReviewInput;
  assignments: Array<{ status: string; ownerId: string; result: string; error: string; updatedAt: string }>;
  agentRuns: Array<{ status: string; result: string; error: string; updatedAt: string }>;
  codexTasks: Array<{ status: string; result: string; error: string; updatedAt: string }>;
};

export type ExecutiveEvidence = { key: string; label: string; meta: string; url: string };
export type ExecutiveRelatedWork = { key: string; label: string; relation: string; workItemId: string };

export type ExecutiveCardRead = {
  stateLabel: string;
  currentTruth: string;
  whyNow: string;
  nextMove: string;
  actor: string;
  dependency: string;
  timing: string;
  doneWhen: string;
  contradictions: string[];
  authorityMeta: string;
  evidence: ExecutiveEvidence[];
  relatedWork: ExecutiveRelatedWork[];
  artifactLabel: string;
  materialConclusion: string;
};

function tidy(value: string) {
  return value.replace(/\s+/g, " ").replace(/\.{2,}$/g, ".").trim();
}

function sentence(value: string) {
  const cleaned = tidy(value.replace(/\[([^\]]+)]\([^\)]+\)/g, "$1").replace(/[*_`#]/g, ""));
  const match = cleaned.match(/^(.+?[.!?])(?:\s|$)/);
  return match?.[1] || cleaned;
}

function localDateKey(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateLabel(key: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "No date";
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function latestMaterialResult(item: ExecutiveCardItem) {
  return [
    ...item.assignments.filter((entry) => entry.status === "completed"),
    ...item.agentRuns.filter((entry) => entry.status === "review"),
    ...item.codexTasks.filter((entry) => ["complete", "completed", "review"].includes(entry.status)),
  ].filter((entry) => tidy(entry.result || entry.error)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.result || "";
}

function extractedDecision(result: string) {
  const explicit = result.match(/(?:most important remaining decision|remaining decision|decision now)\s*:\s*([^\n]+)/i)?.[1];
  if (explicit) return tidy(explicit.replace(/[.]+$/, ""));
  const recommendation = result.match(/(?:recommendation|recommended next move)\s*:\s*([^\n]+)/i)?.[1];
  return recommendation ? tidy(recommendation.replace(/[.]+$/, "")) : "";
}

function extractedArtifact(result: string) {
  const match = result.match(/\[([^\]]+)]\(([^\)]+)\)/);
  if (!match) return "";
  const label = tidy(match[1]);
  const target = match[2];
  if (/\b(?:sqlite|database|source record)\b/i.test(`${label} ${target}`)) return "";
  return label;
}

function proposedDueDate(result: string) {
  return result.match(/due_date\s*:\s*`?(\d{4}-\d{2}-\d{2})/i)?.[1]
    || result.match(/target due date\s*:\s*(?:\*\*)?[^\n]*?(\d{4})/i)?.[1]
    || "";
}

function personInAction(action: string) {
  const candidate = action.match(/^(?:ask|contact|email|message|call|confirm with|follow up with|reach out to)\s+([A-Z][A-Za-z'-]+)/i)?.[1];
  return candidate || "";
}

function requiresJakeBeforeWaiting(action: string) {
  return /^(?:ask|request|contact|email|message|call|send|schedule|confirm with|follow up with|reach out)/i.test(action.trim());
}

function relativeFreshness(value: string, anchor: Date) {
  const elapsed = anchor.getTime() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "Freshness unknown";
  const hours = Math.max(0, Math.round(elapsed / 3_600_000));
  if (hours < 24) return hours < 1 ? "Checked within the hour" : `Checked ${hours}h ago`;
  return `Checked ${Math.round(hours / 24)}d ago`;
}

function dedupedEvidence(item: ExecutiveCardItem) {
  const evidence = [...(item.intelligenceReview?.evidence || []), ...item.sources];
  const seen = new Set<string>();
  const rows: ExecutiveEvidence[] = [];
  for (const entry of evidence) {
    const label = tidy(entry.label || entry.provider || "Source evidence");
    const key = (entry.sourceUrl || label).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, label, meta: tidy(entry.freshness || entry.provider || "Evidence"), url: entry.sourceUrl || "" });
  }
  for (const note of item.notes) {
    const key = `note:${note.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, label: tidy(note.title), meta: note.type === "meeting" ? "Meeting note" : "Linked note", url: "" });
  }
  return rows.slice(0, 5);
}

function relatedWork(item: ExecutiveCardItem) {
  const rows: ExecutiveRelatedWork[] = item.relationships
    .filter((relationship) => relationship.state !== "dismissed")
    .map((relationship) => ({ key: relationship.id, label: relationship.otherTitle, relation: relationship.relationType.replaceAll("_", " "), workItemId: relationship.otherWorkItemId }));
  if (item.projectContext) rows.push({ key: `project:${item.projectContext.workstream}`, label: item.projectContext.workstream, relation: item.projectContext.phaseTitle || "project", workItemId: "" });
  return rows.filter((row, index, all) => all.findIndex((candidate) => candidate.label.toLowerCase() === row.label.toLowerCase()) === index).slice(0, 5);
}

export function buildExecutiveCardRead(item: ExecutiveCardItem, anchor = new Date()): ExecutiveCardRead {
  const review = item.intelligenceReview;
  const durableState = cardState(item);
  const materialResult = latestMaterialResult(item);
  const decision = extractedDecision(materialResult);
  const artifactLabel = extractedArtifact(materialResult);
  const contact = personInAction(item.suggestedAction);
  const waitingNeedsJake = item.status === "waiting_external" && requiresJakeBeforeWaiting(item.suggestedAction);
  const dependency = tidy(item.waitingOn || contact || (item.status === "waiting_external" ? durableState.owner : ""));
  const dependencyWithCompany = dependency && item.companyName && dependency.toLowerCase() !== item.companyName.toLowerCase() ? `${dependency} / ${item.companyName}` : dependency;
  const proposedDue = proposedDueDate(materialResult);
  const currentDue = localDateKey(item.dueAt);
  const contradictions: string[] = [];

  if (waitingNeedsJake) contradictions.push(`Card says ${durableState.label}, but the recorded next move still requires Jake to contact ${contact || dependency || "the dependency"}.`);
  if (proposedDue && currentDue && proposedDue !== currentDue) contradictions.push(`Card says ${dateLabel(currentDue)}; newer evidence proposes ${dateLabel(proposedDue)}.`);
  if (item.status === "back_for_review" && /^(?:build|prepare|create|draft|research|analyze|review)\b/i.test(nextAction(item))) contradictions.push(`Card is Ready to review, but its stored next move still describes work that the returned artifact says is complete.`);
  if (review?.status === "new_evidence") contradictions.push("New evidence has arrived since the last CEO / PM review.");
  if (review?.status === "needs_reconciliation") contradictions.push("The CEO / PM read conflicts with one or more durable card fields.");

  let currentTruth = review?.whatItMeans || item.summary || item.whyNow || "This commitment still needs a clear business read.";
  if (!review && waitingNeedsJake) currentTruth = /demo|recording/i.test(`${item.title} ${item.summary}`)
    ? `No demo or recording delivery is proven. The card is marked ${durableState.label}, but the recorded next move still requires Jake to contact ${contact || dependency || "the dependency"}.`
    : `No completed delivery is proven. The card is marked ${durableState.label}, but Jake still appears to own an outreach step.`;
  if (!review && item.status === "back_for_review" && materialResult) currentTruth = artifactLabel
    ? `${artifactLabel} is ready. ${decision ? `The remaining business decision is ${decision}.` : "Jake needs to review the artifact and record the decision."}`
    : sentence(materialResult);

  let recommendedNextMove = review?.recommendedNextMove || nextAction(item);
  if (!review && item.status === "back_for_review" && decision) recommendedNextMove = `Decide ${decision.replace(/^whether\b/i, "whether")}.`;
  if (!review && waitingNeedsJake) {
    const subject = /demo|recording/i.test(`${item.title} ${item.summary}`) ? "the demo" : "the requested input";
    recommendedNextMove = `Confirm whether ${contact || dependency || "the dependency owner"} has already been asked. If not, request ${subject}. If yes, follow up${proposedDue ? ` by ${dateLabel(proposedDue)}` : ""}.`;
  }

  const whyNow = review?.whyItMattersNow || (/demo|recording/i.test(`${item.title} ${item.summary}`)
    ? "Without the demo, product-map and package decisions rely on assumptions."
    : item.whyNow || item.summary || "The commitment remains unresolved.");
  const doneWhen = review?.definitionOfDone || (/demo|recording/i.test(`${item.title} ${item.summary}`)
    ? "A reviewable demo or recording is linked."
    : item.status === "back_for_review" && decision
      ? `Jake records the decision ${decision}.`
      : definitionOfDone(item));
  const actor = item.status === "back_for_review" || waitingNeedsJake || item.status === "waiting_on_user" ? "Jake" : tidy(item.owner || durableState.owner || "Jake");
  const timingKey = proposedDue || localDateKey(item.followUpAt) || currentDue;
  const stateLabel = item.status === "waiting_external" && contact ? `Waiting on ${contact}` : durableState.label;
  const authorityMeta = review ? `${review.reviewedBy || "CEO / PM"} read · read-only · ${relativeFreshness(review.updatedAt, anchor)}` : "";

  return {
    stateLabel,
    currentTruth: tidy(currentTruth),
    whyNow: tidy(whyNow),
    nextMove: tidy(recommendedNextMove),
    actor,
    dependency: dependencyWithCompany || "None recorded",
    timing: timingKey ? dateLabel(timingKey) : "No date",
    doneWhen: tidy(doneWhen),
    contradictions: [...new Set(contradictions)],
    authorityMeta,
    evidence: dedupedEvidence(item),
    relatedWork: relatedWork(item),
    artifactLabel,
    materialConclusion: decision ? `Decision: ${decision}.` : "",
  };
}
