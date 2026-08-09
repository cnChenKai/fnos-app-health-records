import { assessObservationReference } from "./observation-reference.service";

export type ObservationAbnormalFlag = "high" | "low" | "abnormal" | "normal" | null;
export type ObservationAbnormalSource =
  | "stored"
  | "result_marker"
  | "marker_column"
  | "evidence_marker"
  | "qualitative_result"
  | "reference_range"
  | "none";
export type ObservationAbnormalStatus = "reported" | "computed" | "conflict" | "unresolved";

export type ObservationInterpretationAssessment = {
  rawFlag: ObservationAbnormalFlag;
  effectiveFlag: ObservationAbnormalFlag;
  source: ObservationAbnormalSource;
  status: ObservationAbnormalStatus;
  conflict: boolean;
  reason: string | null;
};

function normalizedText(value: string | null | undefined) {
  return String(value || "").normalize("NFKC").trim();
}

function directionalMarker(value: string) {
  const high = /[↑▲⬆]|偏高/.test(value);
  const low = /[↓▼⬇]|偏低/.test(value);
  if (high === low) return null;
  return high ? "high" as const : "low" as const;
}

function resultDirectionalToken(value: string) {
  const bracketed = value.match(/[（(【[]\s*(H|L)\s*[）)】\]]\s*$/i);
  if (bracketed && /[-+]?\d/.test(value.slice(0, bracketed.index))) {
    return bracketed[1].toUpperCase() === "H" ? "high" as const : "low" as const;
  }

  // 裸 L 很容易是容量单位“升”，不能仅凭“数字 + L”判为偏低。
  // 裸 H 在检验结果尾部没有同等级的常见单位歧义，保留兼容识别。
  const high = value.match(/(?:^|\s)H\s*$/i);
  if (!high || !/[-+]?\d/.test(value.slice(0, high.index))) return null;
  return "high" as const;
}

function explicitMarkerToken(value: string) {
  const clean = value.replace(/[（）()[\]【】]/g, "").trim();
  if (/^(?:H|HIGH|高|偏高|↑|▲|⬆)$/i.test(clean)) return "high" as const;
  if (/^(?:L|LOW|低|偏低|↓|▼|⬇)$/i.test(clean)) return "low" as const;
  if (/^(?:A|ABN|ABNORMAL|异常|阳性|弱阳性|可疑阳性|\*|\+{1,4})$/i.test(clean)) return "abnormal" as const;
  if (/^(?:N|NORMAL|正常|阴性|未检出|未见异常)$/i.test(clean)) return "normal" as const;
  return null;
}

