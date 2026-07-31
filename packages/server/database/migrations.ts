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
  },
  {
    version: 11,
    name: "add_maintenance_tasks",
    checksum: "manual:011-add-maintenance-tasks",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS maintenance_tasks (
          id TEXT PRIMARY KEY,
          task_type TEXT NOT NULL CHECK (task_type IN ('indicator_normalization')),
          mode TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
          status TEXT NOT NULL DEFAULT 'queued' CHECK (
            status IN ('queued', 'running', 'completed', 'failed')
          ),
          requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          total_units INTEGER NOT NULL DEFAULT 0,
          completed_units INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          result_json TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          started_at TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          finished_at TEXT
        );

        CREATE INDEX IF NOT EXISTS maintenance_tasks_recent_idx
          ON maintenance_tasks(task_type, created_at DESC, id DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS maintenance_tasks_active_idx
          ON maintenance_tasks(task_type)
          WHERE status IN ('queued', 'running');
      `);
    }
  },
  {
    version: 12,
    name: "add_user_trend_pins",
    checksum: "manual:012-add-user-trend-pins",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_trend_pins (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
          indicator_key TEXT NOT NULL,
          unit_key TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(user_id, member_id, indicator_key, unit_key)
        );

        CREATE INDEX IF NOT EXISTS user_trend_pins_member_idx
          ON user_trend_pins(user_id, member_id, created_at DESC);
      `);
    }
  },
  {
    version: 13,
    name: "add_trend_indicator_metadata",
    checksum: "manual:013-add-trend-indicator-metadata",
    up: (db) => {
      const columns = tableColumnNames(db, "observation_normalizations");
      if (!columns.has("canonical_category")) {
        db.exec("ALTER TABLE observation_normalizations ADD COLUMN canonical_category TEXT");
      }
      if (!columns.has("canonical_explanation")) {
        db.exec("ALTER TABLE observation_normalizations ADD COLUMN canonical_explanation TEXT");
      }
      db.exec(`
        UPDATE observation_normalizations
        SET
          canonical_category = COALESCE(
            canonical_category,
            (SELECT category FROM indicator_catalog WHERE id = observation_normalizations.indicator_id)
          ),
          canonical_explanation = COALESCE(
            canonical_explanation,
            (SELECT explanation FROM indicator_catalog WHERE id = observation_normalizations.indicator_id)
          )
        WHERE indicator_id IS NOT NULL;
      `);
    }
  },
  {
    version: 14,
    name: "add_ai_managed_indicator_catalog_flag",
    checksum: "manual:014-add-ai-managed-indicator-catalog-flag",
    up: (db) => {
      const columns = tableColumnNames(db, "indicator_catalog");
      if (!columns.has("ai_managed")) {
        db.exec(`
          ALTER TABLE indicator_catalog
          ADD COLUMN ai_managed INTEGER NOT NULL DEFAULT 0 CHECK (ai_managed IN (0, 1))
        `);
      }
    }
  },
  {
    version: 15,
    name: "add_indicator_dictionary_snapshots",
    checksum: "manual:015-add-indicator-dictionary-snapshots",
    up: (db) => {
      ensureIndicatorDictionaryColumns(db);
      db.exec(indicatorDictionarySchemaSql);
    }
  },
  {
    version: 16,
    name: "finalize_indicator_dictionary_morphology_and_ai_units",
    checksum: "manual:016-finalize-indicator-dictionary-morphology-ai-units",
    up: (db) => {
      ensureIndicatorDictionaryColumns(db);
      db.exec(indicatorDictionarySchemaSql);
      db.exec(morphologyFindingSchemaSql);
      db.exec(clinicalFactSchemaSql);
      db.exec(reportStructuredSectionSchemaSql);
      ensureClinicalFactColumns(db);
      db.exec(aiExtractionUnitSchemaSql);
    }
  }
];

export const latestSchemaVersion = databaseMigrations[databaseMigrations.length - 1]?.version ?? 0;

