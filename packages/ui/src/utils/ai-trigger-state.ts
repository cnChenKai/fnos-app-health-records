import type { ProcessingJob } from "../types/api";

type AiTriggerJob = Pick<ProcessingJob, "jobType" | "status" | "ocrTextLength">;

export type AiTriggerState = {
  disabled: boolean;
  loading: boolean;
  label: string;
};

export type AiTriggerStateInput = {
  triggeringAi: boolean;
  pageMutationPending?: boolean;
  jobsLoading: boolean;
  reportStatus?: string | null;
  jobs: readonly AiTriggerJob[];
};

const runningStatuses = new Set<ProcessingJob["status"]>(["queued", "processing"]);

function preferredRunningJob(jobs: readonly AiTriggerJob[]) {
  const running = jobs.filter((job) => runningStatuses.has(job.status));
  return running.find((job) => job.status === "processing") || running[0] || null;
}

export function hasEmptyCompletedOcr(jobs: readonly AiTriggerJob[]) {
  const localJobs = jobs.filter((job) => job.jobType !== "ai_extract");
  if (!localJobs.length || localJobs.some((job) => runningStatuses.has(job.status))) return false;
  const completedOcrJobs = jobs.filter((job) => job.jobType === "ocr" && job.status === "completed");
  return completedOcrJobs.length > 0 && completedOcrJobs.every((job) => !job.ocrTextLength);
}

export function resolveAiTriggerState(input: AiTriggerStateInput): AiTriggerState {
  const { triggeringAi, pageMutationPending = false, jobsLoading, reportStatus, jobs } = input;
  if (triggeringAi) return { disabled: true, loading: true, label: "提交中" };
  if (pageMutationPending) return { disabled: true, loading: true, label: "正在更新页面" };

  const aiJobs = jobs.filter((job) => job.jobType === "ai_extract");
  const activeAiJob = preferredRunningJob(aiJobs);
  if (activeAiJob) {
    return {
      disabled: true,
      loading: true,
      label: activeAiJob.status === "processing" ? "AI 整理中" : "AI 排队中"
    };
  }

  const localJobs = jobs.filter((job) => job.jobType !== "ai_extract");
  const activeLocalJob = preferredRunningJob(localJobs);
  if (activeLocalJob) {
    const label = activeLocalJob.jobType === "ocr"
      ? (activeLocalJob.status === "processing" ? "OCR 识别中" : "等待 OCR")
      : (activeLocalJob.status === "processing" ? "本地处理中" : "等待本地处理");
    return { disabled: true, loading: true, label };
  }

  // 报告状态会比任务列表先刷新；任务尚未拉回时也不允许短暂误触发 AI。
  if (jobsLoading || ["uploading", "queued", "processing"].includes(reportStatus || "")) {
    return { disabled: true, loading: true, label: jobsLoading ? "读取状态" : "识别处理中" };
  }

  if (localJobs.some((job) => job.status === "failed")) {
    return { disabled: true, loading: false, label: "请先重试 OCR" };
  }
  if (hasEmptyCompletedOcr(jobs)) {
    return { disabled: true, loading: false, label: "暂无 OCR 内容" };
  }

  const hasSettledAiJob = aiJobs.some((job) => job.status === "failed" || job.status === "completed");
  return {
    disabled: false,
    loading: false,
    label: hasSettledAiJob ? "重新整理" : "开始 AI 整理"
  };
}
