import assert from "node:assert/strict";
import test from "node:test";

import { workViewFor, workViews } from "../app/work-view.ts";

test("keeps navigation to consolidated Open Work and Resolved", () => {
  assert.deepEqual(workViews, [
    { id: "open", label: "Open Work" },
    { id: "done", label: "Resolved" },
  ]);
});

test("keeps every unresolved state, including waiting and working, in Open Work", () => {
  const unresolved = ["to_review", "waiting_on_user", "waiting_external", "back_for_review", "error", "needs_attention", "queued", "working"];
  for (const status of unresolved) assert.equal(workViewFor({ status }), "open", status);
  assert.equal(workViewFor({ status: "done" }), "done");
  assert.equal(workViewFor({ status: "dismissed" }), "done");
});

test("moves one completed card to Resolved and exact-status Undo moves it back", () => {
  const before = ["waiting_external", "to_review", "done"];
  const count = (statuses, view) => statuses.filter((status) => workViewFor({ status }) === view).length;
  assert.deepEqual({ open: count(before, "open"), done: count(before, "done") }, { open: 2, done: 1 });
  const completed = ["done", ...before.slice(1)];
  assert.deepEqual({ open: count(completed, "open"), done: count(completed, "done") }, { open: 1, done: 2 });
  const undone = [before[0], ...completed.slice(1)];
  assert.deepEqual(undone, before);
  assert.deepEqual({ open: count(undone, "open"), done: count(undone, "done") }, { open: 2, done: 1 });
});
