import assert from "node:assert/strict";
import test from "node:test";
import { classifyProjectPlanItem, projectExecutionGuidance, projectFollowUpBucket } from "../scripts/project-execution.mjs";

const today = "2026-07-14";

function item(overrides = {}) {
  return {
    id: "item",
    title: "Run the analysis",
    owner_label: "Jake",
    start_date: "2026-07-14",
    due_date: "2026-07-21",
    status: "planned",
    surface_days: 21,
    follow_up_days: 3,
    depends_on: "[]",
    execution_mode: "auto",
    ...overrides,
  };
}

test("classifies ready work, external waits, and dependency-gated work", () => {
  const ready = item();
  assert.equal(classifyProjectPlanItem(ready,[ready],today).state,"do_now");

  const external = item({ id: "external", owner_label: "StockIQ team", status: "blocked", due_date: "2026-07-10" });
  const waiting = classifyProjectPlanItem(external,[external],today);
  assert.equal(waiting.state,"waiting");
  assert.equal(waiting.ownerState,"external");
  assert.equal(projectFollowUpBucket(external,today),1);

  const dependent = item({ id: "dependent", depends_on: '["external"]' });
  const gated = classifyProjectPlanItem(dependent,[external,dependent],today);
  assert.equal(gated.state,"up_next");
  assert.match(gated.reason,/Unlocks when/i);
});

test("unlocks dependent execution automatically when prerequisites complete", () => {
  const prerequisite = item({ id: "input", title: "Obtain the data", owner_label: "StockIQ team", status: "complete" });
  const analysis = item({ id: "analysis", depends_on: '["input"]' });
  const guidance = projectExecutionGuidance([prerequisite,analysis],today);
  assert.equal(guidance.doNow[0].id,"analysis");
  assert.equal(guidance.upNext.length,0);
});

test("keeps future work visible without prematurely creating a current action", () => {
  const future = item({ start_date: "2026-09-01", due_date: "2026-09-15", surface_days: 14 });
  const execution = classifyProjectPlanItem(future,[future],today);
  assert.equal(execution.state,"up_next");
  assert.match(execution.reason,/Planned to begin/i);
});
