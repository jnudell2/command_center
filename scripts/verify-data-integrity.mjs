import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const databasePath = path.resolve(process.argv[2] || "data/serent-tend.sqlite");
const db = new DatabaseSync(databasePath, { readOnly: true });
const centralAcceptanceItem = db
  .prepare("SELECT id,status,waiting_on,follow_up_at FROM work_items WHERE id=?")
  .get("24485506-6ffd-4b0b-944f-44e9669d32d9");

const result = {
  databasePath,
  schema13: Boolean(db.prepare("SELECT version FROM schema_migrations WHERE version=13").get()),
  schema14: Boolean(db.prepare("SELECT version FROM schema_migrations WHERE version=14").get()),
  schema15: Boolean(db.prepare("SELECT version FROM schema_migrations WHERE version=15").get()),
  quickCheck: db.prepare("PRAGMA quick_check").all(),
  foreignKeyErrors: db.prepare("PRAGMA foreign_key_check").all(),
  mailDraftRequests: db.prepare("SELECT COUNT(*) AS count FROM mail_draft_requests").get().count,
  mailDraftGenerations: db.prepare("SELECT COUNT(*) AS count FROM mail_draft_generations").get().count,
  duplicateActiveMailDrafts: db.prepare(`SELECT mail_message_id,content_fingerprint,COUNT(*) AS count
    FROM mail_draft_generations WHERE status IN ('queued','working')
    GROUP BY mail_message_id,content_fingerprint HAVING COUNT(*) > 1`).all(),
  centralAcceptanceItem,
};

db.close();
console.log(JSON.stringify(result, null, 2));

if (!result.schema13 || !result.schema14 || !result.schema15 || result.quickCheck.some((row) => row.quick_check !== "ok") || result.foreignKeyErrors.length || result.duplicateActiveMailDrafts.length) process.exitCode = 1;
