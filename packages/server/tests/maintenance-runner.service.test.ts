import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { builtinIndicatorVersion } from "../domain/indicator-dictionary/builtin-indicators.ts";
import { runIndicatorDictionaryBackfillIfNeeded } from "../services/maintenance-runner.service.ts";

test("backfills stale builtin indicator normalizations once per dictionary version", () => {
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
        'backfill-total-cholesterol', 'backfill-report', '生化检验', '血清总胆固醇',
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
      VALUES ('maintenance.indicator_dictionary_version', '"old-version"')
    `).run();

    const first = runIndicatorDictionaryBackfillIfNeeded();
    assert.ok(first);
    assert.equal(first.previousVersion, "old-version");
    assert.equal(first.updated, 1);
    assert.equal(first.preserved, 1);
    const cholesterol = db.prepare(`
      SELECT canonical_key AS canonicalKey, canonical_name AS canonicalName, quality, version
      FROM observation_normalizations WHERE observation_id = 'backfill-total-cholesterol'
    `).get() as { canonicalKey: string; canonicalName: string; quality: string; version: string };
    assert.deepEqual({ ...cholesterol }, {
      canonicalKey: "lipid_tc",
      canonicalName: "总胆固醇",
      quality: "high",
      version: `indicator-normalization-${builtinIndicatorVersion}`
    });
    const custom = db.prepare(`
      SELECT canonical_key AS canonicalKey, matched_by AS matchedBy
      FROM observation_normalizations WHERE observation_id = 'backfill-ai-custom'
    `).get() as { canonicalKey: string; matchedBy: string };
    assert.deepEqual({ ...custom }, {
      canonicalKey: "ai:numeric:自定义数值指标",
      matchedBy: "ai_suggestion"
    });
    const storedVersion = db.prepare(`
      SELECT value_json AS valueJson
      FROM app_settings WHERE setting_key = 'maintenance.indicator_dictionary_version'
    `).get() as { valueJson: string };
    assert.equal(JSON.parse(storedVersion.valueJson), builtinIndicatorVersion);
    assert.equal(runIndicatorDictionaryBackfillIfNeeded(), null);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
