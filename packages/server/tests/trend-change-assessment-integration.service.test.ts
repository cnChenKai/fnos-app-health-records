import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client";
import { normalizeReportObservations } from "../services/indicator-normalization.service";
import { listTrendSeries } from "../services/records.service";

const manager = {
  id: "trend-change-user",
  displayName: "管理员",
  authenticated: true,
  provider: "development",
  isGatewayAdmin: true,
} as const;

test("trend API separates arithmetic deltas from robust multi-point conclusions", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-trend-change-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('trend-change-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('trend-change-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const insertReport = db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES (?, 'trend-change-member', ?, 'checkup', '趋势回归报告', 'ready', ?)
    `);
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name, result_text,
        numeric_value, unit, reference_low, reference_high, reference_text, evidence_json
      ) VALUES (?, ?, '一般检查', '体重', '体重', ?, ?, 'kg', 40, 120, '40-120', ?)
    `);
    const values = [60, 64, 100, 68, 72];
    for (let index = 0; index < values.length; index += 1) {
      const reportId = `trend-change-report-${index}`;
      const observationId = `trend-change-point-${index}`;
      const date = `${2022 + index}-01-01`;
      insertReport.run(reportId, manager.id, date);
      insertObservation.run(
        observationId,
        reportId,
        `${values[index]} kg`,
        values[index],
        JSON.stringify([{ pageNumber: 1, quote: `体重 ${values[index]} kg` }])
      );
      normalizeReportObservations(reportId);
    }

    const trend = listTrendSeries(manager, "trend-change-member")
      .find((series) => series.indicatorKey === "body_weight");
    assert.ok(trend);
    assert.equal(trend.pointCount, 5, "outliers must not delete original points");
    assert.equal(trend.outlierCount, 1);
    assert.equal(trend.points.find((point) => point.observationId === "trend-change-point-2")?.trendOutlier, true);
    assert.equal(trend.typicalMinValue, 60);
    assert.equal(trend.typicalMaxValue, 72);
    assert.equal(trend.minValue, 60);
    assert.equal(trend.maxValue, 100, "raw extrema remain available for traceability");
    assert.equal(trend.trendStatus, "sustained_rise");
    assert.equal(trend.trendConclusionAllowed, true);
    assert.equal(trend.analysisPointCount, 4);
    assert.equal(trend.latestChangeStatus, "increase");
    assert.equal(trend.latestChangeConclusionAllowed, true);
    assert.equal(trend.latestIntervalBucket, "medium_term");
    assert.equal(trend.delta, 4);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