function qualitativeResultFlag(value: string) {
  const clean = value.replace(/[。.;；：:]/g, "").trim();
  if (/^(?:阳性|弱阳性|可疑阳性|异常|可见|\+{1,4})$/i.test(clean)) return "abnormal" as const;
  if (/^(?:阴性|正常|未检出|未见异常)$/i.test(clean)) return "normal" as const;
  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function supportingMarker(value: string, resultText: string) {
  const explicit = explicitMarkerToken(value);
  if (explicit) return explicit;
  if (!resultText || /[|｜]/.test(value) || /历史|既往|上次|前次/.test(value)) return null;
  if (!/(?:[↑▲⬆↓▼⬇]|偏高|偏低)\s*$/.test(value)) return null;
  const direction = directionalMarker(value);
  if (!direction) return null;

  const numeric = resultText.match(/[-+]?\d+(?:\.\d+)?/)?.[0];
  if (numeric) {
    const pattern = new RegExp(`(?:^|[^\\d.])${escapeRegExp(numeric)}(?:$|[^\\d.])`);
    return pattern.test(value) ? direction : null;
  }
  return value.includes(resultText) ? direction : null;
}

function inferReportedAbnormalFlag(input: {
  resultText?: string | null;
  markerText?: string | null;
  supportingText?: Array<string | null | undefined>;
}): { flag: ObservationAbnormalFlag; source: ObservationAbnormalSource } {
  const resultText = normalizedText(input.resultText);
  const markerText = normalizedText(input.markerText);
  const supportingText = (input.supportingText || []).map(normalizedText).filter(Boolean);

  const resultDirection = directionalMarker(resultText) || resultDirectionalToken(resultText);
  if (resultDirection) return { flag: resultDirection, source: "result_marker" };

  const marker = explicitMarkerToken(markerText) || directionalMarker(markerText);
  if (marker) return { flag: marker, source: "marker_column" };

  // supportingText 往往是整行 OCR，可能同时包含历史结果、参考值或容量单位。
  // 表格行与历史语境不从整行搜索标记；非表格证据仅在“当前结果 + 行尾箭头”闭环时兜底。
  const supportMarkers = new Set(supportingText.map((value) => supportingMarker(value, resultText)).filter(Boolean));
  if (supportMarkers.size === 1) {
    return { flag: [...supportMarkers][0] as ObservationAbnormalFlag, source: "evidence_marker" };
  }

  const qualitative = qualitativeResultFlag(resultText);
  return qualitative
    ? { flag: qualitative, source: "qualitative_result" }
    : { flag: null, source: "none" };
}

function reportedReason(flag: Exclude<ObservationAbnormalFlag, null>) {
  if (flag === "high") return "原报告标记偏高";
  if (flag === "low") return "原报告标记偏低";
  if (flag === "abnormal") return "原报告标记异常";
  return "原报告标记正常";
}

/**
 * 只根据报告中的显式标记推导异常状态，不根据参考范围自行生成标记。
 * H/L 仅在结果值后缀或明确的标记列中识别，避免把容量单位 L 误判为偏低。
 */
export function inferObservationAbnormalFlag(input: {
  resultText?: string | null;
  markerText?: string | null;
  supportingText?: Array<string | null | undefined>;
}): ObservationAbnormalFlag {
  return inferReportedAbnormalFlag(input).flag;
}

/**
 * 对报告原始标记、数值和已通过可信度治理的参考范围做读取侧一致性评估。
 * 不改写原始标记；发生冲突时暂停展示方向性结论，无原始标记但明确越界时才生成计算型标记。
 */
export function assessObservationInterpretation(input: {
  storedFlag?: ObservationAbnormalFlag;
  resultText?: string | null;
  markerText?: string | null;
  supportingText?: Array<string | null | undefined>;
  numericValue?: number | null;
  referenceLow?: number | null;
  referenceHigh?: number | null;
  dictionaryReference?: { low?: number | null; high?: number | null } | null;
}): ObservationInterpretationAssessment {
  const inferred = input.storedFlag
    ? { flag: input.storedFlag, source: "stored" as const }
    : inferReportedAbnormalFlag(input);
  const rawFlag = inferred.flag;
  const numericValue = typeof input.numericValue === "number" && Number.isFinite(input.numericValue)
    ? input.numericValue
    : null;
  const reportLow = typeof input.referenceLow === "number" && Number.isFinite(input.referenceLow)
    ? input.referenceLow
    : null;
  const reportHigh = typeof input.referenceHigh === "number" && Number.isFinite(input.referenceHigh)
    ? input.referenceHigh
    : null;
  // 报告未提供任何可用参考边界时，用指标字典的公认参考范围兜底（如骨密度 T 值的 WHO 标准）。
  // 报告只要自带任一有效边界就整体优先，不与字典范围混合。
  const reportRangeMissing = reportLow === null && reportHigh === null;
  const dictionaryLow =
    reportRangeMissing &&
    typeof input.dictionaryReference?.low === "number" &&
    Number.isFinite(input.dictionaryReference.low)
      ? input.dictionaryReference.low
      : null;
  const dictionaryHigh =
    reportRangeMissing &&
    typeof input.dictionaryReference?.high === "number" &&
    Number.isFinite(input.dictionaryReference.high)
      ? input.dictionaryReference.high
      : null;
  const rangeFromDictionary = reportRangeMissing && (dictionaryLow !== null || dictionaryHigh !== null);
  const low = rangeFromDictionary ? dictionaryLow : reportLow;
  const high = rangeFromDictionary ? dictionaryHigh : reportHigh;
  const hasUsableRange = numericValue !== null && (low !== null || high !== null) && !(low !== null && high !== null && low > high);
  const below = hasUsableRange && low !== null && numericValue! < low;
  const above = hasUsableRange && high !== null && numericValue! > high;

  // 定性结果和非方向性异常不套用数值范围，避免把“阳性/阴性”等错误转成高低。
  const rangeComparable = inferred.source !== "qualitative_result" && rawFlag !== "abnormal";
  if (rawFlag && hasUsableRange && rangeComparable) {
    const directionalConflict = rawFlag === "high"
      ? (high !== null && !above) || (high === null && below)
      : rawFlag === "low"
        ? (low !== null && !below) || (low === null && above)
        : false;
    if (directionalConflict) {
      return {
        rawFlag,
        effectiveFlag: null,
        source: inferred.source,
        status: "conflict",
        conflict: true,
        reason: rangeFromDictionary
          ? "原报告异常方向与数值及字典公认参考范围不一致，已暂停自动判定"
          : "原报告异常方向与数值及参考范围不一致，已暂停自动判定",
      };
    }
    if (rawFlag === "normal" && (below || above)) {
      return {
        rawFlag,
        effectiveFlag: null,
        source: inferred.source,
        status: "conflict",
        conflict: true,
        reason: rangeFromDictionary
          ? "原报告正常标记与数值及字典公认参考范围不一致，已暂停自动判定"
          : "原报告正常标记与数值及参考范围不一致，已暂停自动判定",
      };
    }
  }

  if (rawFlag) {
    return {
      rawFlag,
      effectiveFlag: rawFlag,
      source: inferred.source,
      status: "reported",
      conflict: false,
      reason: reportedReason(rawFlag),
    };
  }

  if (above || below) {
    return {
      rawFlag: null,
      effectiveFlag: above ? "high" : "low",
      source: "reference_range",
      status: "computed",
      conflict: false,
      reason: above
        ? rangeFromDictionary ? "数值高于指标字典公认参考上限" : "数值高于报告参考上限"
        : rangeFromDictionary ? "数值低于指标字典公认参考下限" : "数值低于报告参考下限",
    };
  }

  return {
    rawFlag: null,
    effectiveFlag: null,
    source: "none",
    status: "unresolved",
    conflict: false,
    reason: null,
  };
}

/* 列表计数等 SQL 场景需要持久化的展示口径异常标记。
   推导逻辑必须与读取期保持一致：参考范围先经可信度治理，数值缺失时
   从结果文本解析，证据行作为辅助标记来源。版本号用于逻辑变更后触发回填。 */
export const observationDisplayFlagDerivationVersion = 3;

/* 解析指标字典 reference_range_json；无数值边界时返回 null，不参与兜底。 */
export function parseDictionaryReferenceRange(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { low?: unknown; high?: unknown };
    const low = typeof parsed.low === "number" && Number.isFinite(parsed.low) ? parsed.low : null;
    const high = typeof parsed.high === "number" && Number.isFinite(parsed.high) ? parsed.high : null;
    return low !== null || high !== null ? { low, high } : null;
  } catch {
    return null;
  }
}

