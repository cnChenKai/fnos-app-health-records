export type TrendAbnormalFlag = "high" | "low" | "abnormal" | "normal" | null;
export type TrendAbnormalDirection = "high" | "low" | "abnormal" | "normal" | "unknown";
export type TrendAbnormalContinuityStatus =
  | "none"
  | "latest_abnormal"
  | "persistent_abnormal"
  | "recovered"
  | "near_boundary"
  | "conflict"
  | "insufficient_evidence";
export type TrendAttentionPriority = "normal" | "notice" | "attention";

export type TrendAbnormalContinuityPoint = {
  numericValue: number;
  referenceLow?: number | null;
  referenceHigh?: number | null;
  referenceStatus?: "trusted" | "raw_only" | "missing";
  displayAbnormalFlag?: TrendAbnormalFlag;
  abnormalStatus?: "reported" | "computed" | "conflict" | "unresolved";
  abnormalConflict?: boolean;
};

export type TrendAbnormalContinuityAssessment = {
  status: TrendAbnormalContinuityStatus;
  reason: string | null;
  latestAbnormal: boolean;
  latestDirection: TrendAbnormalDirection;
  consecutiveAbnormalCount: number;
  totalAbnormalCount: number;
  previousAbnormalCount: number;
  recoveredFromAbnormal: boolean;
  conflictPointCount: number;
  attentionPriority: TrendAttentionPriority;
};

type ReliablePointState = {
  kind: "abnormal" | "normal" | "conflict" | "unknown";
  direction: TrendAbnormalDirection;
};

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reliablePointState(point: TrendAbnormalContinuityPoint): ReliablePointState {
  if (point.abnormalConflict || point.abnormalStatus === "conflict") {
    return { kind: "conflict", direction: "unknown" };
  }

  const flag = point.displayAbnormalFlag ?? null;
  if (flag === "high" || flag === "low" || flag === "abnormal") {
    return { kind: "abnormal", direction: flag };
  }
  if (flag === "normal") return { kind: "normal", direction: "normal" };

  const value = finiteNumber(point.numericValue);
  const low = finiteNumber(point.referenceLow);
  const high = finiteNumber(point.referenceHigh);
  const hasTrustedRange = point.referenceStatus === "trusted"
    && value !== null
    && (low !== null || high !== null)
    && !(low !== null && high !== null && low > high);
  if (!hasTrustedRange) return { kind: "unknown", direction: "unknown" };
  if (high !== null && value! > high) return { kind: "abnormal", direction: "high" };
  if (low !== null && value! < low) return { kind: "abnormal", direction: "low" };
  return { kind: "normal", direction: "normal" };
}

function abnormalDirectionLabel(direction: TrendAbnormalDirection) {
  if (direction === "high") return "偏高";
  if (direction === "low") return "偏低";
  return "异常";
}

/**
 * 评估报告原始异常标记在时间序列中的连续性。
 * 这里只描述“报告如何标记/可信参考范围如何判定”，不把数值升降解释为医学改善或恶化。
 */
export function assessTrendAbnormalContinuity(
  points: TrendAbnormalContinuityPoint[],
  options: { latestNearBoundary?: boolean } = {},
): TrendAbnormalContinuityAssessment {
  const states = points.map(reliablePointState);
  const latest = states.at(-1) || { kind: "unknown" as const, direction: "unknown" as const };
  const previousStates = states.slice(0, -1);
  const totalAbnormalCount = states.filter((state) => state.kind === "abnormal").length;
  const previousAbnormalCount = previousStates.filter((state) => state.kind === "abnormal").length;
  const conflictPointCount = states.filter((state) => state.kind === "conflict").length;

  let consecutiveAbnormalCount = 0;
  for (let index = states.length - 1; index >= 0; index -= 1) {
    if (states[index].kind !== "abnormal") break;
    consecutiveAbnormalCount += 1;
  }

  const base = {
    latestAbnormal: latest.kind === "abnormal",
    latestDirection: latest.direction,
    consecutiveAbnormalCount,
    totalAbnormalCount,
    previousAbnormalCount,
    recoveredFromAbnormal: false,
    conflictPointCount,
  };

  if (!points.length) {
    return {
      ...base,
      status: "insufficient_evidence",
      reason: "暂无可用于异常连续性判断的数据点",
      attentionPriority: "normal",
    };
  }

  if (latest.kind === "conflict") {
    return {
      ...base,
      status: "conflict",
      reason: "最新结果的异常标记与数值或参考范围不一致，连续性待核验",
      attentionPriority: "attention",
    };
  }

  if (latest.kind === "abnormal") {
    if (consecutiveAbnormalCount >= 2) {
      const consecutiveStates = states.slice(-consecutiveAbnormalCount);
      const directions = new Set(consecutiveStates.map((state) => state.direction));
      const directionReason = directions.size === 1
        ? `，均为${abnormalDirectionLabel(latest.direction)}`
        : "，异常方向有变化";
      return {
        ...base,
        status: "persistent_abnormal",
        reason: `连续 ${consecutiveAbnormalCount} 次结果处于异常状态${directionReason}`,
        attentionPriority: "attention",
      };
    }
    return {
      ...base,
      status: "latest_abnormal",
      reason: `最新一次结果为${abnormalDirectionLabel(latest.direction)}，此前未形成连续异常`,
      attentionPriority: "attention",
    };
  }

  if (latest.kind === "normal" && previousAbnormalCount > 0) {
    return {
      ...base,
      status: "recovered",
      reason: `历史有 ${previousAbnormalCount} 次可靠异常，最新结果已回到报告参考范围`,
      recoveredFromAbnormal: true,
      attentionPriority: "notice",
    };
  }

  if (options.latestNearBoundary && latest.kind === "normal") {
    return {
      ...base,
      status: "near_boundary",
      reason: "最新结果仍在报告参考范围内，但接近参考边界",
      attentionPriority: "notice",
    };
  }

  if (latest.kind === "normal") {
    return {
      ...base,
      status: "none",
      reason: null,
      attentionPriority: "normal",
    };
  }

  if (previousAbnormalCount > 0) {
    return {
      ...base,
      status: "insufficient_evidence",
      reason: "历史存在可靠异常，但最新结果缺少可信异常标记或参考范围，暂不能判断是否恢复",
      attentionPriority: "notice",
    };
  }

  return {
    ...base,
    status: "insufficient_evidence",
    reason: "最新结果缺少可信异常标记或参考范围，未自动判定异常状态",
    attentionPriority: "normal",
  };
}
