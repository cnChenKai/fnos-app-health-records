import assert from "node:assert/strict";
import test from "node:test";
import {
  assessObservationInterpretation,
  deriveObservationDisplayAbnormal,
  inferObservationAbnormalFlag,
  parseDictionaryReferenceRange
} from "../services/observation-interpretation.service.ts";

test("normalizes explicit arrows, H/L markers and qualitative results", () => {
  assert.equal(inferObservationAbnormalFlag({ resultText: "5.8 H" }), "high");
  assert.equal(inferObservationAbnormalFlag({ resultText: "2.1 (L)" }), "low");
  assert.equal(inferObservationAbnormalFlag({ resultText: "5.8", markerText: "H" }), "high");
  assert.equal(inferObservationAbnormalFlag({ resultText: "阴性" }), "normal");
  assert.equal(inferObservationAbnormalFlag({ resultText: "弱阳性" }), "abnormal");
});

test("does not mistake a litre unit for a low marker", () => {
  assert.equal(inferObservationAbnormalFlag({ resultText: "3.2", supportingText: ["FVC | 3.2 | L"] }), null);
  assert.equal(inferObservationAbnormalFlag({ resultText: "3.2 L" }), null);
  assert.equal(inferObservationAbnormalFlag({ resultText: "3.2 L ↓" }), "low");
  assert.equal(
    inferObservationAbnormalFlag({ resultText: "3.04", supportingText: ["当前结果 | 3.04 | 历史结果 | 3.52↑"] }),
    null,
  );
  assert.equal(inferObservationAbnormalFlag({ resultText: "3.04", supportingText: ["↑"] }), "high");
  assert.equal(inferObservationAbnormalFlag({ resultText: "6.8", supportingText: ["血糖 6.8 mmol/L ↑"] }), "high");
  assert.equal(inferObservationAbnormalFlag({ resultText: "5.0", supportingText: ["历史结果 6.8 mmol/L ↑"] }), null);
  assert.equal(inferObservationAbnormalFlag({ resultText: "6.8", supportingText: ["项目 16.8 mmol/L ↑"] }), null);
});

test("separates reported flags from effective display flags when numeric evidence conflicts", () => {
  const highConflict = assessObservationInterpretation({
    storedFlag: "high",
    numericValue: 7,
    referenceLow: 4,
    referenceHigh: 10,
  });
  assert.equal(highConflict.rawFlag, "high");
  assert.equal(highConflict.effectiveFlag, null);
  assert.equal(highConflict.status, "conflict");
  assert.equal(highConflict.conflict, true);

  const lowConflict = assessObservationInterpretation({
    storedFlag: "low",
    numericValue: 7,
    referenceLow: 4,
    referenceHigh: 10,
  });
  assert.equal(lowConflict.effectiveFlag, null);
  assert.equal(lowConflict.status, "conflict");

  const normalConflict = assessObservationInterpretation({
    storedFlag: "normal",
    numericValue: 11,
    referenceLow: 4,
    referenceHigh: 10,
  });
  assert.equal(normalConflict.rawFlag, "normal");
  assert.equal(normalConflict.effectiveFlag, null);
  assert.equal(normalConflict.status, "conflict");
});

test("computes directional display flags only from trusted numeric bounds when no report flag exists", () => {
  const high = assessObservationInterpretation({ numericValue: 11, referenceLow: 4, referenceHigh: 10 });
  assert.deepEqual(
    { rawFlag: high.rawFlag, effectiveFlag: high.effectiveFlag, source: high.source, status: high.status, conflict: high.conflict },
    { rawFlag: null, effectiveFlag: "high", source: "reference_range", status: "computed", conflict: false },
  );

  const low = assessObservationInterpretation({ numericValue: 3, referenceLow: 4, referenceHigh: 10 });
  assert.equal(low.effectiveFlag, "low");
  assert.equal(low.source, "reference_range");
  assert.equal(low.status, "computed");

  const within = assessObservationInterpretation({ numericValue: 7, referenceLow: 4, referenceHigh: 10 });
  assert.equal(within.effectiveFlag, null);
  assert.equal(within.status, "unresolved");
});

