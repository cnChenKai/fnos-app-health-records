import assert from "node:assert/strict";
import test from "node:test";
import {
  assessObservationReference,
  canUseAdjacentReferenceCell,
  referenceColumnRole,
} from "../services/observation-reference.service.ts";
import { sanitizeReportObservations } from "../services/ai-extraction.service.ts";

test("classifies reference column roles conservatively", () => {
  assert.equal(referenceColumnRole("参考范围"), "explicit");
  assert.equal(referenceColumnRole("生物参考区间"), "explicit");
  assert.equal(referenceColumnRole("历史结果"), "unsafe");
  assert.equal(referenceColumnRole("仪器范围"), "unsafe");
  assert.equal(referenceColumnRole("备注"), "unknown");
  assert.equal(canUseAdjacentReferenceCell({ value: "1.0-5.2" }), true);
  assert.equal(canUseAdjacentReferenceCell({ value: "2024-2025" }), false);
  assert.equal(canUseAdjacentReferenceCell({ header: "预测值", value: "1.0-5.2" }), false);
});

test("keeps unsafe reference text for audit while removing numeric decision bounds", () => {
  assert.deepEqual(assessObservationReference({ low: 5, high: 1, text: "5-1" }), {
    low: null,
    high: null,
    text: "5-1",
    status: "raw_only",
    reason: "参考范围上下界反向，已停止用于自动判定",
  });
  const segmented = assessObservationReference({
    low: 1,
    high: 2,
    text: "男:1-2|女:0.5-1.5",
  });
  assert.equal(segmented.status, "raw_only");
  assert.equal(segmented.low, null);
  assert.equal(segmented.high, null);

  const predicted = assessObservationReference({
    low: 3,
    high: 4,
    text: "预测值 3-4",
  });
  assert.equal(predicted.status, "raw_only");
  assert.equal(predicted.low, null);
  assert.equal(predicted.high, null);
});

test("AI observation sanitization never silently swaps reversed reference bounds", () => {
  const [observation] = sanitizeReportObservations([{
    sectionName: "检验",
    itemCode: null,
    itemName: "示例指标",
    normalizedName: "示例指标",
    resultText: "3.2",
    numericValue: 3.2,
    unit: "mmol/L",
    referenceLow: 5,
    referenceHigh: 1,
    referenceText: "5-1",
    abnormalFlag: null,
    method: null,
    evidence: [{ pageNumber: 1, quote: "示例指标 | 3.2 | mmol/L | 5-1" }],
  }]);

  assert.ok(observation);
  assert.equal(observation.referenceLow, null);
  assert.equal(observation.referenceHigh, null);
  assert.equal(observation.referenceText, "5-1");
});