function numericFromResultText(value: string | null | undefined) {
  const match = String(value || "").match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function deriveObservationDisplayAbnormal(input: {
  storedFlag?: ObservationAbnormalFlag;
  resultText?: string | null;
  supportingText?: Array<string | null | undefined>;
  numericValue?: number | null;
  referenceLow?: number | null;
  referenceHigh?: number | null;
  referenceText?: string | null;
  dictionaryReference?: { low?: number | null; high?: number | null } | null;
}): { displayAbnormalFlag: ObservationAbnormalFlag; abnormalConflict: boolean } {
  const reference = assessObservationReference({
    low: input.referenceLow ?? null,
    high: input.referenceHigh ?? null,
    text: input.referenceText ?? null,
  });
  // 字典参考范围兜底规则集中在 assessObservationInterpretation 内，保证读取期与写入期口径一致。
  const interpretation = assessObservationInterpretation({
    storedFlag: input.storedFlag ?? null,
    resultText: input.resultText,
    supportingText: input.supportingText,
    numericValue: input.numericValue ?? numericFromResultText(input.resultText),
    referenceLow: reference.low,
    referenceHigh: reference.high,
    dictionaryReference: input.dictionaryReference ?? null,
  });
  return {
    displayAbnormalFlag: interpretation.effectiveFlag,
    abnormalConflict: interpretation.conflict,
  };
}
