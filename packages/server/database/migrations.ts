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
  }
];

export const latestSchemaVersion = databaseMigrations[databaseMigrations.length - 1]?.version ?? 0;

export function tableColumnNames(db: DatabaseSync, tableName: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}
