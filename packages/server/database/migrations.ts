import type { DatabaseSync } from "node:sqlite";

export type DatabaseMigration = {
  version: number;
  name: string;
  checksum: string;
  up: (db: DatabaseSync) => void;
};

export const databaseMigrations: DatabaseMigration[] = [
  {
    version: 1,
    name: "initial_health_records_schema",
    checksum: "manual:001-initial-health-records-schema",
    up: () => {
      throw new Error("Initial schema is applied from schemaSql for new databases.");
    }
  },
  {
    version: 2,
    name: "add_pdf_source_page_columns",
    checksum: "manual:002-add-pdf-source-page-columns",
    up: (db) => {
      const columns = tableColumnNames(db, "report_pages");
      if (!columns.has("source_page_number")) db.exec("ALTER TABLE report_pages ADD COLUMN source_page_number INTEGER");
      if (!columns.has("source_page_count")) db.exec("ALTER TABLE report_pages ADD COLUMN source_page_count INTEGER");
    }
  },
  {
    version: 3,
    name: "add_report_extractions",
    checksum: "manual:003-add-report-extractions",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS report_extractions (
          id TEXT PRIMARY KEY,
          report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
          job_id TEXT NOT NULL UNIQUE REFERENCES processing_jobs(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          fields_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          confidence_json TEXT NOT NULL DEFAULT '{}',
          raw_response_json TEXT NOT NULL,
          input_characters INTEGER NOT NULL DEFAULT 0,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          elapsed_ms INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS report_extractions_report_idx
          ON report_extractions(report_id, created_at DESC);
      `);
    }
  },
  {
    version: 4,
    name: "add_processing_job_events",
    checksum: "manual:004-add-processing-job-events",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS processing_job_events (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
          report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK (
            event_type IN ('queued', 'started', 'completed', 'retry_scheduled', 'failed', 'manual_retry', 'cancelled')
          ),
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          message TEXT,
          detail_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS processing_job_events_job_idx
          ON processing_job_events(job_id, created_at, id);
        CREATE INDEX IF NOT EXISTS processing_job_events_report_idx
          ON processing_job_events(report_id, created_at DESC);
      `);
    }
  },
  {
    version: 5,
    name: "add_app_notifications",
    checksum: "manual:005-add-app-notifications",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_notifications (
          id TEXT PRIMARY KEY,
          member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
          report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
          type TEXT NOT NULL CHECK (type IN ('report_processed', 'report_failed')),
          title TEXT NOT NULL,
          message TEXT,
          severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'error')),
          status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'archived')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          read_at TEXT
        );

        CREATE INDEX IF NOT EXISTS app_notifications_member_idx
          ON app_notifications(member_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS app_notifications_report_idx
          ON app_notifications(report_id, created_at DESC);
      `);
    }
  },
  {
    version: 6,
    name: "add_upgrade_history",
    checksum: "manual:006-add-upgrade-history",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_upgrade_history (
          id TEXT PRIMARY KEY,
          from_app_version TEXT,
          to_app_version TEXT NOT NULL,
          from_schema_version INTEGER NOT NULL,
          to_schema_version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
          message TEXT,
          started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          finished_at TEXT
        );

        CREATE INDEX IF NOT EXISTS app_upgrade_history_started_idx
          ON app_upgrade_history(started_at DESC);
      `);
    }
  },
  {
    version: 7,
    name: "add_indicator_normalization",
    checksum: "manual:007-add-indicator-normalization",
    up: (db) => {
      const ocrColumns = tableColumnNames(db, "ocr_results");
      if (!ocrColumns.has("quality_score")) db.exec("ALTER TABLE ocr_results ADD COLUMN quality_score INTEGER");
      if (!ocrColumns.has("quality_level")) db.exec("ALTER TABLE ocr_results ADD COLUMN quality_level TEXT CHECK (quality_level IS NULL OR quality_level IN ('good', 'weak', 'poor'))");
      if (!ocrColumns.has("quality_reason")) db.exec("ALTER TABLE ocr_results ADD COLUMN quality_reason TEXT");
      if (!ocrColumns.has("text_length")) db.exec("ALTER TABLE ocr_results ADD COLUMN text_length INTEGER");
      db.exec(`
        CREATE TABLE IF NOT EXISTS indicator_catalog (
          id TEXT PRIMARY KEY,
          canonical_key TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          category TEXT NOT NULL,
          specimen TEXT,
          default_unit TEXT,
          value_type TEXT NOT NULL DEFAULT 'numeric' CHECK (value_type IN ('numeric', 'text', 'positive_negative')),
          trend_enabled INTEGER NOT NULL DEFAULT 1 CHECK (trend_enabled IN (0, 1)),
          explanation TEXT,
          source TEXT NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin', 'user')),
          builtin_version TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS indicator_aliases (
          id TEXT PRIMARY KEY,
          indicator_id TEXT NOT NULL REFERENCES indicator_catalog(id) ON DELETE CASCADE,
          alias_name TEXT NOT NULL,
          normalized_alias TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'hospital', 'department', 'report_type')),
          hospital_name TEXT,
          department_name TEXT,
          report_type TEXT,
          source TEXT NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin', 'user', 'ai_suggestion')),
          confidence REAL NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS indicator_aliases_lookup_idx
          ON indicator_aliases(normalized_alias, enabled, scope);

        CREATE TABLE IF NOT EXISTS observation_normalizations (
          observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
          indicator_id TEXT REFERENCES indicator_catalog(id) ON DELETE SET NULL,
          canonical_key TEXT,
          canonical_name TEXT,
          canonical_value REAL,
          canonical_unit TEXT,
          confidence REAL NOT NULL DEFAULT 0,
          quality TEXT NOT NULL CHECK (quality IN ('high', 'medium', 'low', 'excluded')),
          matched_by TEXT NOT NULL,
          match_reason TEXT NOT NULL,
          excluded_reason TEXT,
          version TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS observation_normalizations_trend_idx
          ON observation_normalizations(canonical_key, canonical_unit, quality);

      `);
    }
  },
  {
    version: 8,
    name: "add_ai_audit_events",
    checksum: "manual:008-add-ai-audit-events",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_audit_events (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('indicator_normalization')),
          actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
          target_title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 1,
          provider TEXT,
          model TEXT,
          prompt_version TEXT NOT NULL,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          elapsed_ms INTEGER,
          input_characters INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          detail_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS ai_audit_events_created_idx
          ON ai_audit_events(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS ai_audit_events_report_idx
          ON ai_audit_events(report_id, created_at DESC);
      `);
    }
  },
  {
    version: 9,
    name: "add_report_field_overrides",
    checksum: "manual:009-add-report-field-overrides",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS report_field_overrides (
          id TEXT PRIMARY KEY,
          report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
          field_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(report_id, field_key)
        );

        CREATE INDEX IF NOT EXISTS report_field_overrides_report_idx
          ON report_field_overrides(report_id, updated_at DESC);
      `);
    }
  },
  {
    version: 10,
    name: "add_file_gc_queue",
    checksum: "manual:010-add-file-gc-queue",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_gc_queue (
          id TEXT PRIMARY KEY,
          storage_path TEXT NOT NULL UNIQUE,
          file_kind TEXT NOT NULL CHECK (file_kind IN ('original', 'thumbnail', 'other')),
          reason TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          not_before TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS file_gc_queue_pending_idx
          ON file_gc_queue(completed_at, not_before, created_at);
      `);
    }
  }
];

export const latestSchemaVersion = databaseMigrations[databaseMigrations.length - 1]?.version ?? 0;

export function tableColumnNames(db: DatabaseSync, tableName: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}
