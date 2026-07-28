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
      ["体重", "握力", "白细胞计数", "丙氨酸氨基转移酶"]
    );
    assert.deepEqual(
      trends.map((item) => [item.groupKey, item.subgroupKey]),
      [
        ["general", null],
        ["surgery", null],
        ["laboratory", "blood"],
        ["laboratory", "liver"]
      ]
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
    { level: null, boundary: null, reason: null, conflict: true }
  );
  assert.deepEqual(
    classifyTrendAttention({ numericValue: 7, referenceLow: 10, referenceHigh: 5, abnormalFlag: null }),
    { level: null, boundary: null, reason: null, conflict: true }
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
