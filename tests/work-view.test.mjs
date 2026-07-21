import assert from "node:assert/strict";
import test from "node:test";

import { workViewFor, workViews } from "../app/work-view.ts";

test("keeps the primary work navigation to Open Work, Codex Working, and Done", () => {
  assert.deepEqual(workViews, [
    { id: "open", label: "Open Work" },
    { id: "codex_working", label: "Codex Working" },
    { id: "done", label: "Done" },
  ]);
});

test("keeps external waits in Open Work without changing their status", () => {
  const waiting = { status: "waiting_external" };
  assert.equal(workViewFor(waiting), "open");
  assert.equal(waiting.status, "waiting_external");
});

test("partitions unresolved, Codex-working, and completed cards into the three views", () => {
  const statuses = ["to_review", "waiting_on_user", "waiting_external", "back_for_review", "error", "queued", "working", "done", "dismissed"];
  const counts = Object.fromEntries(workViews.map((view) => [view.id, statuses.filter((status) => workViewFor({ status }) === view.id).length]));
  assert.deepEqual(counts, { open: 6, codex_working: 1, done: 2 });
  assert.equal(workViewFor({ status: "queued" }), "open", "accepted but not started work stays visible in Open Work");
  assert.equal(workViewFor({ status: "working" }), "codex_working", "only a started assignment belongs in Codex Working");
});
