import assert from "node:assert/strict";
import test from "node:test";
import { assessTrendComparability } from "../services/trend-comparability.service";

const trusted = (low: number | null, high: number | null, extra = {}) => ({
  referenceLow: low,
  referenceHigh: high,
  referenceStatus: "trusted" as const,
  ...extra,
});

test("treats stable trusted ranges as comparable", () => {
  const result = assessTrendComparability([trusted(4, 10), trusted(4.1, 10.2)]);
  assert.equal(result.status, "comparable");
  assert.equal(result.comparable, true);
  assert.equal(result.changeAssessmentAllowed, true);
});

test("detects an obvious shifted reference range", () => {
  const result = assessTrendComparability([trusted(4, 10), trusted(6, 12)]);
  assert.equal(result.status, "range_drift");
  assert.equal(result.changeAssessmentAllowed, false);
  assert.match(result.reason || "", /参考范围发生明显变化/);
});

test("allows one-sided and complete ranges when their shared boundary is stable", () => {
  const result = assessTrendComparability([trusted(null, 100), trusted(70, 100)]);
  assert.equal(result.status, "comparable");
});

test("does not report drift when trusted and raw-only ranges are mixed", () => {
  const result = assessTrendComparability([
    trusted(4, 10),
    { referenceLow: null, referenceHigh: null, referenceStatus: "raw_only" as const },
  ]);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.changeAssessmentAllowed, true);
});

test("detects reliable specimen and method changes conservatively", () => {
  const specimen = assessTrendComparability([
    trusted(4, 10, { specimen: "血清" }),
    trusted(4, 10, { specimen: "血浆标本" }),
  ]);
  assert.equal(specimen.status, "condition_mismatch");
  assert.equal(specimen.changeAssessmentAllowed, false);

  const method = assessTrendComparability([
    trusted(4, 10, { method: "己糖激酶法" }),
    trusted(4, 10, { method: "葡萄糖氧化酶法" }),
  ]);
  assert.equal(method.status, "condition_mismatch");
});

test("detects pediatric-to-adult context changes only with reliable dates", () => {
  const result = assessTrendComparability([
    trusted(4, 10, { memberBirthDate: "2008-08-10", reportIssuedAt: "2025-08-01" }),
    trusted(4, 10, { memberBirthDate: "2008-08-10", reportIssuedAt: "2026-08-12" }),
  ]);
  assert.equal(result.status, "condition_mismatch");
  assert.match(result.reason || "", /年龄阶段/);
});

test("uses the latest pair to decide whether an arithmetic delta must be paused", () => {
  const result = assessTrendComparability([
    trusted(4, 10),
    trusted(6, 12),
    trusted(6, 12),
  ]);
  assert.equal(result.status, "range_drift");
  assert.equal(result.latestPairStatus, "comparable");
  assert.equal(result.changeAssessmentAllowed, true);
});
