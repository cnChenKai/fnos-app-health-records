import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  globalIndicatorCatalogForAi,
  indicatorNameCandidates,
  normalizeReportObservations,
  normalizeReportObservationsWithAiFallback,
  type AiIndicatorExecutor
} from "../services/indicator-normalization.service.ts";

function insertReportWithObservation(input: {
  reportId: string;
  observationId: string;
  hospital: string;
  itemName: string;
  unit: string;
  value?: number;
}) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO reports (
      id, member_id, created_by, report_type, title, status, hospital_name_raw, report_issued_at
    ) VALUES (?, 'global-member', 'global-user', 'laboratory', '检验报告', 'ready', ?, '2026-07-28')
  `).run(input.reportId, input.hospital);
  db.prepare(`
    INSERT INTO observations (
      id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
    ) VALUES (?, ?, '血常规', ?, ?, ?, ?, ?)
  `).run(
    input.observationId,
    input.reportId,
    input.itemName,
    input.itemName,
    `${input.value ?? 6.2} ${input.unit}`,
    input.value ?? 6.2,
    input.unit
  );
}

test("splits report codes from names without removing medical qualifiers", () => {
  assert.ok(indicatorNameCandidates("白细胞数目 WBC").includes("白细胞数目"));
  assert.ok(indicatorNameCandidates("WBC-白细胞计数").includes("白细胞计数"));
  assert.ok(indicatorNameCandidates("中性粒细胞比率 NEUT%").includes("中性粒细胞比率"));
  assert.notDeepEqual(
    indicatorNameCandidates("中性粒细胞比率 NEUT%"),
    indicatorNameCandidates("中性粒细胞绝对值 NEUT#")
  );
  assert.notDeepEqual(
    indicatorNameCandidates("全血粘度（高切）"),
    indicatorNameCandidates("全血粘度（低切）")
  );
  assert.notDeepEqual(
    indicatorNameCandidates("空腹血糖"),
    indicatorNameCandidates("餐后血糖")
  );
});

test("reuses one global catalog key across institutions and persists trusted AI aliases", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-global-indicator-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES ('global-user', '用户')").run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('global-member', '本人', 'self', 'global-user')
    `).run();
    insertReportWithObservation({
      reportId: "global-report-a",
      observationId: "global-observation-a",
      hospital: "甲体检中心",
      itemName: "白细胞新称(WBX)",
      unit: "10^9/L"
    });

    let aiCalls = 0;
    const executor: AiIndicatorExecutor = async (input) => {
      aiCalls += 1;
      assert.ok(input.catalogCandidates.some((item) => item.canonicalKey === "cbc_wbc"));
      return {
        provider: "test-ai",
        model: "test-model",
        promptVersion: "test-v4",
        candidates: [{
          observationId: input.items[0].observationId,
          existingCanonicalKey: "cbc_wbc",
          canonicalName: "白细胞计数",
          category: "血常规",
          explanation: "反映血液中的白细胞数量。",
          valueType: "numeric",
          trendEnabled: true,
          canonicalUnit: "10^9/L",
          canonicalValue: 6.2,
          confidence: 0.97,
          reason: "名称和单位与全局白细胞计数一致"
        }],
        rawResponseJson: "{}",
        promptTokens: 10,
        completionTokens: 8,
        elapsedMs: 12
      };
    };
    const first = await normalizeReportObservationsWithAiFallback("global-report-a", null, executor);
    assert.equal(first.ai.applied, 1);
    assert.equal(aiCalls, 1);
    const firstNormalization = db.prepare(`
      SELECT canonical_key AS canonicalKey, canonical_name AS canonicalName, matched_by AS matchedBy
      FROM observation_normalizations WHERE observation_id = 'global-observation-a'
    `).get() as { canonicalKey: string; canonicalName: string; matchedBy: string };
    assert.deepEqual({ ...firstNormalization }, {
      canonicalKey: "cbc_wbc",
      canonicalName: "白细胞计数",
      matchedBy: "ai_catalog"
    });

    insertReportWithObservation({
      reportId: "global-report-b",
      observationId: "global-observation-b",
      hospital: "乙医院健康管理中心",
      itemName: "白细胞新称 WBX",
      unit: "10^9/L",
      value: 6.5
    });
    const second = await normalizeReportObservationsWithAiFallback("global-report-b", null, async () => {
      throw new Error("已学习的全局别名不应再次调用 AI");
    });
    assert.equal(second.ai.skipped, true);
    assert.equal(aiCalls, 1);
    const secondNormalization = db.prepare(`
      SELECT canonical_key AS canonicalKey, canonical_name AS canonicalName
      FROM observation_normalizations WHERE observation_id = 'global-observation-b'
    `).get() as { canonicalKey: string; canonicalName: string };
    assert.deepEqual({ ...secondNormalization }, {
      canonicalKey: "cbc_wbc",
      canonicalName: "白细胞计数"
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("creates only high-confidence global AI indicators and rejects incompatible catalog units", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ai-indicator-catalog-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES ('global-user', '用户')").run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('global-member', '本人', 'self', 'global-user')
    `).run();
    insertReportWithObservation({
      reportId: "new-catalog-report",
      observationId: "new-catalog-observation",
      hospital: "甲医院",
      itemName: "新型生化指标 ABCX",
      unit: "ng/mL",
      value: 12.5
    });
    const highConfidenceExecutor: AiIndicatorExecutor = async (input) => ({
      provider: "test-ai",
      model: "test-model",
      promptVersion: "test-v4",
      candidates: [{
        observationId: input.items[0].observationId,
        existingCanonicalKey: null,
        canonicalName: "新型生化指标",
        category: "其他检验",
        explanation: "用于观察该项生化测量结果随时间的变化。",
        valueType: "numeric",
        trendEnabled: true,
        canonicalUnit: "ng/mL",
        canonicalValue: 12.5,
        confidence: 0.96,
        reason: "未命中目录且指标类型明确"
      }],
      rawResponseJson: "{}",
      promptTokens: 12,
      completionTokens: 9,
      elapsedMs: 15
    });
    const created = await normalizeReportObservationsWithAiFallback(
      "new-catalog-report",
      null,
      highConfidenceExecutor
    );
    assert.equal(created.ai.applied, 1);
    const catalog = db.prepare(`
      SELECT canonical_key AS canonicalKey, source, ai_managed AS aiManaged
      FROM indicator_catalog WHERE display_name = '新型生化指标'
    `).get() as { canonicalKey: string; source: string; aiManaged: number };
    assert.equal(catalog.source, "user");
    assert.equal(catalog.aiManaged, 1);
    assert.ok(globalIndicatorCatalogForAi().some((item) => item.canonicalKey === catalog.canonicalKey));

    insertReportWithObservation({
      reportId: "low-confidence-report",
      observationId: "low-confidence-observation",
      hospital: "乙医院",
      itemName: "无法确认的新指标",
      unit: "U/L"
    });
    const low = await normalizeReportObservationsWithAiFallback("low-confidence-report", null, async (input) => ({
      provider: "test-ai",
      model: "test-model",
      promptVersion: "test-v4",
      candidates: [{
        observationId: input.items[0].observationId,
        existingCanonicalKey: null,
        canonicalName: "无法确认的新指标",
        category: "其他检验",
        explanation: null,
        valueType: "numeric",
        trendEnabled: true,
        canonicalUnit: "U/L",
        canonicalValue: 6.2,
        confidence: 0.85,
        reason: "证据不足"
      }],
      rawResponseJson: "{}",
      promptTokens: 8,
      completionTokens: 5,
      elapsedMs: 9
    }));
    assert.equal(low.ai.applied, 0);
    const lowCatalogCount = db.prepare(`
      SELECT COUNT(*) AS count FROM indicator_catalog WHERE display_name = '无法确认的新指标'
    `).get() as { count: number };
    assert.equal(
      Number(lowCatalogCount.count),
      0
    );

    insertReportWithObservation({
      reportId: "incompatible-report",
      observationId: "incompatible-observation",
      hospital: "丙医院",
      itemName: "白细胞特殊写法",
      unit: "mg/dL"
    });
    const incompatible = await normalizeReportObservationsWithAiFallback("incompatible-report", null, async (input) => ({
      provider: "test-ai",
      model: "test-model",
      promptVersion: "test-v4",
      candidates: [{
        observationId: input.items[0].observationId,
        existingCanonicalKey: "cbc_wbc",
        canonicalName: "白细胞计数",
        category: "血常规",
        explanation: null,
        valueType: "numeric",
        trendEnabled: true,
        canonicalUnit: "10^9/L",
        canonicalValue: 6.2,
        confidence: 0.99,
        reason: "故意返回不兼容单位"
      }],
      rawResponseJson: "{}",
      promptTokens: 8,
      completionTokens: 5,
      elapsedMs: 9
    }));
    assert.equal(incompatible.ai.applied, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
