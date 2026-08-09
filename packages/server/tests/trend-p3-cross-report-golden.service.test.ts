import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestUser } from "../domain/request-user.ts";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { normalizeReportObservations } from "../services/indicator-normalization.service.ts";
import { listTrendSeries } from "../services/records.service.ts";
import { installRemoteDictionarySnapshotForTests } from "../services/indicator-dictionary.service.ts";

type FixtureObservation = {
  id: string;
  sectionName: string;
  itemName: string;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
};

type FixtureReport = {
  id: string;
  reportType: string;
  title: string;
  reportIssuedAt: string;
  observations: FixtureObservation[];
};

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/p3-cross-report-alias-unit-golden.json", import.meta.url),
  "utf8"
)) as {
  member: { id: string; displayName: string };
  reports: FixtureReport[];
};

const admin: RequestUser = {
  id: "p3-cross-user",
  displayName: "回归管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true
};

test("keeps audited aliases and units isolated across report types", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-cross-report-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    installRemoteDictionarySnapshotForTests();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(admin.id, admin.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES (?, ?, 'self', ?)
    `).run(fixture.member.id, fixture.member.displayName, admin.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `).run(fixture.member.id, admin.id, admin.id);
    const insertReport = db.prepare(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at
      ) VALUES (?, ?, ?, ?, ?, 'ready', ?)
    `);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, result_text, numeric_value, unit
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const report of fixture.reports) {
      insertReport.run(
        report.id,
        fixture.member.id,
        admin.id,
        report.reportType,
        report.title,
        report.reportIssuedAt
      );
      for (const observation of report.observations) {
        insertObservation.run(
          observation.id,
          report.id,
          observation.sectionName,
          observation.itemName,
          observation.resultText,
          observation.numericValue,
          observation.unit
        );
      }
      normalizeReportObservations(report.id);
    }

    const rows = db.prepare(`
      SELECT observation_id AS observationId, canonical_key AS canonicalKey,
        canonical_value AS canonicalValue, canonical_unit AS canonicalUnit, quality
      FROM observation_normalizations
      WHERE observation_id LIKE 'cross-%'
    `).all() as Array<{
      observationId: string;
      canonicalKey: string | null;
      canonicalValue: number | null;
      canonicalUnit: string | null;
      quality: "high" | "medium" | "low" | "excluded";
    }>;
    const byId = new Map(rows.map((row) => [row.observationId, row]));
    assert.equal(rows.length, 19);
    assert.deepEqual(
      rows.reduce<Record<string, number>>((counts, row) => {
        counts[row.quality] = (counts[row.quality] || 0) + 1;
        return counts;
      }, {}),
      { high: 12, medium: 1, low: 6 }
    );

    for (const [observationId, canonicalKey] of [
      ["cross-ldh-iu", "laboratory_ldh"],
      ["cross-ck-u", "laboratory_ck"],
      ["cross-ckmb-activity", "laboratory_ck_mb"],
      ["cross-amylase-u", "laboratory_amylase"]
    ] as const) {
      assert.equal(byId.get(observationId)?.canonicalKey, canonicalKey);
      assert.equal(byId.get(observationId)?.canonicalUnit, "U/L");
      assert.equal(byId.get(observationId)?.quality, "high");
    }

    assert.equal(byId.get("cross-testosterone-ngdl")?.canonicalKey, "laboratory_testosterone");
    assert.equal(byId.get("cross-testosterone-ngdl")?.canonicalUnit, "ng/mL");
    assert.ok(Math.abs((byId.get("cross-testosterone-ngdl")?.canonicalValue || 0) - 4.2) < 1e-9);
    assert.equal(byId.get("cross-testosterone-ngdl")?.quality, "high");

    assert.equal(byId.get("cross-prolactin-ugl")?.canonicalKey, "laboratory_prolactin");
    assert.equal(byId.get("cross-prolactin-ugl")?.canonicalUnit, "ng/mL");
    assert.equal(byId.get("cross-prolactin-ugl")?.canonicalValue, 20);
    assert.equal(byId.get("cross-prolactin-ugl")?.quality, "high");

    for (const observationId of ["cross-pgi-ngml", "cross-pgii-ngml", "cross-pgi-only", "cross-pgii-only"]) {
      assert.equal(byId.get(observationId)?.canonicalUnit, "μg/L");
      assert.equal(byId.get(observationId)?.quality, "high");
    }
    assert.equal(byId.get("cross-pg-ratio-explicit")?.canonicalKey, "laboratory_pepsinogen_ratio");
    assert.equal(byId.get("cross-pg-ratio-explicit")?.canonicalUnit, null);
    assert.equal(byId.get("cross-pg-ratio-explicit")?.quality, "medium");

    assert.equal(byId.get("cross-iop-right-bracket")?.canonicalKey, "ophthalmology_intraocular_pressure_right");
    assert.equal(byId.get("cross-iop-left-bracket")?.canonicalKey, "ophthalmology_intraocular_pressure_left");
    assert.equal(byId.get("cross-iop-right-bracket")?.quality, "high");
    assert.equal(byId.get("cross-iop-left-bracket")?.quality, "high");
    assert.notEqual(
      byId.get("cross-iop-right-bracket")?.canonicalKey,
      byId.get("cross-iop-left-bracket")?.canonicalKey
    );

    for (const observationId of ["cross-ckmb-mass", "cross-prolactin-miu", "cross-testosterone-nmol"]) {
      assert.equal(byId.get(observationId)?.quality, "low");
      assert.equal(byId.get(observationId)?.canonicalValue, null);
      assert.equal(byId.get(observationId)?.canonicalUnit, null);
    }
    for (const observationId of ["cross-iop-unsided", "cross-pathology-pgr", "cross-cardiac-tte"]) {
      assert.equal(byId.get(observationId)?.canonicalKey, null);
      assert.equal(byId.get(observationId)?.quality, "low");
    }

    const trends = listTrendSeries(admin, fixture.member.id);
    const byKey = new Map(trends.map((series) => [series.indicatorKey, series]));
    assert.equal(trends.length, 11);
    assert.equal(trends.reduce((count, series) => count + series.points.length, 0), 13);
    assert.equal(byKey.get("laboratory_ck_mb")?.points.length, 1, "mass and activity CK-MB must not share a trend");
    assert.equal(byKey.get("laboratory_pepsinogen_ratio")?.points.length, 1, "the ratio must not be derived from PGI and PGII");
    assert.equal(byKey.get("laboratory_pepsinogen_i")?.points.length, 2);
    assert.equal(byKey.get("laboratory_pepsinogen_ii")?.points.length, 2);
    assert.equal(byKey.get("ophthalmology_intraocular_pressure_right")?.points.length, 1);
    assert.equal(byKey.get("ophthalmology_intraocular_pressure_left")?.points.length, 1);
    assert.equal(trends.some((series) => series.indicatorKey === "PGR" || series.indicatorKey === "TTE"), false);
    assert.equal(trends.every((series) => series.quality !== "raw"), true);
    assert.equal(
      trends.every((series) => series.comparabilityStatus === "insufficient_evidence"),
      true,
      "golden reports without trusted ranges must remain visible without inventing range drift"
    );
    assert.equal(
      trends.every((series) => series.changeAssessmentAllowed),
      true,
      "missing reference evidence alone must not suppress arithmetic trend values"
    );
    assert.equal(
      trends.every((series) => !series.latestAbnormal),
      true,
      "golden reports without trusted ranges must not invent latest abnormalities"
    );
    assert.equal(
      trends.every((series) => series.attentionPriority === "normal"),
      true,
      "insufficient reference evidence alone must not raise family-facing attention priority"
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
