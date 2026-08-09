export type ObservationReferenceStatus = "trusted" | "raw_only" | "missing";

export type ObservationReferenceAssessment = {
  low: number | null;
  high: number | null;
  text: string | null;
  status: ObservationReferenceStatus;
  reason: string | null;
};

const unsafeReferenceRolePattern =
  /(?:历史|既往|往年|历年|上次|前次|预测|预计|目标|仪器范围|仪器参考|测量范围|检测范围|线性范围|设备范围)/i;
const explicitReferenceRolePattern =
  /(?:参考值|参考范围|参考区间|正常范围|正常值范围|生物参考(?:范围|区间))/i;
const demographicSegmentPattern =
  /(?:男|女|男性|女性|儿童|成人|老年|年龄|岁|绝经前|绝经后)/i;

function cleanReferenceText(value: string | null | undefined) {
  return value?.normalize("NFKC").trim() || null;
}

export function referenceColumnRole(
  header: string | null | undefined,
): "explicit" | "unsafe" | "unknown" {
  const clean = cleanReferenceText(header);
  if (!clean) return "unknown";
  if (unsafeReferenceRolePattern.test(clean)) return "unsafe";
  if (explicitReferenceRolePattern.test(clean)) return "explicit";
  return "unknown";
}

/** 无明确表头时只接受完整区间或单侧比较符，禁止把普通数值误当参考范围。 */
export function hasExplicitReferenceValueShape(value: string | null | undefined) {
  const clean = cleanReferenceText(value)?.replace(/\s+/g, "") || "";
  if (!clean) return false;
  if (
    /(?:男|女|男性|女性)[:：]/.test(clean) &&
    /(?:[-+]?\d+(?:\.\d+)?(?:-|~|～|—|至)[-+]?\d+(?:\.\d+)?|(?:<|<=|≤|>|>=|≥)[-+]?\d+(?:\.\d+)?)/.test(clean)
  ) return true;
  const range = clean.match(
    /^([-+]?\d+(?:\.\d+)?)\s*(?:-|~|～|—|至)\s*([-+]?\d+(?:\.\d+)?)(?:[^\d].*)?$/,
  );
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (
      Number.isInteger(low) &&
      Number.isInteger(high) &&
      low >= 1900 &&
      low <= 2100 &&
      high >= 1900 &&
      high <= 2100
    ) return false;
    return true;
  }
  return /^(?:<|<=|≤|>|>=|≥|小于|不高于|大于|不低于)\s*[-+]?\d+(?:\.\d+)?(?:[^\d].*)?$/.test(clean);
}

export function canUseAdjacentReferenceCell(input: {
  header?: string | null;
  value?: string | null;
}) {
  const role = referenceColumnRole(input.header);
  if (role === "unsafe") return false;
  if (role === "explicit") return true;
  if (cleanReferenceText(input.header)) return false;
  return hasExplicitReferenceValueShape(input.value);
}

/**
 * 仅治理参考范围，不删除 observation。无法证明可信的范围保留原文，但清空数值边界，
 * 使异常解释和趋势判定不会使用可能来自错列、OCR 反转或人群分段的数值。
 */
export function assessObservationReference(input: {
  low?: number | null;
  high?: number | null;
  text?: string | null;
}): ObservationReferenceAssessment {
  const text = cleanReferenceText(input.text);
  const low = typeof input.low === "number" && Number.isFinite(input.low) ? input.low : null;
  const high = typeof input.high === "number" && Number.isFinite(input.high) ? input.high : null;
  const hasNumericBoundary = low !== null || high !== null;

  if (!hasNumericBoundary) {
    return {
      low: null,
      high: null,
      text,
      status: text ? "raw_only" : "missing",
      reason: text ? "参考范围仅保留原文，缺少可信数值边界" : null,
    };
  }
  if (low !== null && high !== null && low > high) {
    return {
      low: null,
      high: null,
      text,
      status: text ? "raw_only" : "missing",
      reason: "参考范围上下界反向，已停止用于自动判定",
    };
  }
  if (text && unsafeReferenceRolePattern.test(text)) {
    return {
      low: null,
      high: null,
      text,
      status: "raw_only",
      reason: "参考文本属于历史、预测、目标或设备范围，已停止用于自动判定",
    };
  }
  if (
    text &&
    demographicSegmentPattern.test(text) &&
    /[|｜;；或]/.test(text)
  ) {
    return {
      low: null,
      high: null,
      text,
      status: "raw_only",
      reason: "参考范围包含未完成消歧的人群分段，已停止用于自动判定",
    };
  }
  return { low, high, text, status: "trusted", reason: null };
}
