export type TrendChangePoint = {
  observationId: string;
  numericValue: number;
  reportIssuedAt?: string | null;
  referenceLow?: number | null;
  referenceHigh?: number | null;
};

export type TrendStatus =
  | "baseline"
  | "stable"
  | "sustained_rise"
  | "sustained_fall"
  | "fluctuating"
  | "insufficient_evidence";

export type LatestChangeStatus =
  | "baseline"
  | "unchanged"
  | "increase"
  | "decrease"
  | "not_comparable"
  | "needs_review";

export type LatestChangeMagnitude =
  | "unavailable"
  | "unchanged"
  | "small"
  | "moderate"
  | "large";

export type TrendIntervalBucket =
  | "unknown"
  | "same_day"
  | "short_term"
  | "medium_term"
  | "long_term";

export type TrendIntervalRegularity = "unknown" | "regular" | "irregular";

export type TrendChangeAssessment = {
  latestDelta: number | null;
  latestChangeStatus: LatestChangeStatus;
  latestChangeMagnitude: LatestChangeMagnitude;
  latestChangeReason: string | null;
  latestChangeConclusionAllowed: boolean;
  latestIntervalDays: number | null;
  latestIntervalBucket: TrendIntervalBucket;
  trendStatus: TrendStatus;
  trendReason: string;
  trendConclusionAllowed: boolean;
  trendDurationDays: number | null;
  trendIntervalRegularity: TrendIntervalRegularity;
  analysisPointCount: number;
  outlierPointIds: string[];
  outlierCount: number;
  typicalMinValue: number | null;
  typicalMaxValue: number | null;
};

