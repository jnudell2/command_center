import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const assignmentDestinations = new Set(["card", "separate_task"]);
export const assignmentStates = new Set([
  "prepared",
  "accepted",
  "working",
  "needs_input",
  "needs_attention",
  "completed",
  "failed",
  "ownership_released",
  "cancelled",
]);
export const activeAssignmentStates = new Set(["prepared", "accepted", "working", "needs_input", "needs_attention"]);
export const ownerAssignmentStates = new Set(["accepted", "working", "needs_input", "needs_attention"]);
export const terminalAssignmentStates = new Set(["completed", "failed", "ownership_released", "cancelled"]);

const eventAliases = new Map([
  ["working", "started"],
  ["complete", "completed"],
  ["error", "failed"],
  ["released", "ownership_released"],
]);

export function normalizeAssignmentDestination(value) {
  return assignmentDestinations.has(value) ? value : "card";
}

export function normalizeAssignmentEvent(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return eventAliases.get(normalized) || normalized;
}

export function assignmentScopeHash({ workItemId, destination, instruction }) {
  const normalizedInstruction = String(instruction || "").trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256")
    .update(`${workItemId}:${normalizeAssignmentDestination(destination)}:${normalizedInstruction}`)
    .digest("hex");
}

export function createAssignmentIdentity(workItemId) {
  const id = randomUUID();
  return { id, assignmentKey: `work-item:${workItemId}:assignment:${id}` };
}

export function createCallbackCapability() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashCallbackCapability(token) };
}

export function hashCallbackCapability(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

export function verifyCallbackCapability(token, expectedHash) {
  const actual = Buffer.from(hashCallbackCapability(token), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return actual.length === expected.length && actual.length > 0 && timingSafeEqual(actual, expected);
}

export function legacyAssignmentState(task) {
  const status = String(task?.status || "");
  if (status === "waiting_on_user" && !task?.thread_id) return "prepared";
  return ({
    waiting_on_user: "needs_input",
    starting: "accepted",
    accepted: "accepted",
    working: "working",
    needs_input: "needs_input",
    needs_attention: "needs_attention",
    complete: "completed",
    review: "completed",
    error: "failed",
    ownership_released: "ownership_released",
  })[status] || "failed";
}

function requireOwner(ownerId) {
  if (!/^[0-9a-z][0-9a-z._:-]{2,199}$/i.test(String(ownerId || ""))) {
    throw new Error("A stable native Codex owner ID is required for this lifecycle event.");
  }
}

function requireMatchingOwner(current, ownerId) {
  requireOwner(ownerId);
  if (current.ownerId && current.ownerId !== ownerId) {
    throw new Error("This assignment already belongs to a different native Codex owner.");
  }
}

export function transitionAssignment(current, rawEvent) {
  const eventType = normalizeAssignmentEvent(rawEvent?.type);
  const ownerId = String(rawEvent?.ownerId || "").trim();
  const state = String(current?.status || "prepared");
  if (!assignmentStates.has(state)) throw new Error(`Unknown assignment state: ${state}`);
  if (terminalAssignmentStates.has(state)) throw new Error(`Assignment ${current.assignmentKey || current.id} is already terminal (${state}).`);

  let nextStatus = state;
  let nextOwnerId = current.ownerId || "";
  let ownerType = current.ownerType || "native_codex";

  if (eventType === "accepted") {
    if (state !== "prepared") throw new Error(`An assignment can be accepted only from prepared, not ${state}.`);
    requireMatchingOwner(current, ownerId);
    nextStatus = "accepted";
    nextOwnerId = ownerId;
    ownerType = String(rawEvent?.ownerType || "native_codex").slice(0, 80) || "native_codex";
  } else if (eventType === "started") {
    if (!["accepted", "needs_input", "needs_attention"].includes(state)) throw new Error(`An assignment cannot start from ${state}.`);
    requireMatchingOwner(current, ownerId);
    nextStatus = "working";
    nextOwnerId = ownerId;
  } else if (eventType === "heartbeat") {
    if (state !== "working") throw new Error(`A heartbeat is valid only while working, not ${state}.`);
    requireMatchingOwner(current, ownerId);
  } else if (eventType === "needs_input") {
    if (!["accepted", "working", "needs_attention"].includes(state)) throw new Error(`Input cannot be requested from ${state}.`);
    requireMatchingOwner(current, ownerId);
    nextStatus = "needs_input";
    nextOwnerId = ownerId;
  } else if (eventType === "needs_attention") {
    if (!["accepted", "working", "needs_input"].includes(state)) throw new Error(`Attention cannot be requested from ${state}.`);
    if (ownerId) requireMatchingOwner(current, ownerId);
    nextStatus = "needs_attention";
    nextOwnerId = current.ownerId || ownerId;
  } else if (eventType === "completed") {
    if (!["working", "needs_input", "needs_attention"].includes(state)) throw new Error(`An assignment cannot complete from ${state}.`);
    requireMatchingOwner(current, ownerId);
    nextStatus = "completed";
    nextOwnerId = ownerId;
  } else if (eventType === "failed") {
    if (!["accepted", "working", "needs_input", "needs_attention"].includes(state)) throw new Error(`An assignment cannot fail from ${state}.`);
    requireMatchingOwner(current, ownerId);
    nextStatus = "failed";
    nextOwnerId = ownerId;
  } else if (eventType === "ownership_released") {
    if (!["accepted", "working", "needs_input", "needs_attention"].includes(state)) throw new Error(`Ownership cannot be released from ${state}.`);
    requireMatchingOwner(current, ownerId);
    nextStatus = "ownership_released";
    nextOwnerId = ownerId;
  } else if (eventType === "cancelled") {
    if (state !== "prepared" || current.ownerId) throw new Error("Only an unowned prepared assignment can be cancelled.");
    nextStatus = "cancelled";
  } else {
    throw new Error("Assignment event must be accepted, started, heartbeat, needs_input, needs_attention, completed, failed, ownership_released, or cancelled.");
  }

  return { eventType, previousStatus: state, nextStatus, ownerId: nextOwnerId, ownerType };
}

export function workItemStatusForAssignment({ priorWorkItemStatus }) {
  return priorWorkItemStatus || "to_review";
}
