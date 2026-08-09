import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { normalizeReportObservations } from "../services/indicator-normalization.service.ts";

type GoldenCase = {
  id: string;
  sectionName: string;
  itemName: string;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  expectedCanonicalKey: string | null;
  expectedUnit?: string | null;
  expectedValue?: number;
  expectedQuality?: "high" | "medium" | "low" | "excluded";
  expectedMatchedBy?: string;
  expectedTrendEligible: boolean;
};

const fixture = JSON.parse(readFileSync(
  resolve(new URL(".", import.meta.url).pathname, "fixtures/p3-functional-normalization-golden.json"),
  "utf8"
)) as { cases: GoldenCase[] };

test("normalizes pulmonary function metrics and filters device-only parameters", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-functional-normalization-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES ('functional-user', '匿名用户')").run();
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('functional-member', '匿名成员', 'self', 'functional-user')
    `).run();
    db.prepare(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES ('functional-report', 'functional-member', 'functional-user', 'checkup', '匿名功能检查', 'ready', '2026-08-01')
    `).run();
    const insert = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit
      ) VALUES (?, 'functional-report', ?, ?, ?, ?, ?, ?)
    `);
    for (const item of fixture.cases) {
      insert.run(
        item.id,
        item.sectionName,
        item.itemName,
        item.itemName,
        item.resultText,
        item.numericValue,
        item.unit
      );
    }

    normalizeReportObservations("functional-report");
    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        canonical_value AS canonicalValue, canonical_unit AS canonicalUnit, quality, matched_by AS matchedBy,
        excluded_reason AS excludedReason
      FROM observation_normalizations
      WHERE observation_id IN (${fixture.cases.map(() => "?").join(",")})
    `).all(...fixture.cases.map((item) => item.id)) as Array<{
      observationId: string;
      canonicalKey: string | null;
      canonicalValue: number | null;
      canonicalUnit: string | null;
      quality: "high" | "medium" | "low" | "excluded";
      matchedBy: string;
      excludedReason: string | null;
    }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));

    assert.equal(rows.length, fixture.cases.length);
    for (const expected of fixture.cases) {
      const actual = byId.get(expected.id);
      assert.ok(actual, `missing normalization for ${expected.id}`);
      assert.equal(actual.canonicalKey, expected.expectedCanonicalKey, `${expected.id}: canonical key`);
      if (Object.hasOwn(expected, "expectedUnit")) {
        assert.equal(actual.canonicalUnit, expected.expectedUnit ?? null, `${expected.id}: canonical unit`);
      }
      if (expected.expectedValue !== undefined) {
        assert.ok(actual.canonicalValue !== null, `${expected.id}: canonical value`);
        assert.ok(Math.abs(actual.canonicalValue - expected.expectedValue) < 1e-9, `${expected.id}: converted value`);
      }
      if (expected.expectedQuality) {
        assert.equal(actual.quality, expected.expectedQuality, `${expected.id}: quality`);
      }
      if (expected.expectedMatchedBy) {
        assert.equal(actual.matchedBy, expected.expectedMatchedBy, `${expected.id}: matchedBy`);
      }
      assert.equal(
        actual.quality === "high" || actual.quality === "medium",
        expected.expectedTrendEligible,
        `${expected.id}: trend eligibility`
      );
      if (expected.expectedMatchedBy === "functional_device_filter") {
        assert.ok(actual.excludedReason, `${expected.id}: device exclusion must remain auditable`);
      }
    }

    assert.notEqual(
      byId.get("pulmonary-ratio-g")?.canonicalKey,
      byId.get("pulmonary-ratio-t")?.canonicalKey,
      "Gaensler and Tiffeneau ratios must stay separate"
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