export function tableColumnNames(db: DatabaseSync, tableName: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function ensureIndicatorDictionaryColumns(db: DatabaseSync) {
  const catalogColumns = tableColumnNames(db, "indicator_catalog");
  for (const [name, definition] of [
    ["category_key", "TEXT"],
    ["item_order", "INTEGER"],
    ["observation_kind", "TEXT"],
    ["unit_dimension", "TEXT"],
    ["allowed_units_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["section_hints_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["dictionary_layer", "TEXT"],
    ["dictionary_revision", "INTEGER"],
    ["dictionary_snapshot_id", "TEXT"]
  ] as const) {
    if (!catalogColumns.has(name)) db.exec(`ALTER TABLE indicator_catalog ADD COLUMN ${name} ${definition}`);
  }
  const aliasColumns = tableColumnNames(db, "indicator_aliases");
  for (const [name, definition] of [
    ["dictionary_layer", "TEXT"],
    ["dictionary_revision", "INTEGER"],
    ["dictionary_snapshot_id", "TEXT"]
  ] as const) {
    if (!aliasColumns.has(name)) db.exec(`ALTER TABLE indicator_aliases ADD COLUMN ${name} ${definition}`);
  }
}

export function ensureClinicalFactColumns(db: DatabaseSync) {
  for (const table of [
    "report_diagnoses",
    "report_medications",
    "report_procedures",
    "vaccination_records",
    "billing_summaries",
    "billing_items"
  ]) {
    const columns = tableColumnNames(db, table);
    if (!columns.has("manual_fields_json")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN manual_fields_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!columns.has("is_deleted")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1))`);
    }
  }
}

const internalReportMetadataTokens = new Set([
  "physicalexam",
  "checkup",
  "laboratory",
  "imaging",
  "functional",
  "pathology",
  "outpatient",
  "inpatient",
  "prescription",
  "receipt",
  "billing",
  "vaccine",
  "vaccination",
  "other"
]);

function metadataTokenKey(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLowerCase().replace(/[\s_-]+/g, "")
    : "";
}

function fallbackBodyPart(reportType: string, reportSubtype: string | null) {
  const subtype = reportSubtype && !internalReportMetadataTokens.has(metadataTokenKey(reportSubtype))
    ? reportSubtype.trim()
    : null;
  const value = subtype || ({
    checkup: "综合体检",
    laboratory: "检验项目",
    functional: "功能检查",
    pathology: "病理标本",
    outpatient: "门诊",
    inpatient: "住院",
    prescription: "用药",
    billing: "费用",
    vaccination: "疫苗接种"
  } as Record<string, string>)[reportType];
  return value
    ? [{ raw: value, name: value, parent: null, laterality: "unspecified" }]
    : [];
}

/**
 * Early v16 builds could persist report-type enum values as body parts. Keep this
 * repair idempotent because those builds and the corrected build share schema v16.
 */
export function repairReportDisplayMetadata(db: DatabaseSync) {
  const rows = db.prepare(`
    SELECT id, report_type AS reportType, report_subtype AS reportSubtype,
      body_parts_json AS bodyPartsJson
    FROM reports
    WHERE body_parts_json <> '[]' OR report_subtype IS NOT NULL
  `).all() as Array<{
    id: string;
    reportType: string;
    reportSubtype: string | null;
    bodyPartsJson: string;
  }>;
  const update = db.prepare(`
    UPDATE reports
    SET report_subtype = ?, body_parts_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  let repaired = 0;
  for (const row of rows) {
    let bodyParts: unknown;
    try {
      bodyParts = JSON.parse(row.bodyPartsJson);
    } catch {
      continue;
    }
    if (!Array.isArray(bodyParts)) continue;
    const subtypeIsInternal = internalReportMetadataTokens.has(metadataTokenKey(row.reportSubtype));
    const repairedSubtype = subtypeIsInternal ? null : row.reportSubtype;
    const cleaned = bodyParts.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const part = item as Record<string, unknown>;
      const raw = internalReportMetadataTokens.has(metadataTokenKey(part.raw)) ? null : part.raw;
      const name = internalReportMetadataTokens.has(metadataTokenKey(part.name)) ? null : part.name;
      const displayName = typeof name === "string" && name.trim()
        ? name.trim()
        : typeof raw === "string" && raw.trim() ? raw.trim() : null;
      if (!displayName) return [];
      return [{
        ...part,
        raw: typeof raw === "string" && raw.trim() ? raw.trim() : displayName,
        name: displayName,
        parent: internalReportMetadataTokens.has(metadataTokenKey(part.parent)) ? null : part.parent ?? null
      }];
    });
    const repairedParts = cleaned.length
      ? cleaned
      : bodyParts.length || subtypeIsInternal
        ? fallbackBodyPart(row.reportType, repairedSubtype)
        : [];
    if (
      repairedSubtype === row.reportSubtype
      && JSON.stringify(repairedParts) === JSON.stringify(bodyParts)
    ) continue;
    update.run(repairedSubtype, JSON.stringify(repairedParts), row.id);
    repaired += 1;
  }
  return repaired;
}

