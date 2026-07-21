import assert from "node:assert/strict";
import test from "node:test";
import { codexTaskLaunchMode } from "../scripts/codex-task-routing.mjs";

test("does not duplicate a Codex task that is already running", () => {
  assert.equal(codexTaskLaunchMode({ status: "working", thread_id: "thread-1" }), "already_running");
  assert.equal(codexTaskLaunchMode({ status: "starting", thread_id: "" }), "already_running");
  assert.equal(codexTaskLaunchMode({ status: "waiting_on_user", thread_id: "" }), "already_running");
  assert.equal(codexTaskLaunchMode({ status: "needs_input", thread_id: "thread-1" }), "already_running");
  assert.equal(codexTaskLaunchMode({ status: "needs_attention", thread_id: "thread-1" }), "already_running");
});

test("prepares a new native receipt after a terminal task", () => {
  assert.equal(codexTaskLaunchMode({ status: "complete", thread_id: "thread-1" }), "prepare");
  assert.equal(codexTaskLaunchMode({ status: "error", thread_id: "thread-1" }), "prepare");
});

test("prepares a native task receipt when none exists", () => {
  assert.equal(codexTaskLaunchMode(null), "prepare");
  assert.equal(codexTaskLaunchMode({ status: "error", thread_id: "" }), "prepare");
});
