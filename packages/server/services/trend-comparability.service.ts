import type { ObservationReferenceStatus } from "./observation-reference.service";

export type TrendComparabilityStatus =
  | "comparable"
  | "range_drift"
  | "condition_mismatch"
  | "insufficient_evidence";

export type TrendComparabilityPoint = {
  referenceLow?: number | null;
  referenceHigh?: number | null;
  referenceStatus?: ObservationReferenceStatus | null;
  method?: string | null;
  specimen?: string | null;
  reportIssuedAt?: string | null;
  memberBirthDate?: string | null;
};

export type TrendComparabilityAssessment = {
  comparable: boolean;
  status: TrendComparabilityStatus;
  reason: string | null;
  referenceProfileKey: string | null;
  referenceProfileCount: number;
  latestPairStatus: TrendComparabilityStatus;
  latestPairReason: string | null;
  changeAssessmentAllowed: boolean;
};

type ReferenceProfile = {
  kind: "two_sided" | "upper" | "lower";
  low: number | null;
  high: number | null;
  key: string;
};

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function referenceStatus(point: TrendComparabilityPoint): ObservationReferenceStatus {
  if (point.referenceStatus) return point.referenceStatus;
  return finiteNumber(point.referenceLow) !== null || finiteNumber(point.referenceHigh) !== null
    ? "trusted"
    : "missing";
}

function stableNumber(value: number | null) {
  return value === null ? "" : Number(value.toPrecision(12)).toString();
}

export function trendReferenceProfile(point: TrendComparabilityPoint): ReferenceProfile | null {
  if (referenceStatus(point) !== "trusted") return null;
  const low = finiteNumber(point.referenceLow);
  const high = finiteNumber(point.referenceHigh);
  if (low !== null && high !== null && low > high) return null;
  if (low !== null && high !== null) {
    return { kind: "two_sided", low, high, key: `range:${stableNumber(low)}:${stableNumber(high)}` };
  }
  if (high !== null) return { kind: "upper", low: null, high, key: `upper:${stableNumber(high)}` };
  if (low !== null) return { kind: "lower", low, high: null, key: `lower:${stableNumber(low)}` };
  return null;
}

function boundaryClose(left: number, right: number) {
  const tolerance = Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right), 1) * 0.05);
  return Math.abs(left - right) <= tolerance;
}

function compareProfiles(left: ReferenceProfile, right: ReferenceProfile): TrendComparabilityStatus {
  if (left.kind === "two_sided" && right.kind === "two_sided") {
    return boundaryClose(left.low!, right.low!) && boundaryClose(left.high!, right.high!)
      ? "comparable"
      : "range_drift";
  }
  if (left.kind === "upper" && right.kind === "upper") {
    return boundaryClose(left.high!, right.high!) ? "comparable" : "range_drift";
  }
  if (left.kind === "lower" && right.kind === "lower") {
    return boundaryClose(left.low!, right.low!) ? "comparable" : "range_drift";
  }
  if (left.kind === "two_sided" && right.kind === "upper") {
    return boundaryClose(left.high!, right.high!) ? "comparable" : "range_drift";
  }
  if (left.kind === "upper" && right.kind === "two_sided") {
    return boundaryClose(left.high!, right.high!) ? "comparable" : "range_drift";
  }
  if (left.kind === "two_sided" && right.kind === "lower") {
    return boundaryClose(left.low!, right.low!) ? "comparable" : "range_drift";
  }
  if (left.kind === "lower" && right.kind === "two_sided") {
    return boundaryClose(left.low!, right.low!) ? "comparable" : "range_drift";
  }
  return "insufficient_evidence";
}