export const indicatorDictionarySchemaSql = `
CREATE TABLE IF NOT EXISTS indicator_dictionary_snapshots (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('core', 'remote')),
  revision INTEGER NOT NULL,
  format_version INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  manifest_json TEXT,
  taxonomy_json TEXT NOT NULL,
  indicators_json TEXT NOT NULL,
  source_url TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(layer, revision, content_sha256)
);

CREATE INDEX IF NOT EXISTS indicator_dictionary_snapshots_layer_idx
  ON indicator_dictionary_snapshots(layer, revision DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS indicator_dictionary_state (
  layer TEXT PRIMARY KEY CHECK (layer IN ('core', 'remote')),
  active_snapshot_id TEXT NOT NULL REFERENCES indicator_dictionary_snapshots(id),
  revision INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS indicator_dictionary_updates (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('core_sync', 'remote_update', 'rollback')),
  layer TEXT NOT NULL CHECK (layer IN ('core', 'remote')),
  from_revision INTEGER,
  to_revision INTEGER,
  snapshot_id TEXT REFERENCES indicator_dictionary_snapshots(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  source_url TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS indicator_dictionary_updates_created_idx
  ON indicator_dictionary_updates(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS indicator_taxonomy_groups (
  group_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  description TEXT,
  section_hints_json TEXT NOT NULL DEFAULT '[]',
  dictionary_layer TEXT NOT NULL,
  dictionary_revision INTEGER NOT NULL,
  dictionary_snapshot_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_taxonomy_subgroups (
  subgroup_key TEXT PRIMARY KEY,
  group_key TEXT NOT NULL REFERENCES indicator_taxonomy_groups(group_key) ON DELETE CASCADE,
  name TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  description TEXT,
  section_hints_json TEXT NOT NULL DEFAULT '[]',
  dictionary_layer TEXT NOT NULL,
  dictionary_revision INTEGER NOT NULL,
  dictionary_snapshot_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_taxonomy_categories (
  category_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_key TEXT NOT NULL REFERENCES indicator_taxonomy_groups(group_key) ON DELETE CASCADE,
  subgroup_key TEXT REFERENCES indicator_taxonomy_subgroups(subgroup_key) ON DELETE SET NULL,
  item_order INTEGER NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  section_hints_json TEXT NOT NULL DEFAULT '[]',
  dictionary_layer TEXT NOT NULL,
  dictionary_revision INTEGER NOT NULL,
  dictionary_snapshot_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_unmatched_names (
  fingerprint TEXT PRIMARY KEY,
  normalized_name TEXT NOT NULL,
  raw_name TEXT NOT NULL,
  unit TEXT,
  section_name TEXT,
  sample_result TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  resolved_canonical_key TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS indicator_unmatched_occurrences (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL REFERENCES indicator_unmatched_names(fingerprint) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS indicator_unmatched_occurrences_pool_idx
  ON indicator_unmatched_occurrences(fingerprint, created_at DESC);
`;

export const morphologyFindingSchemaSql = `
CREATE TABLE IF NOT EXISTS morphology_findings (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_name TEXT,
  organ TEXT,
  region TEXT,
  laterality TEXT NOT NULL DEFAULT 'unspecified' CHECK (
    laterality IN ('left', 'right', 'bilateral', 'midline', 'unspecified')
  ),
  finding_type TEXT NOT NULL,
  finding_name TEXT NOT NULL,
  presence TEXT NOT NULL DEFAULT 'present' CHECK (
    presence IN ('present', 'absent', 'uncertain')
  ),
  finding_count INTEGER CHECK (finding_count IS NULL OR finding_count >= 0),
  size_length REAL,
  size_width REAL,
  size_height REAL,
  size_unit TEXT,
  measurements_json TEXT NOT NULL DEFAULT '[]',
  morphology_text TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  classification_system TEXT,
  classification_value TEXT,
  classification_text TEXT,
  comparison_text TEXT,
  raw_text TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  tracking_group_id TEXT,
  match_confidence REAL CHECK (
    match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)
  ),
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS morphology_findings_report_idx
  ON morphology_findings(report_id, section_name, id);
CREATE INDEX IF NOT EXISTS morphology_findings_tracking_idx
  ON morphology_findings(tracking_group_id, report_id)
  WHERE tracking_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS morphology_findings_lookup_idx
  ON morphology_findings(organ, finding_type, laterality, report_id);
`;

