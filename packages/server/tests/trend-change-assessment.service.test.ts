import assert from "node:assert/strict";
import test from "node:test";
import { assessTrendChange } from "../services/trend-change-assessment.service";

function point(observationId: string, numericValue: number, reportIssuedAt: string | null) {
  return { observationId, numericValue, reportIssuedAt };
}

test("keeps a two-point delta arithmetic while withholding a sustained trend conclusion", () => {
  const result = assessTrendChange([
    point("a", 10, "2025-01-01"),
    point("b", 12, "2026-01-01")
  ]);
  assert.equal(result.latestDelta, 2);
  assert.equal(result.latestChangeStatus, "increase");
  assert.equal(result.latestIntervalDays, 365);
  assert.equal(result.trendStatus, "insufficient_evidence");
  assert.equal(result.trendConclusionAllowed, false);
});

test("classifies stable, sustained and fluctuating multi-point numeric patterns", () => {
  const dates = ["2023-01-01", "2024-01-01", "2025-01-01", "2026-01-01"];
  const assess = (values: number[]) => assessTrendChange(values.map((value, index) => point(String(index), value, dates[index])));
  assert.equal(assess([100, 102, 99, 101]).trendStatus, "stable");
  assert.equal(assess([10, 12, 14, 16]).trendStatus, "sustained_rise");
  assert.equal(assess([16, 14, 12, 10]).trendStatus, "sustained_fall");
  assert.equal(assess([10, 15, 11, 16]).trendStatus, "fluctuating");
});

test("describes the latest interval without treating same-day records as a direction conclusion", () => {
  const sameDay = assessTrendChange([
    point("a", 10, "2026-01-01"),
    point("b", 12, "2026-01-01")
  ]);
  assert.equal(sameDay.latestIntervalBucket, "same_day");
  assert.equal(sameDay.latestChangeStatus, "needs_review");
  assert.equal(sameDay.latestChangeConclusionAllowed, false);

  const longTerm = assessTrendChange([
    point("a", 10, "2024-01-01"),
    point("b", 12, "2026-01-02")
  ]);
  assert.equal(longTerm.latestIntervalBucket, "long_term");
  assert.ok((longTerm.latestIntervalDays || 0) > 365);
});

test("detects one isolated value without deleting it or letting it dominate the typical range", () => {
  const result = assessTrendChange([
    point("a", 10, "2022-01-01"),
    point("b", 10.5, "2023-01-01"),
    point("c", 100, "2024-01-01"),
    point("d", 11, "2025-01-01"),
    point("e", 11.5, "2026-01-01")
  ]);
  assert.deepEqual(result.outlierPointIds, ["c"]);
  assert.equal(result.outlierCount, 1);
  assert.equal(result.analysisPointCount, 4);
  assert.equal(result.typicalMinValue, 10);
  assert.equal(result.typicalMaxValue, 11.5);
  assert.equal(result.trendStatus, "sustained_rise");
});

test("pauses direction conclusions when the newest value is an isolated outlier", () => {
  const result = assessTrendChange([
    point("a", 10, "2022-01-01"),
    point("b", 10.2, "2023-01-01"),
    point("c", 10.1, "2024-01-01"),
    point("d", 10.3, "2025-01-01"),
    point("e", 100, "2026-01-01")
  ]);
  assert.equal(result.outlierPointIds.includes("e"), true);
  assert.equal(result.latestChangeStatus, "needs_review");
  assert.equal(result.latestChangeConclusionAllowed, false);
  assert.equal(result.trendStatus, "insufficient_evidence");
});

test("does not let a single extreme third point manufacture a sustained direction", () => {
  const result = assessTrendChange([
    point("a", 10, "2024-01-01"),
    point("b", 11, "2025-01-01"),
    point("c", 100, "2026-01-01")
  ]);
  assert.deepEqual(result.outlierPointIds, ["c"]);
  assert.equal(result.latestChangeStatus, "needs_review");
  assert.equal(result.trendStatus, "insufficient_evidence");
  assert.equal(result.typicalMaxValue, 11);
});

test("known comparison conflicts preserve arithmetic values but pause conclusions", () => {
  const result = assessTrendChange([
    point("a", 10, "2025-01-01"),
    point("b", 12, "2026-01-01")
  ], {
    latestComparisonAllowed: false,
    seriesComparisonAllowed: false,
  });
  assert.equal(result.latestDelta, 2);
  assert.equal(result.latestChangeStatus, "not_comparable");
  assert.equal(result.latestChangeMagnitude, "unavailable");
  assert.equal(result.trendStatus, "insufficient_evidence");
});
