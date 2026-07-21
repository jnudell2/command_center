import test from "node:test";
import assert from "node:assert/strict";
import {
  assignmentScopeHash,
  createCallbackCapability,
  legacyAssignmentState,
  transitionAssignment,
  verifyCallbackCapability,
  workItemStatusForAssignment,
} from "../scripts/assignment-lifecycle.mjs";

const base = { id: "assignment-1", assignmentKey: "work-item:item-1:assignment:assignment-1", status: "prepared", ownerId: "", ownerType: "native_codex" };
const ownerId = "019f638b-d56d-7df2-bd21-ac47d008125b";

test("binds one owner and follows the verified lifecycle", () => {
  const accepted = transitionAssignment(base, { type: "accepted", ownerId });
  assert.equal(accepted.nextStatus, "accepted");
  assert.equal(accepted.ownerId, ownerId);
  const started = transitionAssignment({ ...base, status: accepted.nextStatus, ownerId: accepted.ownerId }, { type: "started", ownerId });
  assert.equal(started.nextStatus, "working");
  const completed = transitionAssignment({ ...base, status: started.nextStatus, ownerId }, { type: "completed", ownerId });
  assert.equal(completed.nextStatus, "completed");
  assert.equal(workItemStatusForAssignment({ nextStatus: completed.nextStatus, priorWorkItemStatus: "to_review" }), "back_for_review");
});

test("rejects conflicting owners, out-of-order events, and late terminal callbacks", () => {
  assert.throws(() => transitionAssignment(base, { type: "started", ownerId }), /cannot start from prepared/i);
  assert.throws(() => transitionAssignment({ ...base, status: "accepted", ownerId }, { type: "started", ownerId: "different-owner" }), /different native Codex owner/i);
  assert.throws(() => transitionAssignment({ ...base, status: "completed", ownerId }, { type: "heartbeat", ownerId }), /already terminal/i);
});

test("keeps attention distinct from user input and failure", () => {
  assert.equal(workItemStatusForAssignment({ nextStatus: "needs_input", priorWorkItemStatus: "to_review" }), "waiting_on_user");
  assert.equal(workItemStatusForAssignment({ nextStatus: "needs_attention", priorWorkItemStatus: "to_review" }), "needs_attention");
  assert.equal(workItemStatusForAssignment({ nextStatus: "failed", priorWorkItemStatus: "to_review" }), "error");
});

test("creates and verifies callback capabilities without exposing equality shortcuts", () => {
  const capability = createCallbackCapability();
  assert.ok(capability.token.length >= 40);
  assert.equal(verifyCallbackCapability(capability.token, capability.hash), true);
  assert.equal(verifyCallbackCapability(`${capability.token}x`, capability.hash), false);
});

test("normalizes request scope and legacy prepared receipts", () => {
  assert.equal(
    assignmentScopeHash({ workItemId: "item-1", destination: "card", instruction: "  Draft   the note " }),
    assignmentScopeHash({ workItemId: "item-1", destination: "card", instruction: "draft the note" }),
  );
  assert.equal(legacyAssignmentState({ status: "waiting_on_user", thread_id: "" }), "prepared");
  assert.equal(legacyAssignmentState({ status: "waiting_on_user", thread_id: ownerId }), "needs_input");
  assert.equal(legacyAssignmentState({ status: "complete", thread_id: ownerId }), "completed");
});