test("keeps explicit flags without a usable range and does not force qualitative results into numeric directions", () => {
  const reported = assessObservationInterpretation({ storedFlag: "high", numericValue: 7 });
  assert.equal(reported.effectiveFlag, "high");
  assert.equal(reported.status, "reported");
  assert.equal(reported.source, "stored");

  const nondirectional = assessObservationInterpretation({
    storedFlag: "abnormal",
    numericValue: 7,
    referenceLow: 4,
    referenceHigh: 10,
  });
  assert.equal(nondirectional.effectiveFlag, "abnormal");
  assert.equal(nondirectional.conflict, false);

  const qualitative = assessObservationInterpretation({
    resultText: "阴性",
    numericValue: 11,
    referenceLow: 4,
    referenceHigh: 10,
  });
  assert.equal(qualitative.rawFlag, "normal");
  assert.equal(qualitative.effectiveFlag, "normal");
  assert.equal(qualitative.source, "qualitative_result");
  assert.equal(qualitative.conflict, false);
});

test("falls back to the dictionary reference range only when the report provides no usable boundary", () => {
  // 骨密度 T 值场景：报告无参考范围，字典 WHO 标准 low=-1 → 计算型偏低
  const tScore = deriveObservationDisplayAbnormal({
    resultText: "-1.9",
    numericValue: -1.9,
    dictionaryReference: { low: -1, high: null }
  });
  assert.equal(tScore.displayAbnormalFlag, "low");
  assert.equal(tScore.abnormalConflict, false);

  // 报告自带任一有效边界时整体优先，不与字典范围混合
  const reportRangeWins = deriveObservationDisplayAbnormal({
    resultText: "6.04",
    numericValue: 6.04,
    referenceHigh: 5.2,
    dictionaryReference: { low: null, high: 99 }
  });
  assert.equal(reportRangeWins.displayAbnormalFlag, "high");

  // 无字典范围时行为不变：无边界 → 无标记
  const noFallback = deriveObservationDisplayAbnormal({
    resultText: "-1.9",
    numericValue: -1.9
  });
  assert.equal(noFallback.displayAbnormalFlag, null);

  // 报告显式"正常"但按字典范围越界 → 走既定冲突暂停口径，不改写方向
  const reported = deriveObservationDisplayAbnormal({
    storedFlag: "normal",
    resultText: "-1.9",
    numericValue: -1.9,
    dictionaryReference: { low: -1, high: null }
  });
  assert.equal(reported.displayAbnormalFlag, null);
  assert.equal(reported.abnormalConflict, true);
});

test("parses dictionary reference range json defensively", () => {
  assert.deepEqual(parseDictionaryReferenceRange('{"low":-1,"high":null}'), { low: -1, high: null });
  assert.equal(parseDictionaryReferenceRange("{}"), null);
  assert.equal(parseDictionaryReferenceRange('{"low":"x"}'), null);
  assert.equal(parseDictionaryReferenceRange("not-json"), null);
  assert.equal(parseDictionaryReferenceRange(null), null);
});

test("read-path interpretation falls back to the dictionary reference range", () => {
  // 读取期与写入期同一兜底规则：报告无边界时按字典公认范围计算方向
  const computed = assessObservationInterpretation({
    numericValue: -1.9,
    dictionaryReference: { low: -1, high: null }
  });
  assert.equal(computed.effectiveFlag, "low");
  assert.equal(computed.status, "computed");
  assert.equal(computed.reason, "数值低于指标字典公认参考下限");

  // 报告自带边界时字典不参与
  const reportRangeWins = assessObservationInterpretation({
    numericValue: 6.04,
    referenceHigh: 5.2,
    dictionaryReference: { low: null, high: 99 }
  });
  assert.equal(reportRangeWins.effectiveFlag, "high");
  assert.equal(reportRangeWins.reason, "数值高于报告参考上限");

  // 无字典范围时行为不变
  const noFallback = assessObservationInterpretation({ numericValue: -1.9 });
  assert.equal(noFallback.effectiveFlag, null);
  assert.equal(noFallback.status, "unresolved");
});
