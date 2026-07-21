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
