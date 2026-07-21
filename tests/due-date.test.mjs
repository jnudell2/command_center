import assert from "node:assert/strict";
import test from "node:test";

import { dueDateEndOfLocalDayIso, dueDateInputValue } from "../app/due-date.ts";

function assertLocalEndOfDay(iso, expectedDay) {
  const date = new Date(iso);
  assert.equal(dueDateInputValue(iso), expectedDay);
  assert.equal(date.getHours(), 23);
  assert.equal(date.getMinutes(), 59);
  assert.equal(date.getSeconds(), 59);
  assert.equal(date.getMilliseconds(), 999);
}

test("sets and changes a due date at the selected local day's end", () => {
  const first = dueDateEndOfLocalDayIso("2026-07-17");
  const changed = dueDateEndOfLocalDayIso("2026-07-18");
  assertLocalEndOfDay(first, "2026-07-17");
  assertLocalEndOfDay(changed, "2026-07-18");
  assert.notEqual(first, changed);
});

test("clears due dates and safely renders missing or invalid values", () => {
  assert.equal(dueDateEndOfLocalDayIso(""), null);
  assert.equal(dueDateInputValue(null), "");
  assert.equal(dueDateInputValue("not-a-date"), "");
});

test("rejects impossible calendar dates", () => {
  assert.throws(() => dueDateEndOfLocalDayIso("2026-02-31"), /valid due date/i);
});
