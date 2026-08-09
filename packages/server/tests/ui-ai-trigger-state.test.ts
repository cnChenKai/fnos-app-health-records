import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessingJob } from "../../ui/src/types/api.ts";
import { resolveAiTriggerState } from "../../ui/src/utils/ai-trigger-state.ts";

type TriggerJob = Pick<ProcessingJob, "jobType" | "status" | "ocrTextLength">;

function job(
  jobType: TriggerJob["jobType"],
  status: TriggerJob["status"],
  ocrTextLength: number | null = null
): TriggerJob {
  return { jobType, status, ocrTextLength };
}

function resolve(jobs: TriggerJob[] = [], input: Partial<Parameters<typeof resolveAiTriggerState>[0]> = {}) {
  return resolveAiTriggerState({
    triggeringAi: false,
    jobsLoading: false,
    reportStatus: "ready",
    jobs,
    ...input
  });
}

test("AI trigger stays disabled with loading feedback while OCR or AI work is active", () => {
  assert.deepEqual(resolve([job("ocr", "queued")]), {
    disabled: true,
    loading: true,
    label: "等待 OCR"
  });
  assert.deepEqual(resolve([job("ocr", "processing")]), {
    disabled: true,
    loading: true,
    label: "OCR 识别中"
  });
  assert.deepEqual(resolve([job("ai_extract", "queued")]), {
    disabled: true,
    loading: true,
    label: "AI 排队中"
  });
  assert.deepEqual(resolve([job("ai_extract", "processing")]), {
    disabled: true,
    loading: true,
    label: "AI 整理中"
  });
  assert.deepEqual(resolve([], { triggeringAi: true }), {
    disabled: true,
    loading: true,
    label: "提交中"
  });
  assert.deepEqual(resolve([], { pageMutationPending: true }), {
    disabled: true,
    loading: true,
    label: "正在更新页面"
  });
});

test("AI trigger handles task-list races, OCR failures, and empty OCR output", () => {
  assert.deepEqual(resolve([], { jobsLoading: true }), {
    disabled: true,
    loading: true,
    label: "读取状态"
  });
  assert.deepEqual(resolve([], { reportStatus: "processing" }), {
    disabled: true,
    loading: true,
    label: "识别处理中"
  });
  assert.deepEqual(resolve([job("ocr", "completed", 128)], { reportStatus: "processing" }), {
    disabled: true,
    loading: true,
    label: "识别处理中"
  });
  assert.deepEqual(resolve([job("ocr", "failed")]), {
    disabled: true,
    loading: false,
    label: "请先重试 OCR"
  });
  assert.deepEqual(resolve([job("ocr", "completed", 0)]), {
    disabled: true,
    loading: false,
    label: "暂无 OCR 内容"
  });
});

test("AI trigger becomes available only after usable OCR and labels retries consistently", () => {
  assert.deepEqual(resolve([job("ocr", "completed", 128)]), {
    disabled: false,
    loading: false,
    label: "开始 AI 整理"
  });
  assert.deepEqual(resolve([
    job("ocr", "completed", 128),
    job("ai_extract", "failed")
  ]), {
    disabled: false,
    loading: false,
    label: "重新整理"
  });
  assert.deepEqual(resolve([
    job("ocr", "completed", 128),
    job("ai_extract", "completed")
  ]), {
    disabled: false,
    loading: false,
    label: "重新整理"
  });
});
