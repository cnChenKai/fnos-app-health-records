import type { ProcessingJob } from "../types/api";

export const PROCESSING_DELAY_THRESHOLDS = {
  queued: 15 * 60 * 1000,
  processing: 45 * 60 * 1000
} as const;

type ProcessingRecoveryInput = {
  reprocessingReport: boolean;
  jobsLoading: boolean;
  jobsPollingStopped: boolean;
  pageRefreshAwaitingJobs: boolean;
  hasRunningJobs: boolean;
  reportStatus?: string | null;
};

export type ProcessingRecoveryState = {
  reprocessDisabled: boolean;
  reprocessLabel: string;
  statusUncertain: boolean;
};

export type ProcessingDelayNotice = {
  title: string;
  message: string;
  status: "queued" | "processing";
};

const activeReportStatuses = new Set(["uploading", "queued", "processing"]);

export function resolveProcessingRecoveryState(input: ProcessingRecoveryInput): ProcessingRecoveryState {
  const statusUncertain = input.jobsLoading
    || input.jobsPollingStopped
    || input.pageRefreshAwaitingJobs
    || activeReportStatuses.has(input.reportStatus || "");
  const reprocessDisabled = input.reprocessingReport || input.hasRunningJobs || statusUncertain;
  const reprocessLabel = input.reprocessingReport
    ? "提交中"
    : input.jobsPollingStopped
      ? "先恢复进度"
      : input.pageRefreshAwaitingJobs
        ? "正在更新页面"
        : input.hasRunningJobs || activeReportStatuses.has(input.reportStatus || "")
          ? "识别处理中"
          : input.jobsLoading
            ? "读取状态"
            : "重跑 OCR+AI";
  return { reprocessDisabled, reprocessLabel, statusUncertain };
}

function databaseTimestampMs(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim().includes("T") ? value.trim() : value.trim().replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const timestamp = Date.parse(hasTimezone ? normalized : `${normalized}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function resolveProcessingDelayNotice(
  jobs: readonly Pick<ProcessingJob, "status" | "createdAt" | "startedAt">[],
  nowMs = Date.now()
): ProcessingDelayNotice | null {
  let delayedStatus: ProcessingDelayNotice["status"] | null = null;
  for (const job of jobs) {
    if (job.status !== "queued" && job.status !== "processing") continue;
    const startedAt = databaseTimestampMs(job.status === "processing" ? job.startedAt || job.createdAt : job.createdAt);
    if (startedAt == null) continue;
    if (nowMs - startedAt < PROCESSING_DELAY_THRESHOLDS[job.status]) continue;
    if (job.status === "processing") {
      delayedStatus = "processing";
      break;
    }
    delayedStatus ||= "queued";
  }
  if (!delayedStatus) return null;
  return {
    status: delayedStatus,
    title: delayedStatus === "queued" ? "任务排队时间较长" : "任务处理时间较长",
    message: "系统仍会继续读取进度，不会自动重复提交任务。可先刷新进度并查看日志；只有任务明确失败后再使用重试。"
  };
}
