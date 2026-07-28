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
      "app_upgrade_history", "indicator_catalog", "indicator_aliases", "observation_normalizations",
      "ai_audit_events", "report_field_overrides", "file_gc_queue", "maintenance_tasks",
      "user_trend_pins"
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
    const normalizationColumns = db.prepare("PRAGMA table_info(observation_normalizations)").all() as Array<{ name: string }>;
    assert.equal(normalizationColumns.some((column) => column.name === "canonical_category"), true);
    assert.equal(normalizationColumns.some((column) => column.name === "canonical_explanation"), true);
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
    const aiAuditTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_audit_events'
    `).get() as { name: string } | undefined;
    assert.equal(aiAuditTable?.name, "ai_audit_events");
    const overridesTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_field_overrides'
    `).get() as { name: string } | undefined;
    assert.equal(overridesTable?.name, "report_field_overrides");
    const fileGcTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_gc_queue'
    `).get() as { name: string } | undefined;
    assert.equal(fileGcTable?.name, "file_gc_queue");
    const maintenanceTaskTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_tasks'
    `).get() as { name: string } | undefined;
    assert.equal(maintenanceTaskTable?.name, "maintenance_tasks");
    const trendPinsTable = getDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_trend_pins'
    `).get() as { name: string } | undefined;
    assert.equal(trendPinsTable?.name, "user_trend_pins");
    const normalizationColumns = getDatabase().prepare("PRAGMA table_info(observation_normalizations)").all() as Array<{ name: string }>;
    assert.equal(normalizationColumns.some((column) => column.name === "canonical_category"), true);
    assert.equal(normalizationColumns.some((column) => column.name === "canonical_explanation"), true);
    const upgrades = getDatabase().prepare("SELECT COUNT(*) AS count FROM app_upgrade_history WHERE status = 'completed'").get() as
      { count: number };
    assert.equal(upgrades.count, 1);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("migrates a v12 normalization row through the latest trend metadata schema", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-v13-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql
    .replace("  canonical_category TEXT,\n", "")
    .replace("  canonical_explanation TEXT,\n", ""));
  for (let version = 1; version <= 12; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.prepare("INSERT INTO users (id, display_name) VALUES ('user-v12', '旧用户')").run();
  legacy.prepare(`
    INSERT INTO health_members (id, display_name, created_by)
    VALUES ('member-v12', '旧成员', 'user-v12')
  `).run();
  legacy.prepare(`
    INSERT INTO reports (id, member_id, created_by, report_type, title, status)
    VALUES ('report-v12', 'member-v12', 'user-v12', 'laboratory', '旧报告', 'ready')
  `).run();
  legacy.prepare(`
    INSERT INTO observations (id, report_id, item_name, result_text, numeric_value, unit)
    VALUES ('observation-v12', 'report-v12', '空腹血糖', '5.2', 5.2, 'mmol/L')
  `).run();
  legacy.prepare(`
    INSERT INTO indicator_catalog (
      id, canonical_key, display_name, category, default_unit, explanation
    ) VALUES (
      'indicator-v12', 'glucose_fasting', '空腹血糖', '血糖', 'mmol/L', '用于观察空腹状态下血糖变化。'
    )
  `).run();
  legacy.prepare(`
    INSERT INTO observation_normalizations (
      observation_id, indicator_id, canonical_key, canonical_name, canonical_value,
      canonical_unit, confidence, quality, matched_by, match_reason, version
    ) VALUES (
      'observation-v12', 'indicator-v12', 'glucose_fasting', '空腹血糖', 5.2,
      'mmol/L', 1, 'high', 'builtin_alias', '旧版整理', 'indicator-normalization-old'
    )
  `).run();
  legacy.close();
  process.env.STORAGE_DIR = storageDir;
  try {
    const row = getDatabase().prepare(`
      SELECT canonical_category AS category, canonical_explanation AS explanation
      FROM observation_normalizations WHERE observation_id = 'observation-v12'
    `).get() as { category: string | null; explanation: string | null };
    assert.equal(row.category, "血糖");
    assert.equal(row.explanation, "用于观察空腹状态下血糖变化。");
    assert.equal(getDatabaseStatus().appliedSchemaVersion, schemaVersion);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("migrates a v13 indicator catalog to the v14 AI managed schema", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-migration-v14-"));
  const databasePath = join(storageDir, "db", "health-records.sqlite");
  mkdirSync(join(storageDir, "db"), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(schemaSql.replace(
    "  ai_managed INTEGER NOT NULL DEFAULT 0 CHECK (ai_managed IN (0, 1)),\n",
    ""
  ));
  for (let version = 1; version <= 13; version += 1) {
    legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  legacy.prepare(`
    INSERT INTO indicator_catalog (
      id, canonical_key, display_name, category, source
    ) VALUES ('indicator-v13', 'legacy_metric', '旧指标', '其他检查', 'user')
  `).run();
  legacy.close();
  process.env.STORAGE_DIR = storageDir;
  try {
    const row = getDatabase().prepare(`
      SELECT ai_managed AS aiManaged
      FROM indicator_catalog WHERE id = 'indicator-v13'
    `).get() as { aiManaged: number };
    assert.equal(row.aiManaged, 0);
    assert.equal(getDatabaseStatus().appliedSchemaVersion, 14);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
