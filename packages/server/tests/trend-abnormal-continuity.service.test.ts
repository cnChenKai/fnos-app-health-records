import assert from "node:assert/strict";
import test from "node:test";
import { assessTrendAbnormalContinuity } from "../services/trend-abnormal-continuity.service.ts";

function point(
  displayAbnormalFlag: "high" | "low" | "abnormal" | "normal" | null,
  overrides: Partial<Parameters<typeof assessTrendAbnormalContinuity>[0][number]> = {},
) {
  return {
    numericValue: 5,
    referenceLow: 4,
    referenceHigh: 10,
    referenceStatus: "trusted" as const,
    displayAbnormalFlag,
    abnormalStatus: displayAbnormalFlag ? "reported" as const : "unresolved" as const,
    abnormalConflict: false,
    ...overrides,
  };
}

test("distinguishes a latest-only abnormal result from persistent abnormality", () => {
  const latestOnly = assessTrendAbnormalContinuity([
    point("normal"),
    point("high", { numericValue: 11 }),
  ]);
  assert.equal(latestOnly.status, "latest_abnormal");
  assert.equal(latestOnly.consecutiveAbnormalCount, 1);
  assert.equal(latestOnly.totalAbnormalCount, 1);
  assert.equal(latestOnly.attentionPriority, "attention");

  const persistent = assessTrendAbnormalContinuity([
    point("normal"),
    point("high", { numericValue: 11 }),
    point("high", { numericValue: 12 }),
  ]);
  assert.equal(persistent.status, "persistent_abnormal");
  assert.equal(persistent.consecutiveAbnormalCount, 2);
  assert.equal(persistent.latestDirection, "high");
  assert.match(persistent.reason || "", /连续 2 次/);
});

test("keeps continuous abnormality when direction changes without calling it improvement or worsening", () => {
  const result = assessTrendAbnormalContinuity([
    point("high", { numericValue: 11 }),
    point("low", { numericValue: 3 }),
  ]);
  assert.equal(result.status, "persistent_abnormal");
  assert.equal(result.consecutiveAbnormalCount, 2);
  assert.match(result.reason || "", /方向有变化/);
  assert.doesNotMatch(result.reason || "", /改善|恶化|变好|变差/);
});

test("marks a reliable latest normal result as recovered from historical abnormality", () => {
  const result = assessTrendAbnormalContinuity([
    point("high", { numericValue: 11 }),
    point(null, { numericValue: 7 }),
  ]);
  assert.equal(result.status, "recovered");
  assert.equal(result.latestDirection, "normal");
  assert.equal(result.recoveredFromAbnormal, true);
  assert.equal(result.previousAbnormalCount, 1);
  assert.equal(result.attentionPriority, "notice");
});

test("does not claim recovery when the latest point lacks a trusted range", () => {
  const result = assessTrendAbnormalContinuity([
    point("high", { numericValue: 11 }),
    point(null, {
      numericValue: 7,
      referenceLow: null,
      referenceHigh: null,
      referenceStatus: "missing",
    }),
  ]);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.recoveredFromAbnormal, false);
  assert.equal(result.attentionPriority, "notice");
});

test("excludes conflicts from reliable abnormal and normal counts", () => {
  const result = assessTrendAbnormalContinuity([
    point("high", { numericValue: 11 }),
    point(null, {
      abnormalStatus: "conflict",
      abnormalConflict: true,
    }),
  ]);
  assert.equal(result.status, "conflict");
  assert.equal(result.latestDirection, "unknown");
  assert.equal(result.totalAbnormalCount, 1);
  assert.equal(result.conflictPointCount, 1);
  assert.equal(result.consecutiveAbnormalCount, 0);
});

test("keeps near-boundary as a notice only when no recovery status takes precedence", () => {
  const nearBoundary = assessTrendAbnormalContinuity([
    point(null, { numericValue: 9.5 }),
  ], { latestNearBoundary: true });
  assert.equal(nearBoundary.status, "near_boundary");
  assert.equal(nearBoundary.attentionPriority, "notice");

  const recovered = assessTrendAbnormalContinuity([
    point("high", { numericValue: 11 }),
    point(null, { numericValue: 9.5 }),
  ], { latestNearBoundary: true });
  assert.equal(recovered.status, "recovered");
});

test("does not let an old isolated abnormal keep a later reliable normal series in high attention", () => {
  const result = assessTrendAbnormalContinuity([
    point("high", { numericValue: 11 }),
    point("normal"),
    point("normal"),
  ]);
  assert.equal(result.status, "recovered");
  assert.equal(result.attentionPriority, "notice");
  assert.equal(result.latestAbnormal, false);
  assert.equal(result.consecutiveAbnormalCount, 0);
});


test("does not treat a historical conflict as a recovered abnormality", () => {
  const result = assessTrendAbnormalContinuity([
    point(null, {
      abnormalStatus: "conflict",
      abnormalConflict: true,
    }),
    point("normal"),
  ]);
  assert.equal(result.status, "none");
  assert.equal(result.previousAbnormalCount, 0);
  assert.equal(result.conflictPointCount, 1);
  assert.equal(result.recoveredFromAbnormal, false);
  assert.equal(result.attentionPriority, "normal");
});

test("lets a conflict interrupt the consecutive abnormal chain", () => {
  const result = assessTrendAbnormalContinuity([
    point("high", { numericValue: 11 }),
    point(null, {
      abnormalStatus: "conflict",
      abnormalConflict: true,
    }),
    point("high", { numericValue: 12 }),
  ]);
  assert.equal(result.status, "latest_abnormal");
  assert.equal(result.totalAbnormalCount, 2);
  assert.equal(result.conflictPointCount, 1);
  assert.equal(result.consecutiveAbnormalCount, 1);
});
