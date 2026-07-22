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
  quickCheck: db.prepare("PRAGMA quick_check").all(),
  foreignKeyErrors: db.prepare("PRAGMA foreign_key_check").all(),
  mailDraftRequests: db.prepare("SELECT COUNT(*) AS count FROM mail_draft_requests").get().count,
  centralAcceptanceItem,
};

db.close();
console.log(JSON.stringify(result, null, 2));

if (!result.schema13 || !result.schema14 || result.quickCheck.some((row) => row.quick_check !== "ok") || result.foreignKeyErrors.length) process.exitCode = 1;
