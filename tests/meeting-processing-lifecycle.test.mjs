import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const runnerScript = fileURLToPath(new URL("../scripts/local-control-server.mjs", import.meta.url));

async function waitFor(url, predicate = (value) => Boolean(value), timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        lastValue = await response.json();
        if (predicate(lastValue)) return lastValue;
      }
    } catch {
      // The runner may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out waiting for ${url}; last value: ${JSON.stringify(lastValue)}`);
}

async function stopRunner(runner) {
  if (runner.exitCode !== null) return;
  const exited = once(runner, "exit");
  runner.kill();
  await exited;
}

function startRunner({ dataDir, port, env = {} }) {
  return spawn(process.execPath, [runnerScript], {
    cwd: appRoot,
    env: {
      ...process.env,
      SERENT_TEND_DATA_DIR: dataDir,
      SERENT_TEND_PORT: String(port),
      SERENT_TEND_DISABLE_MAIL_DRAFTS: "1",
      ...env,
    },
    windowsHide: true,
  });
}

function seedMeeting(db, suffix, state = "waiting_for_transcript") {
  const now = "2026-07-30T18:40:00.000Z";
  db.prepare(`INSERT INTO calendar_events(id,graph_id,subject,start_at,end_at,attendees_json,freshness,last_synced_at,created_at,updated_at)
    VALUES(?,?,?,'2026-07-30T18:00:00.000Z','2026-07-30T18:30:00.000Z','[{"name":"Client"}]','live',?,?,?)`)
    .run(`event-${suffix}`, `graph-${suffix}`, `Lifecycle meeting ${suffix}`, now, now, now);
  db.prepare(`INSERT INTO work_items(id,type,company_slug,title,summary,why_now,status,suggested_action,source_provider,source_key,decision_state,created_at,updated_at)
    VALUES(?,'meeting_follow_up','firm',?,'Meeting ended.','Transcript follow-through.','waiting_on_user','Process transcript.','calendar',?,'accepted',?,?)`)
    .run(`card-${suffix}`, `Process lifecycle meeting ${suffix}`, `post-meeting:graph-${suffix}`, now, now);
  db.prepare(`INSERT INTO meeting_workflows(id,calendar_event_id,work_item_id,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).run(`flow-${suffix}`, `event-${suffix}`, `card-${suffix}`, state, now, now);
}

test("the launcher rejects bundled Node versions that cannot run the SQLite backend", async () => {
  const launcher = await readFile(fileURLToPath(new URL("../scripts/start-serent-tend.ps1", import.meta.url)), "utf8");
  assert.match(launcher, /\[version\]'22\.13\.0'/);
  assert.match(launcher, /Test-SupportedNode \$command\.Source/);
  assert.match(launcher, /Node\.js 22\.13 or newer could not be located/);
});

test("meeting processing records terminal failure and retries from staged or archived source", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "serent-meeting-lifecycle-"));
  const dataDir = path.join(root, "data");
  const transcriptRoot = path.join(root, "transcripts");
  const downloadsDir = path.join(root, "downloads");
  const executorPath = path.join(root, "meeting-executor.mjs");
  const controlPath = path.join(root, "executor-mode.txt");
  const port = 46600 + Math.floor(Math.random() * 300);
  await mkdir(downloadsDir, { recursive: true });
  await writeFile(controlPath, "fail", "utf8");
  await writeFile(executorPath, `
import { readFileSync } from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => {
  const mode = readFileSync(process.env.MEETING_EXECUTOR_CONTROL, "utf8").trim();
  if (mode === "fail") {
    process.stderr.write("simulated transcript executor failure");
    process.exitCode = 23;
    return;
  }
  const result = {
    companySlug: "firm",
    noteTitle: "Lifecycle meeting notes",
    noteBody: "## Outcome\\n\\nThe transcript was processed from the staged source.",
    summary: "Lifecycle recovery succeeded.",
    actions: []
  };
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }) + "\\n");
});
`, "utf8");
  const runner = startRunner({
    dataDir,
    port,
    env: {
      SERENT_TEND_TRANSCRIPT_ROOT: transcriptRoot,
      SERENT_TEND_DOWNLOADS_DIR: downloadsDir,
      SERENT_TEND_MEETING_EXECUTOR_SCRIPT: executorPath,
      SERENT_TEND_MEETING_PROCESSING_TIMEOUT_MS: "3000",
      MEETING_EXECUTOR_CONTROL: controlPath,
    },
  });
  t.after(async () => {
    await stopRunner(runner);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(`http://127.0.0.1:${port}/api/health`);

  const db = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  seedMeeting(db, "terminal");
  db.close();
  const sourcePath = path.join(downloadsDir, "GMT20260730-180105_Recording.transcript.vtt");
  await writeFile(sourcePath, "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nTest transcript lifecycle.\n", "utf8");

  const first = await fetch(`http://127.0.0.1:${port}/api/meeting-workflows/card-terminal/process`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidatePath: sourcePath }),
  });
  assert.equal(first.status, 202);
  const failed = await waitFor(
    `http://127.0.0.1:${port}/api/meeting-workflows/card-terminal`,
    (value) => value.state === "error",
  );
  assert.match(failed.error, /simulated transcript executor failure|EPIPE/i);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).activeJobs, 0);

  const failedDb = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  const failedContext = JSON.parse(failedDb.prepare("SELECT context_manifest FROM agent_runs WHERE id=?").get(failed.agentRunId).context_manifest);
  failedDb.close();
  assert.equal((await stat(failedContext.stagedTranscriptPath)).isFile(), true);
  const archivedDir = path.join(transcriptRoot, "inbox", "processed");
  const archivedPath = path.join(archivedDir, path.basename(sourcePath));
  await mkdir(archivedDir, { recursive: true });
  await writeFile(archivedPath, await readFile(sourcePath));
  await rm(path.join(dataDir, "meeting-inputs"), { recursive: true, force: true });
  await rm(sourcePath);
  await writeFile(controlPath, "success", "utf8");
  const retried = await fetch(`http://127.0.0.1:${port}/api/meeting-workflows/card-terminal/process`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(retried.status, 202);
  const completed = await waitFor(
    `http://127.0.0.1:${port}/api/meeting-workflows/card-terminal`,
    (value) => value.state === "review",
  );
  assert.equal(completed.candidatePath, archivedPath);
  assert.equal((await stat(completed.transcriptPath)).isFile(), true);
  assert.equal((await stat(completed.noteFilePath)).isFile(), true);

  const verified = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  const runs = verified.prepare("SELECT status FROM agent_runs WHERE work_item_id='card-terminal' ORDER BY created_at,id").all();
  assert.deepEqual(runs.map((run) => run.status).sort(), ["error", "review"]);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM source_references WHERE work_item_id='card-terminal' AND provider='transcripts'").get().count, 1);
  verified.close();
});

