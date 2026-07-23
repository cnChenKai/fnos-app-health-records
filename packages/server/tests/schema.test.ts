import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { closeDatabaseForTests, getDatabase, getDatabaseStatus } from "../database/client.ts";
import { schemaSql, schemaVersion } from "../database/schema.ts";

test("initializes the health records schema with WAL", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-schema-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((table) => table.name));
    assert.equal(journal.journal_mode, "wal");
    for (const expected of [
      "users", "user_identities", "health_members", "member_permissions", "reports",
      "report_pages", "observations", "processing_jobs", "reminders", "local_accounts",
      "auth_sessions", "audit_logs", "report_extractions", "processing_job_events", "app_notifications",
      "app_upgrade_history"
    ]) {
      assert.equal(names.has(expected), true, `missing table ${expected}`);
    }
    assert.equal(getDatabaseStatus().schemaVersion, schemaVersion);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    assert.equal(getDatabaseStatus().integrity, "ok");
    const migrationRows = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    assert.equal(migrationRows.count, schemaVersion);
    const upgrades = db.prepare("SELECT COUNT(*) AS count FROM app_upgrade_history WHERE status = 'completed'").get() as
      { count: number };
    assert.equal(upgrades.count, 1);
    const reportPageColumns = db.prepare("PRAGMA table_info(report_pages)").all() as Array<{ name: string }>;
    assert.equal(reportPageColumns.some((column) => column.name === "source_page_number"), true);
    assert.equal(reportPageColumns.some((column) => column.name === "source_page_count"), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("migrates an existing v1 database to PDF source page columns", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql
    .replace("  source_page_number INTEGER,\n", "")
    .replace("  source_page_count INTEGER,\n", ""));
  legacy.prepare("INSERT INTO schema_migrations (version) VALUES (1)").run();
  legacy.close();
  process.env.STORAGE_DIR = storageDir;
  try {
    const columns = getDatabase().prepare("PRAGMA table_info(report_pages)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "source_page_number"), true);
    assert.equal(columns.some((column) => column.name === "source_page_count"), true);
    assert.equal(getDatabaseStatus().schemaVersion, schemaVersion);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
    const extractionTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_extractions'
    `).get() as { name: string } | undefined;
    assert.equal(extractionTable?.name, "report_extractions");
    const eventTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'processing_job_events'
    `).get() as { name: string } | undefined;
    assert.equal(eventTable?.name, "processing_job_events");
    const notificationTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_notifications'
    `).get() as { name: string } | undefined;
    assert.equal(notificationTable?.name, "app_notifications");
    const upgradeTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_upgrade_history'
    `).get() as { name: string } | undefined;
    assert.equal(upgradeTable?.name, "app_upgrade_history");
    const upgrades = getDatabase().prepare("SELECT COUNT(*) AS count FROM app_upgrade_history WHERE status = 'completed'").get() as
      { count: number };
    assert.equal(upgrades.count, 1);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
