import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { normalizeReportObservations } from "../services/indicator-normalization.service.ts";
import { classifyTrendAttention, listTrendSeries } from "../services/records.service.ts";
import { matchTrendSearch } from "../../ui/src/utils/trends.ts";

const manager: RequestUser = {
  id: "trend-catalog-user",
  displayName: "趋势测试用户",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: false
};

test("sorts trends by the standard checkup catalog and keeps search aliases trusted", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-catalog-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('trend-catalog-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-catalog-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const insertReport = db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES (?, 'trend-catalog-member', ?, ?, ?, 'ready', ?)
    `);
    insertReport.run("trend-general-old", manager.id, "checkup", "基础检查", "2024-01-01");
    insertReport.run("trend-surgery-middle", manager.id, "checkup", "外科检查", "2025-01-01");
    insertReport.run("trend-lab-new", manager.id, "laboratory", "检验报告", "2026-01-01");
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, reference_text, abnormal_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertObservation.run(
      "trend-weight", "trend-general-old", "一般检查", "体重", "体重",
      "70 kg", 70, "kg", 45, 85, "45-85", "normal"
    );
    insertObservation.run(
      "trend-grip", "trend-surgery-middle", "外科检查", "握力", "握力",
      "35 kg", 35, "kg", null, null, null, null
    );
    insertObservation.run(
      "trend-wbc", "trend-lab-new", "血常规", "白细胞计数", "白细胞计数",
      "6.2", 6.2, "10^9/L", 4, 10, "4-10", "normal"
    );
    insertObservation.run(
      "trend-wbc-wrong-source", "trend-lab-new", "血常规", "囊肿误合并名称", "囊肿误合并名称",
      "6.1", 6.1, "10^9/L", 4, 10, "4-10", "normal"
    );
    insertObservation.run(
      "trend-alt", "trend-lab-new", "肝功能", "ALT", "ALT",
      "25", 25, "U/L", 9, 50, "9-50", "normal"
    );

    normalizeReportObservations("trend-general-old");
    normalizeReportObservations("trend-surgery-middle");
    normalizeReportObservations("trend-lab-new");
    const wbcCatalog = db.prepare(`
      SELECT id, explanation FROM indicator_catalog WHERE canonical_key = 'cbc_wbc'
    `).get() as { id: string; explanation: string };
    db.prepare(`
      UPDATE observation_normalizations
      SET indicator_id = ?, canonical_key = 'cbc_wbc', canonical_name = '白细胞计数',
        canonical_value = 6.1, canonical_unit = '10^9/L', canonical_category = '血常规',
        canonical_explanation = ?, confidence = 0.95, quality = 'high',
        matched_by = 'ai_suggestion', match_reason = '历史误合并示例', excluded_reason = NULL
      WHERE observation_id = 'trend-wbc-wrong-source'
    `).run(wbcCatalog.id, wbcCatalog.explanation);

    const trends = listTrendSeries(manager, "trend-catalog-member");
    assert.deepEqual(
      trends.map((item) => item.name),
      ["体重", "白细胞计数", "丙氨酸氨基转移酶"]
    );
    assert.deepEqual(
      trends.map((item) => [item.groupKey, item.subgroupKey]),
      [
        ["general", null],
        ["laboratory", "blood"],
        ["laboratory", "liver"]
      ]
    );
    assert.equal(
      trends.some((item) => item.name === "握力"),
      false,
      "未命中字典的 raw 指标不得进入默认趋势"
    );
    const wbc = trends.find((item) => item.name === "白细胞计数");
    assert.ok(wbc);
    assert.equal(wbc.sourceNames.includes("囊肿误合并名称"), true);
    assert.equal(wbc.searchAliases.includes("囊肿误合并名称"), false);
    assert.equal(matchTrendSearch(wbc, "囊肿").matches, false);
    assert.equal(matchTrendSearch(wbc, "白血球").matches, true);
    assert.equal(matchTrendSearch(wbc, "白血球").alias, "白血球");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("merges common white blood cell and neutrophil percentage name variants", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-cbc-aliases-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('trend-cbc-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-cbc-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const insertReport = db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES (?, 'trend-cbc-member', ?, 'laboratory', '血常规', 'ready', ?)
    `);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, reference_text
      ) VALUES (?, ?, '血常规', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const cases = [
      ["cbc-alias-report-1", "2023-01-01", "cbc-neut-rate", "中性粒细胞比率", "52.1", 52.1, "%", 40, 75, "40-75"],
      ["cbc-alias-report-2", "2024-01-01", "cbc-neut-percent", "中性粒细胞百分比", "53.2", 53.2, "%", 40, 75, "40-75"],
      ["cbc-alias-report-3", "2025-01-01", "cbc-wbc-count", "白细胞数目", "6.2", 6.2, "10^9/L", 4, 10, "4-10"],
      ["cbc-alias-report-4", "2026-01-01", "cbc-wbc-code", "白细胞数目(WBC)", "6.4", 6.4, "10^9/L", 4, 10, "4-10"]
    ] as const;
    for (const [reportId, date, observationId, name, result, value, unit, low, high, reference] of cases) {
      insertReport.run(reportId, manager.id, date);
      insertObservation.run(observationId, reportId, name, name, result, value, unit, low, high, reference);
      normalizeReportObservations(reportId);
    }

    const normalizations = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey
      FROM observation_normalizations
      ORDER BY observation_id
    `).all() as Array<{ observationId: string; canonicalKey: string }>;
    assert.deepEqual(normalizations.map((row) => [row.observationId, row.canonicalKey]), [
      ["cbc-neut-percent", "cbc_neutrophil_percentage"],
      ["cbc-neut-rate", "cbc_neutrophil_percentage"],
      ["cbc-wbc-code", "cbc_wbc"],
      ["cbc-wbc-count", "cbc_wbc"]
    ]);

    const trends = listTrendSeries(manager, "trend-cbc-member");
    assert.deepEqual(trends.map((item) => [item.name, item.pointCount]), [
      ["白细胞计数", 2],
      ["中性粒细胞百分比", 2]
    ]);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("converts numeric reference bounds with canonical trend units and hides stale raw range text", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-reference-units-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('trend-reference-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-reference-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES ('trend-reference-report', 'trend-reference-member', ?, 'laboratory', '检验报告', 'ready', '2026-08-01')
    `).run(manager.id);
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, reference_text
      ) VALUES (
        'trend-reference-glucose', 'trend-reference-report', '生化检验', '空腹血糖', '空腹血糖', '90',
        90, 'mg/dL', 70, 100, '70-100 mg/dL'
      )
    `).run();

    normalizeReportObservations('trend-reference-report');
    const trend = listTrendSeries(manager, 'trend-reference-member').find((item) => item.indicatorKey === 'glucose_fasting');
    assert.ok(trend);
    assert.equal(trend.unit, 'mmol/L');
    assert.ok(Math.abs(trend.points[0].referenceLow! - (70 / 18.018)) < 0.000001);
    assert.ok(Math.abs(trend.points[0].referenceHigh! - (100 / 18.018)) < 0.000001);
    assert.equal(trend.points[0].referenceText, null);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps unsafe stored reference text but excludes its bounds from trends and attention", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-reference-trust-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('trend-reference-trust-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-reference-trust-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const insertReport = db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES (?, 'trend-reference-trust-member', ?, 'checkup', ?, 'ready', ?)
    `);
    insertReport.run('trend-reference-one-sided-report', manager.id, '单侧范围', '2026-07-01');
    insertReport.run('trend-reference-reversed-report', manager.id, '反向范围', '2026-07-02');
    insertReport.run('trend-reference-unsafe-report', manager.id, '非参考列范围', '2026-07-03');
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, reference_text, evidence_json
      ) VALUES (?, ?, '一般检查', '体重', '体重', '70 kg', 70, 'kg', ?, ?, ?, '[]')
    `);
    insertObservation.run('trend-reference-one-sided', 'trend-reference-one-sided-report', null, 75, '≤75');
    insertObservation.run('trend-reference-reversed', 'trend-reference-reversed-report', 80, 50, '80-50');
    insertObservation.run('trend-reference-unsafe', 'trend-reference-unsafe-report', 50, 80, '预测范围 50-80');
    const insertNormalization = db.prepare(`
      INSERT INTO observation_normalizations (
        observation_id, canonical_key, canonical_name, canonical_value, canonical_unit,
        confidence, quality, matched_by, match_reason, version
      ) VALUES (?, 'body_weight', '体重', 70, 'kg', 1, 'high', 'dictionary', '测试标准映射', 'reference-trust-v1')
    `);
    insertNormalization.run('trend-reference-one-sided');
    insertNormalization.run('trend-reference-reversed');
    insertNormalization.run('trend-reference-unsafe');

    const trend = listTrendSeries(manager, 'trend-reference-trust-member')
      .find((item) => item.indicatorKey === 'body_weight');
    assert.ok(trend);
    assert.equal(trend.pointCount, 3);
    const oneSided = trend.points.find((point) => point.observationId === 'trend-reference-one-sided');
    const reversed = trend.points.find((point) => point.observationId === 'trend-reference-reversed');
    const unsafe = trend.points.find((point) => point.observationId === 'trend-reference-unsafe');
    assert.ok(oneSided);
    assert.equal(oneSided.referenceLow, null);
    assert.equal(oneSided.referenceHigh, 75);
    assert.equal(oneSided.referenceText, '≤75');
    assert.ok(reversed);
    assert.equal(reversed.referenceLow, null);
    assert.equal(reversed.referenceHigh, null);
    assert.equal(reversed.referenceText, '80-50');
    assert.ok(unsafe);
    assert.equal(unsafe.referenceLow, null);
    assert.equal(unsafe.referenceHigh, null);
    assert.equal(unsafe.referenceText, '预测范围 50-80');
    assert.equal(trend.attentionLevel, null);
    assert.equal(trend.attentionConflict, false);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps conflict-safe interpretation on every trend point, including historical points", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-abnormal-conflict-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('trend-abnormal-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-abnormal-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const insertReport = db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES (?, 'trend-abnormal-member', ?, 'laboratory', '检验报告', 'ready', ?)
    `);
    insertReport.run('trend-abnormal-old', manager.id, '2025-08-01');
    insertReport.run('trend-abnormal-new', manager.id, '2026-08-01');
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, reference_text, abnormal_flag
      ) VALUES (?, ?, '血常规', '白细胞计数', '白细胞计数', ?, ?, '10^9/L', 4, 10, '4-10', ?)
    `);
    insertObservation.run('trend-abnormal-old-point', 'trend-abnormal-old', '7', 7, 'high');
    insertObservation.run('trend-abnormal-new-point', 'trend-abnormal-new', '11', 11, null);
    normalizeReportObservations('trend-abnormal-old');
    normalizeReportObservations('trend-abnormal-new');

    const trend = listTrendSeries(manager, 'trend-abnormal-member').find((item) => item.indicatorKey === 'cbc_wbc');
    assert.ok(trend);
    const historical = trend.points.find((point) => point.observationId === 'trend-abnormal-old-point');
    const latest = trend.points.find((point) => point.observationId === 'trend-abnormal-new-point');
    assert.ok(historical);
    assert.equal(historical.reportedAbnormalFlag, 'high');
    assert.equal(historical.displayAbnormalFlag, null);
    assert.equal(historical.abnormalConflict, true);
    assert.equal(historical.abnormalStatus, 'conflict');
    assert.ok(latest);
    assert.equal(latest.reportedAbnormalFlag, null);
    assert.equal(latest.displayAbnormalFlag, 'high');
    assert.equal(latest.abnormalSource, 'reference_range');
    assert.equal(latest.abnormalStatus, 'computed');
    assert.equal(trend.attentionLevel, 'abnormal');
    assert.equal(trend.attentionConflict, false);
    assert.equal(trend.attentionReason, '数值高于报告参考上限');
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});


test("classifies persistent abnormality and recovery across governed historical points", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-abnormal-continuity-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('trend-continuity-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-continuity-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const insertReport = db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES (?, 'trend-continuity-member', ?, 'laboratory', '检验报告', 'ready', ?)
    `);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, reference_text, abnormal_flag
      ) VALUES (?, ?, '血常规', '白细胞计数', '白细胞计数', ?, ?, '10^9/L', 4, 10, '4-10', ?)
    `);

    insertReport.run('trend-continuity-1', manager.id, '2024-08-01');
    insertObservation.run('trend-continuity-point-1', 'trend-continuity-1', '11', 11, 'high');
    insertReport.run('trend-continuity-2', manager.id, '2025-08-01');
    insertObservation.run('trend-continuity-point-2', 'trend-continuity-2', '12', 12, 'high');
    normalizeReportObservations('trend-continuity-1');
    normalizeReportObservations('trend-continuity-2');

    let trend = listTrendSeries(manager, 'trend-continuity-member').find((item) => item.indicatorKey === 'cbc_wbc');
    assert.ok(trend);
    assert.equal(trend.abnormalContinuityStatus, 'persistent_abnormal');
    assert.equal(trend.consecutiveAbnormalCount, 2);
    assert.equal(trend.totalAbnormalCount, 2);
    assert.equal(trend.latestAbnormalDirection, 'high');
    assert.equal(trend.attentionPriority, 'attention');

    insertReport.run('trend-continuity-3', manager.id, '2026-08-01');
    insertObservation.run('trend-continuity-point-3', 'trend-continuity-3', '7', 7, null);
    normalizeReportObservations('trend-continuity-3');

    trend = listTrendSeries(manager, 'trend-continuity-member').find((item) => item.indicatorKey === 'cbc_wbc');
    assert.ok(trend);
    assert.equal(trend.abnormalContinuityStatus, 'recovered');
    assert.equal(trend.recoveredFromAbnormal, true);
    assert.equal(trend.previousAbnormalCount, 2);
    assert.equal(trend.consecutiveAbnormalCount, 0);
    assert.equal(trend.latestAbnormal, false);
    assert.equal(trend.attentionLevel, null, 'historical abnormality must not keep the latest card in abnormal state');
    assert.equal(trend.attentionPriority, 'notice');
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("classifies only explicit, computed, or near-boundary latest values for attention", () => {
  assert.deepEqual(
    classifyTrendAttention({ numericValue: 11, referenceLow: 4, referenceHigh: 10, abnormalFlag: "high" }),
    { level: "abnormal", boundary: "upper", reason: "原报告标记偏高", conflict: false }
  );
  assert.equal(
    classifyTrendAttention({ numericValue: 11, referenceLow: 4, referenceHigh: 10, abnormalFlag: null }).level,
    "abnormal"
  );
  assert.equal(
    classifyTrendAttention({ numericValue: 9.5, referenceLow: 4, referenceHigh: 10, abnormalFlag: "normal" }).level,
    "near_boundary"
  );
  assert.deepEqual(
    classifyTrendAttention({ numericValue: 11, referenceLow: 4, referenceHigh: 10, abnormalFlag: "normal" }),
    { level: null, boundary: null, reason: "原报告正常标记与数值及参考范围不一致，已暂停自动判定", conflict: true }
  );
  assert.deepEqual(
    classifyTrendAttention({ numericValue: 7, referenceLow: 10, referenceHigh: 5, abnormalFlag: null }),
    { level: null, boundary: null, reason: "报告参考范围上下界无效，暂不判定", conflict: true }
  );
  assert.deepEqual(
    classifyTrendAttention({ numericValue: 7, referenceLow: 4, referenceHigh: 10, abnormalFlag: "high" }),
    { level: null, boundary: null, reason: "原报告异常方向与数值及参考范围不一致，已暂停自动判定", conflict: true }
  );
  assert.deepEqual(
    classifyTrendAttention({ numericValue: 7, referenceLow: 4, referenceHigh: 10, abnormalFlag: "low" }),
    { level: null, boundary: null, reason: "原报告异常方向与数值及参考范围不一致，已暂停自动判定", conflict: true }
  );
  assert.equal(
    classifyTrendAttention({ numericValue: 9.2, referenceLow: null, referenceHigh: 10, abnormalFlag: null }).level,
    "near_boundary"
  );
  assert.equal(
    classifyTrendAttention({ numericValue: 5, referenceLow: null, referenceHigh: null, abnormalFlag: null }).level,
    null
  );
});