function normalizedText(value: string | null | undefined) {
  return (value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function specimenCategory(value: string | null | undefined) {
  const text = normalizedText(value);
  if (!text) return null;
  if (/血清|serum/.test(text)) return "serum";
  if (/血浆|plasma/.test(text)) return "plasma";
  if (/全血|wholeblood/.test(text)) return "whole_blood";
  if (/尿液|尿标本|尿样|urine/.test(text)) return "urine";
  if (/粪便|大便|stool|feces|faeces/.test(text)) return "stool";
  if (/脑脊液|cerebrospinal|\bcsf\b/.test(text)) return "csf";
  return null;
}

function methodCategory(value: string | null | undefined) {
  const text = normalizedText(value);
  if (!text) return null;
  if (/高效液相|液相色谱|hplc/.test(text)) return "hplc";
  if (/质谱|massspect|lc-ms|gc-ms/.test(text)) return "mass_spectrometry";
  if (/化学发光|chemilumines/.test(text)) return "chemiluminescence";
  if (/免疫比浊|immunoturbid/.test(text)) return "immunoturbidimetry";
  if (/酶联免疫|elisa/.test(text)) return "elisa";
  if (/离子选择电极|ionselective|\bise\b/.test(text)) return "ion_selective_electrode";
  if (/己糖激酶|hexokinase/.test(text)) return "hexokinase";
  if (/葡萄糖氧化酶|glucoseoxidase/.test(text)) return "glucose_oxidase";
  if (/酶法|enzymatic/.test(text)) return "enzymatic";
  if (/比色|colorimet/.test(text)) return "colorimetric";
  return null;
}

function ageCohort(point: TrendComparabilityPoint) {
  if (!point.memberBirthDate || !point.reportIssuedAt) return null;
  const birth = new Date(`${point.memberBirthDate.slice(0, 10)}T00:00:00Z`);
  const report = new Date(`${point.reportIssuedAt.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(birth.getTime()) || !Number.isFinite(report.getTime()) || report < birth) return null;
  let years = report.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = report.getUTCMonth() < birth.getUTCMonth()
    || (report.getUTCMonth() === birth.getUTCMonth() && report.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) years -= 1;
  return years < 18 ? "pediatric" : "adult";
}

function conditionMismatch(points: TrendComparabilityPoint[]) {
  const specimen = new Set(points.map((point) => specimenCategory(point.specimen)).filter(Boolean));
  if (specimen.size > 1) return "报告使用的标本类型不同，数值保留，变化结论需谨慎";
  const methods = new Set(points.map((point) => methodCategory(point.method)).filter(Boolean));
  if (methods.size > 1) return "报告使用的检测方法不同，数值保留，变化结论需谨慎";
  const ageCohorts = new Set(points.map(ageCohort).filter(Boolean));
  if (ageCohorts.size > 1) return "检测时适用年龄阶段发生变化，数值保留，变化结论需谨慎";
  return null;
}

function assessReferenceComparability(points: TrendComparabilityPoint[]) {
  if (points.length < 2) {
    return { status: "insufficient_evidence" as const, reason: "目前只有一次记录，暂不能判断跨报告可比性" };
  }
  if (points.some((point) => referenceStatus(point) !== "trusted")) {
    return { status: "insufficient_evidence" as const, reason: "部分报告缺少可信参考范围，数值保留，变化结论需谨慎" };
  }
  const profiles = points.map(trendReferenceProfile);
  if (profiles.some((profile) => !profile)) {
    return { status: "insufficient_evidence" as const, reason: "部分报告缺少可信参考范围，数值保留，变化结论需谨慎" };
  }
  for (let index = 1; index < profiles.length; index += 1) {
    const status = compareProfiles(profiles[index - 1]!, profiles[index]!);
    if (status === "range_drift") {
      return { status, reason: "不同报告的参考范围发生明显变化，数值保留，变化结论需谨慎" };
    }
    if (status === "insufficient_evidence") {
      return { status, reason: "报告参考范围形式不同，暂不能确认可直接比较" };
    }
  }
  return { status: "comparable" as const, reason: null };
}

function assessPoints(points: TrendComparabilityPoint[]) {
  const mismatchReason = conditionMismatch(points);
  if (mismatchReason) return { status: "condition_mismatch" as const, reason: mismatchReason };
  return assessReferenceComparability(points);
}

/**
 * 读取侧评估同一 canonical 指标跨报告的参考范围与检测条件是否可直接比较。
 * 不删除趋势点，不改写报告原始范围；只在有明确漂移/冲突证据时暂停最新环比结论。
 */
export function assessTrendComparability(points: TrendComparabilityPoint[]): TrendComparabilityAssessment {
  const profiles = points.map(trendReferenceProfile).filter((profile): profile is ReferenceProfile => Boolean(profile));
  const profileKeys = new Set(profiles.map((profile) => profile.key));
  const assessment = assessPoints(points);
  const latestPair = points.length >= 2 ? assessPoints(points.slice(-2)) : assessment;
  return {
    comparable: assessment.status === "comparable",
    status: assessment.status,
    reason: assessment.reason,
    referenceProfileKey: profileKeys.size === 1 ? [...profileKeys][0] : null,
    referenceProfileCount: profileKeys.size,
    latestPairStatus: latestPair.status,
    latestPairReason: latestPair.reason,
    changeAssessmentAllowed: !["range_drift", "condition_mismatch"].includes(latestPair.status),
  };
}
