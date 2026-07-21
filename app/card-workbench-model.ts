export type CardActionMode = "update" | "return_here" | "separate_task";

export type AssignmentEvent = {
  id: string;
  eventKey: string;
  type: string;
  ownerId: string;
  occurredAt: string | null;
  receivedAt: string;
  previousStatus: string;
  nextStatus: string;
  applied: boolean;
  rejectionReason: string;
};

export type Assignment = {
  id: string;
  assignmentKey: string;
  workItemId: string;
  destination: "card" | "separate_task";
  title: string;
  instruction: string;
  status: "prepared" | "accepted" | "working" | "needs_input" | "needs_attention" | "completed" | "failed" | "ownership_released" | "cancelled";
  attempt: number;
  priorWorkItemStatus: string;
  ownerType: string;
  ownerId: string;
  capabilityGeneration: number;
  allowedSources: string[];
  contextManifest: Record<string, unknown>;
  externalActionBoundary: string;
  result: string;
  error: string;
  revisionOf: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  needsInputAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  releasedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: AssignmentEvent[];
};

export const activeAssignmentStatuses = new Set(["accepted", "working", "needs_input", "needs_attention"]);

export function latestActionableAssignment(assignments: Assignment[]) {
  return [...assignments]
    .filter((assignment) => ["completed", "failed", "needs_input", "needs_attention"].includes(assignment.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
}

export function assignmentPresentation(assignment: Assignment) {
  if (assignment.status === "prepared") return { label: "Prepared — not running", detail: "This handoff is ready to copy into a user-owned Codex task. No task has accepted it yet." };
  if (assignment.status === "accepted") return { label: "Accepted", detail: "A verified Codex owner accepted this assignment and has not reported that work started yet." };
  if (assignment.status === "working") return { label: "Working", detail: "The verified Codex owner reports that work is underway." };
  if (assignment.status === "needs_input") return { label: "Decision needed", detail: assignment.result || "Codex needs your input before it can continue." };
  if (assignment.status === "needs_attention") return { label: "Check progress", detail: assignment.result || "No recent receipt has arrived. The existing owner remains assigned." };
  if (assignment.status === "completed") return { label: "Ready for review", detail: assignment.result || "Codex returned a result to this card." };
  if (assignment.status === "failed") return { label: "Could not complete", detail: assignment.error || "The assigned Codex task failed." };
  if (assignment.status === "ownership_released") return { label: "Ownership released", detail: assignment.result || "The Codex owner released this assignment without completing it." };
  return { label: "Cancelled", detail: "This unowned handoff was cancelled." };
}
