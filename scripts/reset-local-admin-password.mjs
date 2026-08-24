import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const passwordFile = argument("--password-file");
const username = argument("--username");
if (!passwordFile) fail("Usage: node scripts/reset-local-admin-password.mjs --password-file <path> [--username <name>]");
if (!existsSync(passwordFile)) fail(`Password file does not exist: ${passwordFile}`);

const password = readFileSync(passwordFile, "utf8").trim();
if (password.length < 12 || password.length > 128) fail("New password must contain 12-128 characters");

const storageDir = process.env.STORAGE_DIR || "/data";
const databasePath = join(storageDir, "db", "health-records.sqlite");
if (!existsSync(databasePath)) fail(`Database does not exist: ${databasePath}`);

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
const accounts = username
  ? db.prepare(`SELECT id, user_id AS userId, username FROM local_accounts WHERE username = ? AND disabled_at IS NULL`).all(username)
  : db.prepare(`SELECT id, user_id AS userId, username FROM local_accounts WHERE disabled_at IS NULL`).all();
if (accounts.length === 0) fail(username ? `Active local administrator not found: ${username}` : "No active local administrator found");
if (accounts.length > 1) fail("Multiple local accounts found; specify --username");

const account = accounts[0];
const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password, salt, 64).toString("hex");
db.exec("BEGIN IMMEDIATE");
try {
  db.prepare(`
    UPDATE local_accounts
    SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hash, salt, account.id);
  db.prepare(`
    UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND revoked_at IS NULL
  `).run(account.userId);
  db.prepare("DELETE FROM login_attempts WHERE username = ?").run(account.username);
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'auth.local_password_reset', 'user', ?, ?)
  `).run(`audit_${randomUUID()}`, account.userId, account.userId, JSON.stringify({
    username: account.username,
    method: "offline_command",
    sessionsRevoked: true
  }));
  db.exec("COMMIT");
} catch (cause) {
  db.exec("ROLLBACK");
  throw cause;
} finally {
  db.close();
}

console.log(`Local administrator password reset completed for ${account.username}; all sessions were revoked.`);
