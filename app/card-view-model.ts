export type CardViewItem = {
  type: string;
  title: string;
  summary: string;
  whyNow: string;
  suggestedAction: string;
  preparationInstruction: string;
  priority: "urgent" | "high" | "normal" | "low";
  status: string;
  decisionState: string;
  owner: string;
  events: Array<{ type: string; detail: string; createdAt: string }>;
  assignments?: Array<{ status: string; ownerId: string; updatedAt: string }>;
  agentRuns?: Array<{ status: string; updatedAt: string }>;
};

const persistentPmNames: Record<string, string> = {
  "019f5c8f-5994-7c73-a717-67a0ad7b0682": "SIQ PM",
  "019f576b-5588-7550-a35b-e46dadb9dab1": "GovWorX PM",
  "019f6398-1b34-7842-af0d-61b16eb815ee": "Avionte PM",
};

const genericOwners = new Set(["", "external", "someone else", "jake", "jake + codex", "codex", "unassigned"]);

function cleanPerson(value: string) {
  const person = value
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:according to|before|for|so that|to)\b.*$/i, "")
    .replace(/[.?!,:;].*$/, "")
    .trim();
  if (!person || person.length > 38 || genericOwners.has(person.toLowerCase())) return "";
  return person;
}

export function waitingOnName(item: CardViewItem) {
  const waitingEvent = [...item.events]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .find((event) => event.type === "waiting_external" || /waiting on/i.test(event.detail));
  const eventMatch = waitingEvent?.detail.match(/waiting on\s+([^.;]+)/i)?.[1] || "";
  const fromEvent = cleanPerson(eventMatch);
  if (fromEvent) return fromEvent;

  const owner = cleanPerson(item.owner);
  if (owner) return owner;

  const actionMatch = item.suggestedAction.match(/(?:follow up with|wait(?:ing)? (?:for|on)|from)\s+([^.;]+)/i)?.[1] || "";
  return cleanPerson(actionMatch);
}

export function verifiedPmName(item: CardViewItem) {
  const verified = [...(item.assignments || [])]
    .filter((assignment) => Boolean(persistentPmNames[assignment.ownerId]) && !["prepared", "cancelled", "ownership_released", "failed"].includes(assignment.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return verified ? persistentPmNames[verified.ownerId] : "";
}

export function cardState(item: CardViewItem) {
  const waitingOn = waitingOnName(item);
  if (item.status === "back_for_review") {
    return { label: "Ready to review", owner: "Jake", detail: "A result or artifact is ready for Jake's decision." };
  }
  if (["error", "needs_attention"].includes(item.status)) return { label: "Needs attention", owner: "Jake", detail: "Review the latest issue in History before deciding the next move." };
  if (item.status === "waiting_on_user") return { label: "Waiting on Jake", owner: "Jake", detail: "Jake's input or decision is the next dependency." };
  if (item.status === "waiting_external") return {
    label: waitingOn ? `Waiting on ${waitingOn}` : "Waiting on someone else",
    owner: waitingOn || "External",
    detail: waitingOn ? `${waitingOn} currently owns the next input.` : "An external input currently blocks the next move.",
  };
  const pm = verifiedPmName(item);
  if (pm && ["queued", "working"].includes(item.status)) return { label: `With ${pm}`, owner: pm, detail: `A verified receipt shows that ${pm} owns the work, but the durable card state still needs reconciliation.` };
  if (["queued", "working"].includes(item.status)) return { label: "Needs reconciliation", owner: item.owner || "Jake", detail: "This legacy technical status must be reconciled before it can be treated as a business state." };
  if (item.status === "done") return { label: "Done", owner: "Resolved", detail: "This commitment is complete." };
  if (item.status === "dismissed") return { label: "Not needed", owner: "Resolved", detail: "Jake decided this item is not needed." };
  if (item.decisionState === "proposed") return { label: "Needs decision", owner: "Jake", detail: "Jake has not yet accepted this proposed commitment." };
  return { label: "Open", owner: "Jake", detail: "Jake owns the next move." };
}

export function nextAction(item: CardViewItem) {
  return item.suggestedAction.trim() || item.summary.trim() || "Decide the next move.";
}

export function definitionOfDone(item: CardViewItem) {
  const explicit = item.preparationInstruction.match(/definition of done:\s*([^\n]+)/i)?.[1]?.trim();
  if (explicit) return explicit.replace(/\.{2,}$/, ".");
  const text = `${item.type} ${item.title}`.toLowerCase();
  if (/email|reply/.test(text)) return "The response is reviewed, sent when approved, and the obligation is closed.";
  if (/meeting/.test(text)) return "The meeting has a clear objective, required inputs, and captured follow-ups with owners.";
  if (/review|decision/.test(text)) return "Jake has reviewed the evidence and recorded the decision or requested revision.";
  return item.summary.trim() || "The next action is complete and the outcome is recorded on this card.";
}

export function workingSurface(item: CardViewItem) {
  const text = `${item.type} ${item.title}`.toLowerCase();
  if (/meeting|one-on-one|1:1|agenda/.test(text)) return { label: "Meeting agenda", placeholder: "Capture talking points, decisions needed, and questions..." };
  if (/email|reply|follow.?up/.test(text)) return { label: "Draft reply", placeholder: "Write or refine the reply you may send..." };
  if (/deck|presentation|powerpoint|artifact/.test(text)) return { label: "Deck outline", placeholder: "Capture the story, required slides, evidence, and open questions..." };
  if (/schedul|calendar|kickoff/.test(text)) return { label: "Scheduling note", placeholder: "Capture attendees, timing constraints, and outreach..." };
  return { label: "Working notes", placeholder: "Capture optional notes, a checklist, or partial thinking..." };
}

export function contextKind(item: Pick<CardViewItem, "type" | "title">) {
  const text = `${item.type} ${item.title}`.toLowerCase();
  if (/email|reply/.test(text)) return "Email context";
  if (/meeting/.test(text)) return "Meeting context";
  if (/transcript/.test(text)) return "Transcript evidence";
  if (/personal/.test(text)) return "Personal notes";
  if (/review|decision/.test(text)) return "Review context";
  return "Project context";
}

export function showPriority(priority: CardViewItem["priority"]) {
  return priority === "urgent" || priority === "high";
}