export const clinicalFactSchemaSql = `
CREATE TABLE IF NOT EXISTS report_diagnoses (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_name TEXT,
  diagnosis_type TEXT NOT NULL DEFAULT 'other' CHECK (
    diagnosis_type IN ('outpatient', 'admission', 'discharge', 'pathology', 'other')
  ),
  diagnosis_text TEXT NOT NULL,
  diagnosis_code TEXT,
  code_system TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS report_diagnoses_report_idx
  ON report_diagnoses(report_id, diagnosis_type, id);

CREATE TABLE IF NOT EXISTS report_medications (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_name TEXT,
  medication_context TEXT NOT NULL DEFAULT 'other' CHECK (
    medication_context IN ('prescription', 'outpatient', 'inpatient', 'discharge', 'other')
  ),
  medication_name TEXT NOT NULL,
  generic_name TEXT,
  specification TEXT,
  dosage_form TEXT,
  dose TEXT,
  dose_unit TEXT,
  frequency TEXT,
  route TEXT,
  duration TEXT,
  quantity TEXT,
  quantity_unit TEXT,
  instructions TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS report_medications_report_idx
  ON report_medications(report_id, medication_context, id);

CREATE TABLE IF NOT EXISTS report_procedures (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_name TEXT,
  procedure_type TEXT NOT NULL DEFAULT 'other' CHECK (
    procedure_type IN ('examination', 'treatment', 'surgery', 'other')
  ),
  procedure_name TEXT NOT NULL,
  procedure_code TEXT,
  body_part TEXT,
  performed_at TEXT,
  result_text TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS report_procedures_report_idx
  ON report_procedures(report_id, procedure_type, performed_at, id);

CREATE TABLE IF NOT EXISTS vaccination_records (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  vaccine_name TEXT NOT NULL,
  dose_number TEXT,
  manufacturer TEXT,
  lot_number TEXT,
  administered_at TEXT,
  administration_site TEXT,
  next_due_at TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS vaccination_records_report_idx
  ON vaccination_records(report_id, administered_at, id);

CREATE TABLE IF NOT EXISTS billing_summaries (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE REFERENCES reports(id) ON DELETE CASCADE,
  invoice_number TEXT,
  total_amount REAL,
  insurance_amount REAL,
  self_pay_amount REAL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_items (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  category TEXT,
  item_name TEXT NOT NULL,
  amount REAL,
  quantity REAL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS billing_items_report_idx
  ON billing_items(report_id, category, id);
`;

export const reportStructuredSectionSchemaSql = `
CREATE TABLE IF NOT EXISTS report_structured_sections (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  section_title TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_json TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'legacy_migration')),
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS report_structured_sections_report_idx
  ON report_structured_sections(report_id, section_key, id);
`;

export const aiExtractionUnitSchemaSql = `
CREATE TABLE IF NOT EXISTS ai_extraction_units (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  plan_hash TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  unit_index INTEGER NOT NULL,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('complete_pages', 'page_chunk', 'supplement')),
  page_numbers_json TEXT NOT NULL DEFAULT '[]',
  page_ranges_json TEXT NOT NULL DEFAULT '[]',
  input_hash TEXT NOT NULL,
  character_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'processing', 'completed', 'warning', 'failed', 'superseded')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  result_json TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  elapsed_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, unit_key)
);

CREATE INDEX IF NOT EXISTS ai_extraction_units_job_idx
  ON ai_extraction_units(job_id, unit_index, id);
CREATE INDEX IF NOT EXISTS ai_extraction_units_report_idx
  ON ai_extraction_units(report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_extraction_units_status_idx
  ON ai_extraction_units(status, updated_at);

CREATE TABLE IF NOT EXISTS ai_extraction_unit_routes (
  unit_id TEXT PRIMARY KEY REFERENCES ai_extraction_units(id) ON DELETE CASCADE,
  classifier_version TEXT NOT NULL,
  primary_content_type TEXT NOT NULL,
  content_types_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  document_content_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ai_extraction_unit_routes_type_idx
  ON ai_extraction_unit_routes(primary_content_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_extraction_attempts (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES ai_extraction_units(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  attempt_type TEXT NOT NULL CHECK (
    attempt_type IN ('main', 'format_retry', 'split', 'supplement', 'visual')
  ),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  input_characters INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  elapsed_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ai_extraction_attempts_unit_idx
  ON ai_extraction_attempts(unit_id, attempt_number, created_at);
CREATE INDEX IF NOT EXISTS ai_extraction_attempts_report_idx
  ON ai_extraction_attempts(report_id, created_at DESC);
`;
