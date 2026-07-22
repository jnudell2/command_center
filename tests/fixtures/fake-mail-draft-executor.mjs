import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const logPath = process.env.SERENT_TEND_MAIL_DRAFT_TEST_LOG || "";
const delayMs = Number(process.env.SERENT_TEND_MAIL_DRAFT_TEST_DELAY_MS || 0);
const failFile = process.env.SERENT_TEND_MAIL_DRAFT_TEST_FAIL_FILE || "";
const append = async (event) => {
  if (logPath) await appendFile(logPath, `${JSON.stringify({ event, at: Date.now(), pid: process.pid })}\n`, "utf8");
};

await append("start");
if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));

let shouldFail = false;
if (failFile) {
  try { shouldFail = (await readFile(failFile, "utf8")).trim() === "fail"; } catch { /* absent means pass */ }
}

if (shouldFail) {
  await append("error");
  process.stderr.write("Fixture draft generation failed by request.\n");
  process.exitCode = 2;
} else {
  const fingerprint = createHash("sha256").update(prompt).digest("hex").slice(0, 12);
  const subject = prompt.match(/^Subject:\s*(.+)$/m)?.[1]?.trim() || "this message";
  const body = `Thanks for the note on ${subject}. I will review it and follow up. [fixture ${fingerprint}]`;
  process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: body } })}\n`);
  await append("finish");
}