export type TrendChangeAssessmentOptions = {
  latestComparisonAllowed?: boolean;
  seriesComparisonAllowed?: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dateTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intervalDays(left: TrendChangePoint | undefined, right: TrendChangePoint | undefined) {
  const leftDate = dateTimestamp(left?.reportIssuedAt);
  const rightDate = dateTimestamp(right?.reportIssuedAt);
  if (leftDate === null || rightDate === null || rightDate < leftDate) return null;
  return Math.round((rightDate - leftDate) / DAY_MS);
}

function intervalBucket(days: number | null): TrendIntervalBucket {
  if (days === null) return "unknown";
  if (days === 0) return "same_day";
  if (days <= 30) return "short_term";
  if (days <= 365) return "medium_term";
  return "long_term";
}

function referenceSpan(points: TrendChangePoint[]) {
  const spans = points.flatMap((point) => {
    const low = finiteNumber(point.referenceLow);
    const high = finiteNumber(point.referenceHigh);
    return low !== null && high !== null && high > low ? [high - low] : [];
  });
  return median(spans);
}

function valueScale(points: TrendChangePoint[]) {
  const absoluteMedian = median(points.map((point) => Math.abs(point.numericValue))) || 0;
  return Math.max(absoluteMedian, referenceSpan(points) || 0, 1e-9);
}

function detectOutlierIndexes(points: TrendChangePoint[]) {
  if (points.length < 3) return new Set<number>();
  const values = points.map((point) => point.numericValue);
  if (points.length < 5) {
    const sorted = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
    const gaps = sorted.slice(1).map((entry, index) => ({
      gap: entry.value - sorted[index].value,
      split: index,
    })).sort((left, right) => right.gap - left.gap);
    const largest = gaps[0];
    const second = gaps[1]?.gap || 0;
    const center = Math.max(Math.abs(median(values) || 0), 1e-9);
    if (largest && largest.gap > Math.max(second * 4, center * 0.2)) {
      if (largest.split === 0) return new Set([sorted[0].index]);
      if (largest.split === sorted.length - 2) return new Set([sorted.at(-1)!.index]);
    }
    return new Set<number>();
  }
  const center = median(values)!;
  const deviations = values.map((value) => Math.abs(value - center));
  const mad = median(deviations)!;
  const scale = Math.max(Math.abs(center), 1e-9);
  const indexes = new Set<number>();

  if (mad > Math.max(scale * 1e-12, 1e-12)) {
    deviations.forEach((deviation, index) => {
      const robustZ = 0.6745 * deviation / mad;
      if (robustZ > 3.5 && deviation / scale > 0.1) indexes.add(index);
    });
    return indexes.size <= Math.floor(points.length / 3) ? indexes : new Set<number>();
  }

  const closeTolerance = Math.max(scale * 0.02, 1e-9);
  const closeCount = deviations.filter((deviation) => deviation <= closeTolerance).length;
  if (closeCount < points.length - 1) return indexes;
  deviations.forEach((deviation, index) => {
    if (deviation > Math.max(scale * 0.2, 1e-9)) indexes.add(index);
  });
  return indexes.size <= Math.floor(points.length / 3) ? indexes : new Set<number>();
}

function intervalRegularity(points: TrendChangePoint[]): TrendIntervalRegularity {
  if (points.length < 3) return "unknown";
  const intervals = points.slice(1).map((point, index) => intervalDays(points[index], point));
  if (intervals.some((days) => days === null || days === 0)) return "unknown";
  const positive = intervals as number[];
  const shortest = Math.min(...positive);
  const longest = Math.max(...positive);
  return longest / shortest > 4 ? "irregular" : "regular";
}

function latestMagnitude(delta: number, points: TrendChangePoint[]) {
  const scale = valueScale(points);
  const ratio = Math.abs(delta) / scale;
  if (ratio <= 0.005) return "unchanged" as const;
  if (ratio <= 0.05) return "small" as const;
  if (ratio <= 0.2) return "moderate" as const;
  return "large" as const;
}

function trendClassification(points: TrendChangePoint[], regularity: TrendIntervalRegularity) {
  if (points.length < 3) {
    return {
      status: "insufficient_evidence" as const,
      reason: "至少需要 3 次有效记录，当前仅展示数值差值，不形成连续趋势结论"
    };
  }
  const intervals = points.slice(1).map((point, index) => intervalDays(points[index], point));
  if (intervals.some((days) => days === null || days === 0)) {
    return {
      status: "insufficient_evidence" as const,
      reason: "检测日期不完整或存在同日记录，暂不形成连续趋势结论"
    };
  }

  const scale = valueScale(points);
  const stableTolerance = scale * 0.05;
  const stepTolerance = scale * 0.01;
  const values = points.map((point) => point.numericValue);
  const spread = Math.max(...values) - Math.min(...values);
  const suffix = regularity === "irregular" ? "；检测间隔不均，结论仅描述数值走向" : "";
  if (spread <= stableTolerance) {
    return { status: "stable" as const, reason: `多次结果整体波动较小${suffix}` };
  }

  const deltas = values.slice(1).map((value, index) => value - values[index]);
  const rises = deltas.filter((delta) => delta > stepTolerance).length;
  const falls = deltas.filter((delta) => delta < -stepTolerance).length;
  const overall = values.at(-1)! - values[0];
  if (rises >= 2 && falls === 0 && overall > stableTolerance) {
    return { status: "sustained_rise" as const, reason: `至少 3 次结果呈连续数值上升${suffix}` };
  }
  if (falls >= 2 && rises === 0 && overall < -stableTolerance) {
    return { status: "sustained_fall" as const, reason: `至少 3 次结果呈连续数值下降${suffix}` };
  }
  if (rises > 0 && falls > 0) {
    return { status: "fluctuating" as const, reason: `多次结果同时出现上升和下降${suffix}` };
  }
  return {
    status: "insufficient_evidence" as const,
    reason: `现有记录尚不足以形成稳定、连续上升、连续下降或波动结论${suffix}`
  };
}

export function assessTrendChange(
  inputPoints: TrendChangePoint[],
  options: TrendChangeAssessmentOptions = {}
): TrendChangeAssessment {
  const points = inputPoints.filter((point) => Number.isFinite(point.numericValue));
  const rawValues = points.map((point) => point.numericValue);
  const latest = points.at(-1);
  const previous = points.at(-2);
  const latestDelta = latest && previous ? latest.numericValue - previous.numericValue : null;
  const latestIntervalDays = intervalDays(previous, latest);
  const outlierIndexes = detectOutlierIndexes(points);
  const outlierPointIds = [...outlierIndexes].map((index) => points[index].observationId);
  const analysisPoints = points.filter((_, index) => !outlierIndexes.has(index));
  const analysisValues = analysisPoints.map((point) => point.numericValue);
  const latestIsOutlier = points.length > 0 && outlierIndexes.has(points.length - 1);
  const latestComparisonAllowed = options.latestComparisonAllowed !== false;
  const seriesComparisonAllowed = options.seriesComparisonAllowed !== false;
  const regularity = intervalRegularity(analysisPoints);

  let latestChangeStatus: LatestChangeStatus = "baseline";
  let latestChangeMagnitude: LatestChangeMagnitude = "unavailable";
  let latestChangeReason: string | null = points.length === 1 ? "目前只有一次记录" : null;
  let latestChangeConclusionAllowed = false;

  if (latestDelta !== null) {
    if (!latestComparisonAllowed) {
      latestChangeStatus = "not_comparable";
      latestChangeReason = "最近两次记录的参考条件不兼容，保留数值但暂停变化结论";
    } else if (latestIsOutlier) {
      latestChangeStatus = "needs_review";
      latestChangeReason = "最新结果与其余记录差异较大，保留原值并暂停方向结论";
    } else if (latestIntervalDays === null || latestIntervalDays === 0) {
      latestChangeStatus = "needs_review";
      latestChangeReason = "最近两次检测日期不完整或为同日记录，暂不形成方向结论";
    } else {
      latestChangeMagnitude = latestMagnitude(latestDelta, [previous!, latest!]);
      latestChangeStatus = latestChangeMagnitude === "unchanged"
        ? "unchanged"
        : latestDelta > 0 ? "increase" : "decrease";
      latestChangeConclusionAllowed = true;
      latestChangeReason = "仅表示最近两次记录的算术差值，不代表医学改善或恶化";
    }
  }

  let trendStatus: TrendStatus;
  let trendReason: string;
  let trendConclusionAllowed = false;
  if (!points.length || points.length === 1) {
    trendStatus = "baseline";
    trendReason = "目前只有一次记录，作为后续比较基线";
  } else if (!seriesComparisonAllowed) {
    trendStatus = "insufficient_evidence";
    trendReason = "历史记录存在参考范围或检测条件变化，暂不形成整段趋势结论";
  } else if (latestIsOutlier) {
    trendStatus = "insufficient_evidence";
    trendReason = "最新结果与其余记录差异较大，需结合原报告核验后再判断趋势";
  } else {
    const classification = trendClassification(analysisPoints, regularity);
    trendStatus = classification.status;
    trendReason = outlierPointIds.length
      ? `${classification.reason}；已将 ${outlierPointIds.length} 个明显离群点排除在趋势结论之外，但原始数据仍保留`
      : classification.reason;
    trendConclusionAllowed = !["baseline", "insufficient_evidence"].includes(trendStatus);
  }

  return {
    latestDelta,
    latestChangeStatus,
    latestChangeMagnitude,
    latestChangeReason,
    latestChangeConclusionAllowed,
    latestIntervalDays,
    latestIntervalBucket: intervalBucket(latestIntervalDays),
    trendStatus,
    trendReason,
    trendConclusionAllowed,
    trendDurationDays: intervalDays(analysisPoints[0], analysisPoints.at(-1)),
    trendIntervalRegularity: regularity,
    analysisPointCount: analysisPoints.length,
    outlierPointIds,
    outlierCount: outlierPointIds.length,
    typicalMinValue: analysisValues.length ? Math.min(...analysisValues) : rawValues.length ? Math.min(...rawValues) : null,
    typicalMaxValue: analysisValues.length ? Math.max(...analysisValues) : rawValues.length ? Math.max(...rawValues) : null,
  };
}
