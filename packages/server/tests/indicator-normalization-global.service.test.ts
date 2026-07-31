import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  convertUnit,
  indicatorNameCandidates,
  normalizeReportObservations
} from "../services/indicator-normalization.service.ts";

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

test("normalizes English indicator separators consistently", () => {
  assert.deepEqual(
    indicatorNameCandidates("anti_thyroid_peroxidase antibody"),
    indicatorNameCandidates("Anti-thyroid peroxidase antibody")
  );
});

test("normalizes common checkup indicators and keeps ambiguous source types separate", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-common-indicators-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES ('global-user', '用户')").run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('global-member', '本人', 'self', 'global-user')
    `).run();
    db.prepare(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, hospital_name_raw, report_issued_at
      ) VALUES ('common-report', 'global-member', 'global-user', 'checkup', '年度体检', 'ready', '示例体检中心', '2026-07-28')
    `).run();
    const insert = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (?, 'common-report', ?, ?, ?, ?, ?, ?)
    `);
    insert.run("common-sbp", "一般检查", "收缩压", "收缩压", "128", 128, "mmHg");
    insert.run("common-hct", "血常规", "HCT", "红细胞压积", "0.42", 0.42, "L/L");
    insert.run("common-urine-protein-number", "尿常规", "尿蛋白", "尿蛋白", "120", 120, "mg/L");
    insert.run("common-urine-protein-state", "尿常规", "尿蛋白", "尿蛋白", "阴性", null, null);
    insert.run("common-egfr", "肾功能", "eGFR", "估算肾小球滤过率", "98", 98, "mL/min/1.73m²");
    insert.run("common-bun", "肾功能", "BUN", "尿素氮", "14", 14, "mg/dL");
    insert.run("common-urea", "肾功能", "尿素", "尿素", "30", 30, "mg/dL");
    insert.run("common-stool-wbc", "便常规", "白细胞", "白细胞", "-", null, null);
    insert.run("common-urine-wbc", "尿常规 / 尿镜检", "镜检白细胞", "镜检白细胞", "2", 2, "Cell/HP");
    insert.run("common-blood-wbc", "血常规", "白细胞", "白细胞", "5.2", 5.2, "10^9/L");
    insert.run("common-pulse", "一般检查", "心率", "心率", "72", 72, "bpm");
    insert.run("common-ecg-rate", "心电图检查报告单 / 检查描述", "心率", "心率", "73", 73, "bpm");
    insert.run("common-urine-ph", "尿常规", "酸碱度", "酸碱度", "6.0", 6, null);
    insert.run("common-eosinophil-count", "血常规", "嗜酸性粒细胞数", "嗜酸性粒细胞数", "0.2", 0.2, "10^9/L");
    insert.run("common-basophil-count", "血常规", "嗜碱性粒细胞数", "嗜碱性粒细胞数", "0.01", 0.01, "10^9/L");
    insert.run("common-total-t3", "甲状腺功能三项", "三碘甲状腺原氨酸（T3）", "三碘甲状腺原氨酸", "2.56", 2.56, "nmol/L");
    insert.run("common-total-t4", "甲状腺功能三项", "甲状腺素（T4）", "甲状腺素", "109.17", 109.17, "nmol/L");
    insert.run("common-total-psa", "肿瘤标志物", "前列腺特异性抗原", "前列腺特异性抗原", "0.34", 0.34, "ng/mL");
    insert.run("common-abi-right", "动脉功能检查", "右侧踝肱指数", "右侧踝肱指数", "1.07", 1.07, null);
    insert.run("common-abi-left", "动脉功能检查", "左侧踝肱指数", "左侧踝肱指数", "1.08", 1.08, null);
    insert.run("common-bapwv-right", "动脉功能检查", "右侧肱踝脉搏波传导速度", "右侧肱踝脉搏波传导速度", "1315", 1315, "cm/s");
    insert.run("common-bapwv-left", "动脉功能检查", "左侧肱踝脉搏波传导速度", "左侧肱踝脉搏波传导速度", "1395", 1395, "cm/s");

    normalizeReportObservations("common-report");
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        canonical_value AS canonicalValue, canonical_unit AS canonicalUnit, quality
      FROM observation_normalizations
      WHERE observation_id LIKE 'common-%'
    `).all() as Array<{
      observationId: string;
      canonicalKey: string | null;
      canonicalValue: number | null;
      canonicalUnit: string | null;
      quality: string;
    }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));

    assert.equal(byId.get("common-sbp")?.canonicalKey, "vital_systolic_bp");
    assert.equal(byId.get("common-hct")?.canonicalKey, "cbc_hct");
    assert.equal(byId.get("common-hct")?.canonicalValue, 42);
    assert.equal(byId.get("common-hct")?.canonicalUnit, "%");
    assert.equal(byId.get("common-urine-protein-number")?.canonicalKey, "urine_protein_quantitative");
    assert.equal(byId.get("common-urine-protein-number")?.canonicalUnit, "mg/L");
    assert.equal(byId.get("common-urine-protein-state")?.canonicalKey, "urine_protein");
    assert.equal(byId.get("common-urine-protein-state")?.quality, "excluded");
    assert.equal(byId.get("common-egfr")?.canonicalKey, "renal_egfr");
    assert.equal(byId.get("common-bun")?.canonicalKey, "renal_bun");
    assert.ok(Math.abs((byId.get("common-bun")?.canonicalValue || 0) - 4.998) < 0.001);
    assert.equal(byId.get("common-urea")?.canonicalKey, "renal_urea");
    assert.ok(Math.abs((byId.get("common-urea")?.canonicalValue || 0) - 4.995) < 0.001);
    assert.equal(byId.get("common-stool-wbc")?.canonicalKey, "stool_wbc");
    assert.equal(byId.get("common-stool-wbc")?.quality, "excluded");
    assert.equal(byId.get("common-urine-wbc")?.canonicalKey, "urine_wbc");
    assert.equal(byId.get("common-blood-wbc")?.canonicalKey, "cbc_wbc");
    assert.equal(byId.get("common-pulse")?.canonicalKey, "vital_pulse");
    assert.equal(byId.get("common-ecg-rate")?.canonicalKey, "ecg_heart_rate");
    assert.equal(byId.get("common-urine-ph")?.canonicalKey, "urine_ph");
    assert.equal(byId.get("common-eosinophil-count")?.canonicalKey, "cbc_eosinophil_count");
    assert.equal(byId.get("common-basophil-count")?.canonicalKey, "cbc_basophil_count");
    assert.equal(byId.get("common-total-t3")?.canonicalKey, "thyroid_t3_total");
    assert.equal(byId.get("common-total-t4")?.canonicalKey, "thyroid_t4_total");
    assert.equal(byId.get("common-total-psa")?.canonicalKey, "tumor_psa_total");
    assert.equal(byId.get("common-abi-right")?.canonicalKey, "vascular_abi_right");
    assert.equal(byId.get("common-abi-left")?.canonicalKey, "vascular_abi_left");
    assert.equal(byId.get("common-bapwv-right")?.canonicalKey, "vascular_bapwv_right");
    assert.equal(byId.get("common-bapwv-left")?.canonicalKey, "vascular_bapwv_left");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("converts units for newly covered common indicators", () => {
  assert.equal(convertUnit("cbc_mchc", 33, "g/dL", "g/L"), 330);
  assert.ok(Math.abs(convertUnit("glucose_postprandial_2h", 180, "mg/dL", "mmol/L") - 9.99) < 0.01);
  assert.ok(Math.abs(convertUnit("renal_creatinine", 1, "mg/dL", "μmol/L") - 88.4) < 0.001);
  assert.ok(Math.abs(convertUnit("liver_dbil", 1, "mg/dL", "μmol/L") - 17.104) < 0.001);
});
