import assert from "node:assert/strict";
import test from "node:test";
import { parseCardCommand, parseDueDateText } from "../scripts/card-command.mjs";

const now = new Date(2026, 6, 16, 9, 0, 0);
const current = { title: "Old title", due_at: null, priority: "normal", company_slug: "stockiq", status: "to_review", resolution: "", resolved_at: null };
const companies = [{ slug: "stockiq", displayName: "StockIQ" }, { slug: "govworx", displayName: "GovWorx" }];

test("parses local due dates and rejects impossible dates", () => {
  const friday = parseDueDateText("Friday", now);
  assert.equal(new Date(friday).getDate(), 17);
  assert.equal(parseDueDateText("2026-02-30", now), null);
});

test("applies multiple simple card changes without creating agent work", () => {
  const command = parseCardCommand({ instruction: "Change the title to Get the Planhat data and set priority to high and due Friday", current, companies, now });
  assert.equal(command.handled, true);
  assert.equal(command.patch.title, "Get the Planhat data");
  assert.equal(command.patch.priority, "high");
  assert.equal(new Date(command.patch.due_at).getDate(), 17);
  assert.equal(command.remainingIntent, "");
  assert.equal(parseCardCommand({ instruction: "Change to Get the updated data", current, companies, now }).patch.title, "Get the updated data");
});

test("splits local edits from remaining Codex work", () => {
  const command = parseCardCommand({ instruction: "Move this to Friday and draft the follow-up email", current, companies, now });
  assert.equal(command.handled, true);
  assert.equal(new Date(command.patch.due_at).getDate(), 17);
  assert.equal(command.remainingIntent, "draft the follow-up email");
});

test("routes company, waiting, completion, and clarification commands", () => {
  assert.equal(parseCardCommand({ instruction: "This is for GovWorx", current, companies, now }).patch.company_slug, "govworx");
  assert.equal(parseCardCommand({ instruction: "This is waiting on Kevin", current, companies, now }).patch.status, "waiting_external");
  assert.equal(parseCardCommand({ instruction: "Mark this done", current, companies, now }).patch.status, "done");
  assert.match(parseCardCommand({ instruction: "Change the due date to abc", current, companies, now }).clarification, /could not understand/i);
});