test("restart recovery and read reconciliation cannot leave a meeting falsely processing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "serent-meeting-restart-"));
  const dataDir = path.join(root, "data");
  const port = 46900 + Math.floor(Math.random() * 300);
  let runner = startRunner({ dataDir, port, env: { SERENT_TEND_DISABLE_LOCAL_WORKFLOWS: "1" } });
  t.after(async () => {
    await stopRunner(runner);
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(`http://127.0.0.1:${port}/api/health`);

  const db = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  seedMeeting(db, "restart", "processing");
  db.prepare(`INSERT INTO agent_runs(id,work_item_id,company_slug,scope,intent,title,status,input_hash,created_at,updated_at)
    VALUES('run-restart','card-restart','firm','meeting_transcript','Process transcript','Restart run','working','restart-hash',?,?)`)
    .run("2026-07-30T18:40:00.000Z", "2026-07-30T18:40:00.000Z");
  db.prepare("UPDATE meeting_workflows SET agent_run_id='run-restart' WHERE id='flow-restart'").run();
  db.close();

  await stopRunner(runner);
  runner = startRunner({ dataDir, port, env: { SERENT_TEND_DISABLE_LOCAL_WORKFLOWS: "1" } });
  await waitFor(`http://127.0.0.1:${port}/api/health`);
  const recovered = await waitFor(
    `http://127.0.0.1:${port}/api/meeting-workflows/card-restart`,
    (value) => value.state === "error",
  );
  assert.match(recovered.error, /runner restarted|interrupted/i);

  const verifyDb = new DatabaseSync(path.join(dataDir, "serent-tend.sqlite"));
  assert.equal(verifyDb.prepare("SELECT status FROM agent_runs WHERE id='run-restart'").get().status, "error");
  verifyDb.prepare("UPDATE meeting_workflows SET state='processing',error='' WHERE id='flow-restart'").run();
  verifyDb.prepare("UPDATE agent_runs SET status='working',error='' WHERE id='run-restart'").run();
  verifyDb.close();
  const reconciled = await waitFor(
    `http://127.0.0.1:${port}/api/meeting-workflows/card-restart`,
    (value) => value.state === "error",
  );
  assert.match(reconciled.error, /without a completion receipt/i);
});
