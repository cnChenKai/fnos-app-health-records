import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  runIndicatorDictionaryBackfillIfNeeded,
  runObservationDisplayFlagBackfillIfNeeded
} from "../services/maintenance-runner.service.ts";
import { activeIndicatorNormalizationVersion } from "../services/indicator-normalization.service.ts";

test("backfills stale builtin indicator normalizations once per normalization version", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-indicator-backfill-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES ('backfill-user', '管理员', 1)").run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('backfill-member', '本人', 'self', 'backfill-user')
    `).run();
    db.prepare(`
      INSERT INTO reports (
        id, member_id, title, report_type, status, report_issued_at, created_by
      ) VALUES (
        'backfill-report', 'backfill-member', '历史体检报告', 'checkup', 'ready',
        '2025-01-04', 'backfill-user'
      )
    `).run();
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (
        'backfill-total-cholesterol', 'backfill-report', '生化检验', '总胆固醇',
        '总胆固醇', '4.85 mmol/L', 4.85, 'mmol/L'
      )
    `).run();
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (
        'backfill-ai-custom', 'backfill-report', '专项检查', '自定义数值指标',
        '自定义数值指标', '12.5 ng/mL', 12.5, 'ng/mL'
      )
    `).run();
    db.prepare(`
      INSERT INTO observation_normalizations (
        observation_id, indicator_id, canonical_key, canonical_name, canonical_value, canonical_unit,
        confidence, quality, matched_by, match_reason, excluded_reason, version
      ) VALUES (
        'backfill-ai-custom', NULL, 'ai:numeric:自定义数值指标', '自定义数值指标', 12.5, 'ng/mL',
        0.93, 'high', 'ai_suggestion', '历史 AI 归一化', NULL, 'indicator-normalization-old'
      )
    `).run();
    db.prepare(`
      INSERT INTO app_settings (setting_key, value_json)
      VALUES ('maintenance.indicator_normalization_version', '"old-version"')
    `).run();

    const first = runIndicatorDictionaryBackfillIfNeeded();
    assert.ok(first);
    assert.equal(first.previousVersion, "old-version");
    assert.equal(first.updated, 1);
    assert.equal(first.unmatched, 1);
    const cholesterol = db.prepare(`
      SELECT canonical_key AS canonicalKey, canonical_name AS canonicalName, quality, version
      FROM observation_normalizations WHERE observation_id = 'backfill-total-cholesterol'
    `).get() as { canonicalKey: string; canonicalName: string; quality: string; version: string };
    assert.deepEqual({ ...cholesterol }, {
      canonicalKey: "lipid_tc",
      canonicalName: "总胆固醇",
      quality: "high",
      version: activeIndicatorNormalizationVersion()
    });
    const custom = db.prepare(`
      SELECT canonical_key AS canonicalKey, matched_by AS matchedBy
      FROM observation_normalizations WHERE observation_id = 'backfill-ai-custom'
    `).get() as { canonicalKey: string | null; matchedBy: string };
    assert.deepEqual({ ...custom }, {
      canonicalKey: null,
      matchedBy: "none"
    });
    const storedVersion = db.prepare(`
      SELECT value_json AS valueJson
      FROM app_settings WHERE setting_key = 'maintenance.indicator_normalization_version'
    `).get() as { valueJson: string };
    assert.equal(JSON.parse(storedVersion.valueJson), activeIndicatorNormalizationVersion());
    assert.equal(runIndicatorDictionaryBackfillIfNeeded(), null);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("replaces historical AI splits for common CBC aliases during dictionary backfill", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-cbc-alias-backfill-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES ('cbc-user', '管理员', 1)").run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('cbc-member', '本人', 'self', 'cbc-user')
    `).run();
    db.prepare(`
      INSERT INTO reports (id, member_id, title, report_type, status, report_issued_at, created_by)
      VALUES ('cbc-report', 'cbc-member', '历史血常规', 'laboratory', 'ready', '2025-01-04', 'cbc-user')
    `).run();
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (?, 'cbc-report', '血常规', ?, ?, ?, ?, ?)
    `);
    insertObservation.run("cbc-backfill-neut", "中性粒细胞比率", "中性粒细胞比率", "52.1%", 52.1, "%");
    insertObservation.run("cbc-backfill-wbc", "白细胞数目(WBC)", "白细胞数目(WBC)", "6.2", 6.2, "10^9/L");
    const insertNormalization = db.prepare(`
      INSERT INTO observation_normalizations (
        observation_id, indicator_id, canonical_key, canonical_name, canonical_value, canonical_unit,
        confidence, quality, matched_by, match_reason, excluded_reason, version
      ) VALUES (?, NULL, ?, ?, ?, ?, 0.93, 'high', 'ai_suggestion', '历史 AI 归一化', NULL, 'indicator-normalization-old')
    `);
    insertNormalization.run(
      "cbc-backfill-neut", "ai:numeric:中性粒细胞比率", "中性粒细胞比率", 52.1, "%"
    );
    insertNormalization.run(
      "cbc-backfill-wbc", "ai:numeric:白细胞数目wbc", "白细胞数目(WBC)", 6.2, "10^9/L"
    );
    db.prepare(`
      INSERT INTO user_trend_pins (user_id, member_id, indicator_key, unit_key)
      VALUES
        ('cbc-user', 'cbc-member', 'ai:numeric:中性粒细胞比率', '%'),
        ('cbc-user', 'cbc-member', 'ai:numeric:白细胞数目wbc', '10^9/L')
    `).run();
    db.prepare(`
      INSERT INTO app_settings (setting_key, value_json)
      VALUES ('maintenance.indicator_normalization_version', '"old-version"')
    `).run();

    const result = runIndicatorDictionaryBackfillIfNeeded();
    assert.ok(result);
    assert.equal(result.updated, 2);
    assert.equal(result.pinsMigrated, 2);
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey, canonical_name AS canonicalName,
        matched_by AS matchedBy, version
      FROM observation_normalizations
      ORDER BY observation_id
    `).all() as Array<{
      observationId: string;
      canonicalKey: string;
      canonicalName: string;
      matchedBy: string;
      version: string;
    }>;
    assert.deepEqual(rows.map((row) => ({
      ...row,
      version: row.version === activeIndicatorNormalizationVersion() ? "current" : row.version
    })), [
      {
        observationId: "cbc-backfill-neut",
        canonicalKey: "cbc_neutrophil_percentage",
        canonicalName: "中性粒细胞百分比",
        matchedBy: "builtin_alias",
        version: "current"
      },
      {
        observationId: "cbc-backfill-wbc",
        canonicalKey: "cbc_wbc",
        canonicalName: "白细胞计数",
        matchedBy: "builtin_alias",
        version: "current"
      }
    ]);
    const pins = db.prepare(`
      SELECT indicator_key AS indicatorKey, unit_key AS unitKey
      FROM user_trend_pins
      ORDER BY indicator_key
    `).all() as Array<{ indicatorKey: string; unitKey: string }>;
    assert.deepEqual(pins.map((pin) => ({ ...pin })), [
      { indicatorKey: "cbc_neutrophil_percentage", unitKey: "%" },
      { indicatorKey: "cbc_wbc", unitKey: "10^9/L" }
    ]);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("backfills persisted display abnormal flags once per derivation version", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-display-flag-backfill-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES ('flag-user', '管理员', 1)").run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('flag-member', '本人', 'self', 'flag-user')
    `).run();
    db.prepare(`
      INSERT INTO reports (
        id, member_id, title, report_type, status, report_issued_at, created_by
      ) VALUES (
        'flag-report', 'flag-member', '历史化验单', 'laboratory', 'ready',
        '2025-03-04', 'flag-user'
      )
    `).run();
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, item_name, result_text, numeric_value, unit,
        reference_low, reference_high, abnormal_flag
      ) VALUES (?, 'flag-report', ?, ?, ?, 'mmol/L', 3.9, 6.1, ?)
    `);
    // 原始标记偏高但数值在范围内：读取期判为冲突，计数应排除
    insertObservation.run("obs-conflict", "空腹血糖", "5.0", 5.0, "high");
    // 无原始标记但数值越界：读取期生成计算型偏高，计数应包含
    insertObservation.run("obs-computed", "糖化血红蛋白", "7.2", 7.2, null);
    // 原始标记正常且数值在范围内：不计入异常
    insertObservation.run("obs-normal", "总胆固醇", "5.0", 5.0, "normal");

    const first = runObservationDisplayFlagBackfillIfNeeded();
    assert.ok(first);
    assert.equal(first.recomputed, 3);

    const rows = db.prepare(`
      SELECT id, display_abnormal_flag AS displayFlag, abnormal_conflict AS conflict
      FROM observations ORDER BY id
    `).all() as Array<{ id: string; displayFlag: string | null; conflict: number }>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: "obs-computed", displayFlag: "high", conflict: 0 },
      { id: "obs-conflict", displayFlag: null, conflict: 1 },
      { id: "obs-normal", displayFlag: "normal", conflict: 0 }
    ]);

    const countable = db.prepare(`
      SELECT COUNT(*) AS count FROM observations
      WHERE display_abnormal_flag IN ('high', 'low', 'abnormal') AND abnormal_conflict = 0
    `).get() as { count: number };
    assert.equal(countable.count, 1);

    // 同版本重复执行为空操作
    assert.equal(runObservationDisplayFlagBackfillIfNeeded(), null);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("maintenance recovers timed-out duplicate operations and emits aggregate-only alerts", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-duplicate-operation-recovery-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES ('recovery-user', '管理员', 1)").run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('recovery-member', '恢复测试成员', 'self', 'recovery-user')
    `).run();
    db.prepare(`
      INSERT INTO report_duplicate_operations (
        id, operation, member_id, rule_version, status, purpose, requested_by,
        stats_json, created_at, started_at
      ) VALUES (
        'timed-out-operation', 'recompute', 'recovery-member', 'p2-v2', 'running',
        'timeout_test', 'recovery-user', '{}', '2025-01-01 00:00:00', '2025-01-01 00:00:00'
      )
    `).run();

    const result = await import("../services/maintenance-runner.service.ts")
      .then(({ runMaintenanceCycle }) => runMaintenanceCycle());
    assert.equal(result.skipped, false);
    if (result.skipped) return;
    assert.equal(result.duplicateOperations.recovered, 1);
    const operation = db.prepare(`
      SELECT status, error_message AS errorMessage, stats_json AS statsJson, finished_at AS finishedAt
      FROM report_duplicate_operations WHERE id = 'timed-out-operation'
    `).get() as { status: string; errorMessage: string; statsJson: string; finishedAt: string | null };
    assert.equal(operation.status, "failed");
    assert.equal(operation.errorMessage, "任务超时，已由维护任务回收");
    assert.equal(JSON.parse(operation.statsJson).recoveredByMaintenance, 1);
    assert.ok(operation.finishedAt);

    const notice = db.prepare(`
      SELECT title, message, severity FROM app_notifications
      WHERE member_id = 'recovery-member'
    `).get() as { title: string; message: string; severity: string };
    assert.equal(notice.title, "重复报告治理任务失败");
    assert.equal(notice.severity, "error");
    assert.equal(notice.message.includes("timed-out-operation"), false);
    assert.equal(notice.message.includes("恢复测试成员"), false);
    const audit = db.prepare(`
      SELECT detail_json AS detailJson FROM audit_logs
      WHERE action = 'report.duplicate_operation_failed' AND target_id = 'timed-out-operation'
    `).get() as { detailJson: string };
    assert.deepEqual(JSON.parse(audit.detailJson), {
      operationId: "timed-out-operation",
      memberId: "recovery-member",
      operation: "recompute"
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
