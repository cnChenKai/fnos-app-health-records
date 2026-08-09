import type { ProcessingJob } from "../types/api";

type ReprocessJob = Pick<ProcessingJob, "jobType" | "status" | "pipelineVersion">;

export type ReportReprocessNotice = {
  tone: "info" | "warning";
  title: string;
  message: string;
  action: "retry_ocr_ai" | "retry_ai" | null;
  actionLabel: string | null;
};

const activeStatuses = new Set<ProcessingJob["status"]>(["queued", "processing"]);

export function resolveReportReprocessNotice(
  jobs: readonly ReprocessJob[],
  hasPreviousResult = true,
  pageRefreshAwaitingJobs = false
): ReportReprocessNotice | null {
  const manualJobs = jobs.filter((job) =>
    job.pipelineVersion === "manual-reprocess-v1" || job.pipelineVersion === "manual-page-v1"
  );
  if (!manualJobs.length && !pageRefreshAwaitingJobs) return null;
  const isPageRefresh = pageRefreshAwaitingJobs
    || manualJobs.some((job) => job.pipelineVersion === "manual-page-v1");

  if (pageRefreshAwaitingJobs || manualJobs.some((job) => activeStatuses.has(job.status))) {
    return {
      tone: "info",
      title: isPageRefresh ? "正在更新报告页面" : "正在重新识别",
      message: isPageRefresh
        ? (hasPreviousResult
            ? "当前仍展示上一次成功的报告数据和趋势，页面重新识别完成后会自动更新。"
            : "正在根据调整后的报告页面重新识别，完成后会自动更新报告内容。")
        : (hasPreviousResult
            ? "当前仍展示上一次成功的报告数据和趋势，完成后会自动更新。"
            : "正在处理报告原件，完成后会自动更新报告内容。"),
      action: null,
      actionLabel: null
    };
  }

  if (manualJobs.some((job) => job.jobType !== "ai_extract" && job.status === "failed")) {
    return {
      tone: "warning",
      title: isPageRefresh ? "报告页面更新未完成" : "本次重新识别失败",
      message: isPageRefresh
        ? (hasPreviousResult
            ? "原有报告数据和趋势未受影响。页面 OCR 或缩略图生成失败，建议重新运行 OCR + AI。"
            : "页面 OCR 或缩略图生成失败，建议重新运行 OCR + AI。")
        : (hasPreviousResult
            ? "原有报告数据和趋势未受影响。建议重新运行 OCR + AI。"
            : "本次未生成可用结果，建议重新运行 OCR + AI。"),
      action: "retry_ocr_ai",
      actionLabel: "重新运行 OCR + AI"
    };
  }

  if (manualJobs.some((job) => job.jobType === "ai_extract" && job.status === "failed")) {
    return {
      tone: "warning",
      title: isPageRefresh ? "页面更新后的 AI 整理失败" : "本次 AI 整理失败",
      message: isPageRefresh
        ? (hasPreviousResult
            ? "调整后页面的 OCR 已完成，原有报告数据和趋势未受影响，可直接重新 AI 整理。"
            : "调整后页面的 OCR 已完成，但 AI 整理失败，可直接重新 AI 整理。")
        : (hasPreviousResult
            ? "新的 OCR 已完成，原有报告数据和趋势未受影响，可直接重新 AI 整理。"
            : "新的 OCR 已完成，但 AI 整理失败，可直接重新 AI 整理。"),
      action: "retry_ai",
      actionLabel: "重新 AI 整理"
    };
  }

  return null;
}
