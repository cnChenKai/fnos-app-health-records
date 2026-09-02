import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ProcessingJob } from "../../ui/src/types/api.ts";
import {
  calculateProcessingJobProgress,
  groupProcessingJobBatches,
  isProcessingJobBatchSettled,
  processingJobBatchLabel
} from "../../ui/src/utils/processing-job-batches.ts";

function job(overrides: Partial<ProcessingJob> & Pick<ProcessingJob, "id" | "batchId" | "batchKind" | "batchStartedAt">): ProcessingJob {
  return {
    pageId: null,
    pageNumber: null,
    originalName: null,
    jobType: "ocr",
    pipelineVersion: "upload-v1",
    batchSequence: 0,
    status: "completed",
    attempts: 1,
    errorCode: null,
    errorMessage: null,
    createdAt: overrides.batchStartedAt,
    startedAt: overrides.batchStartedAt,
    finishedAt: overrides.batchStartedAt,
    ocrEngine: null,
    ocrModelVersion: null,
    ocrElapsedMs: null,
    ocrTextLength: 10,
    ocrQualityLevel: "good",
    ocrMode: "local",
    remoteProcessingAccepted: false,
    aiProvider: null,
    aiModel: null,
    aiElapsedMs: null,
    promptTokens: null,
    completionTokens: null,
    ...overrides
  };
}

test("initial upload jobs form one current batch", () => {
  const groups = groupProcessingJobBatches([
    job({ id: "thumb", batchId: "initial-upload", batchKind: "initial_upload", batchStartedAt: "2026-08-01 10:00:00", jobType: "thumbnail" }),
    job({ id: "ocr", batchId: "initial-upload", batchKind: "initial_upload", batchStartedAt: "2026-08-01 10:00:00" }),
    job({ id: "ai", batchId: "initial-upload", batchKind: "initial_upload", batchStartedAt: "2026-08-01 10:00:00", jobType: "ai_extract" })
  ]);
  assert.equal(groups.currentBatch?.kind, "initial_upload");
  assert.equal(groups.currentJobs.length, 3);
  assert.equal(groups.historicalBatches.length, 0);
});

test("multi-page OCR and automatic AI stay in one reprocess batch", () => {
  const groups = groupProcessingJobBatches([
    job({ id: "ocr-1", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00", pageNumber: 1 }),
    job({ id: "ocr-2", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00", pageNumber: 2 }),
    job({ id: "ai", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00", jobType: "ai_extract" })
  ]);
  assert.equal(groups.currentBatch?.id, "batch-1");
  assert.deepEqual(groups.currentJobs.map((item) => item.id), ["ocr-1", "ocr-2", "ai"]);
});

test("latest rerun is current and the previous rerun becomes history", () => {
  const groups = groupProcessingJobBatches([
    job({ id: "old", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00" }),
    job({ id: "new", batchId: "batch-2", batchKind: "manual_reprocess", batchStartedAt: "2026-08-03 10:00:00" })
  ]);
  assert.equal(groups.currentBatch?.id, "batch-2");
  assert.deepEqual(groups.historicalBatches.map((batch) => batch.id), ["batch-1"]);
});



test("batch sequence breaks ties when SQLite timestamps are identical", () => {
  const timestamp = "2026-08-03 10:00:00";
  const groups = groupProcessingJobBatches([
    job({
      id: "old", batchId: "batch-z", batchKind: "manual_reprocess",
      batchStartedAt: timestamp, batchSequence: 10
    }),
    job({
      id: "new", batchId: "batch-a", batchKind: "manual_reprocess",
      batchStartedAt: timestamp, batchSequence: 11
    })
  ]);
  assert.equal(groups.currentBatch?.id, "batch-a");
  assert.deepEqual(groups.historicalBatches.map((batch) => batch.id), ["batch-z"]);
});

test("current progress excludes completed historical jobs", () => {
  const groups = groupProcessingJobBatches([
    job({ id: "old-1", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00" }),
    job({ id: "old-2", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00" }),
    job({ id: "new-ocr", batchId: "batch-2", batchKind: "manual_reprocess", batchStartedAt: "2026-08-03 10:00:00", status: "completed" }),
    job({ id: "new-ai", batchId: "batch-2", batchKind: "manual_reprocess", batchStartedAt: "2026-08-03 10:00:00", jobType: "ai_extract", status: "processing", plannedUnits: 4, completedUnits: 2 })
  ]);
  assert.equal(calculateProcessingJobProgress(groups.currentJobs), 75);
});

test("cancelled jobs are settled and cannot keep polling alive", () => {
  assert.equal(isProcessingJobBatchSettled([
    job({ id: "done", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00" }),
    job({ id: "cancelled", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00", status: "cancelled" })
  ]), true);
  assert.equal(isProcessingJobBatchSettled([
    job({ id: "running", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00", status: "processing" })
  ]), false);
});

test("historical failures do not count as failures in the current batch", () => {
  const groups = groupProcessingJobBatches([
    job({ id: "old-failed", batchId: "batch-1", batchKind: "manual_reprocess", batchStartedAt: "2026-08-02 10:00:00", status: "failed" }),
    job({ id: "new-ok", batchId: "batch-2", batchKind: "manual_reprocess", batchStartedAt: "2026-08-03 10:00:00" })
  ]);
  assert.equal(groups.currentJobs.filter((item) => item.status === "failed").length, 0);
  assert.equal(groups.historicalBatches[0].status, "failed");
});

test("an active batch wins over a later cancelled batch", () => {
  const groups = groupProcessingJobBatches([
    job({ id: "active", batchId: "batch-active", batchKind: "manual_reprocess", batchStartedAt: "2026-08-03 10:00:00", status: "processing" }),
    job({ id: "cancelled", batchId: "batch-cancelled", batchKind: "manual_ai", batchStartedAt: "2026-08-04 10:00:00", status: "cancelled" })
  ]);
  assert.equal(groups.currentBatch?.id, "batch-active");
});

test("manual AI extraction is kept as an independent batch", () => {
  const groups = groupProcessingJobBatches([
    job({ id: "initial", batchId: "initial-upload", batchKind: "initial_upload", batchStartedAt: "2026-08-01 10:00:00" }),
    job({ id: "manual-ai", batchId: "manual-ai:manual-ai", batchKind: "manual_ai", batchStartedAt: "2026-08-02 10:00:00", jobType: "ai_extract" })
  ]);
  assert.equal(groups.currentBatch?.kind, "manual_ai");
  assert.equal(groups.historicalBatches[0].kind, "initial_upload");
});

test("manual page refresh keeps the existing batch kind but gets a clear page-update label", () => {
  const groups = groupProcessingJobBatches([
    job({
      id: "page-ocr",
      batchId: "page-batch",
      batchKind: "manual_reprocess",
      batchStartedAt: "2026-08-04 10:00:00",
      pipelineVersion: "manual-page-v1",
      status: "processing"
    })
  ]);
  assert.equal(groups.currentBatch?.kind, "manual_reprocess");
  assert.equal(processingJobBatchLabel(groups.currentBatch!), "页面更新");
});

test("report detail derives actions and loading state from the current batch only", () => {
  const reportDetail = readFileSync(join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"), "utf8");
  assert.match(reportDetail, /const hasRunningJobs = computed\(\(\) => currentJobs\.value\.some/);
  assert.match(reportDetail, /const aiJobs = computed\(\(\) => currentJobs\.value\.filter/);
  assert.match(reportDetail, /resolveAiTriggerState\(\{[\s\S]*?jobs: currentJobs\.value/);
  assert.doesNotMatch(reportDetail, /const hasRunningJobs = computed\(\(\) => selectedJobs\.value\.some/);
});

test("report detail folds history and does not expose direct retry actions there", () => {
  const reportDetail = readFileSync(join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"), "utf8")
    .replace(/\r\n/g, "\n");
  const historyStart = reportDetail.indexOf('<details v-if="historicalBatches.length"');
  const historyEnd = reportDetail.indexOf('</details>\n      </div>\n    </article>', historyStart);
  assert.ok(historyStart > 0 && historyEnd > historyStart);
  const historyTemplate = reportDetail.slice(historyStart, historyEnd);
  assert.match(historyTemplate, /历史处理记录/);
  assert.match(historyTemplate, /openJobEvents\(job\)/);
  assert.doesNotMatch(historyTemplate, /retryJob\(job\)/);
});

test("current failed jobs keep log and retry recovery entrances", () => {
  const reportDetail = readFileSync(join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"), "utf8");
  const currentStart = reportDetail.indexOf('<section v-if="currentBatch"');
  const historyStart = reportDetail.indexOf('<details v-if="historicalBatches.length"', currentStart);
  const currentTemplate = reportDetail.slice(currentStart, historyStart);
  assert.match(currentTemplate, /openJobEvents\(job\)/);
  assert.match(currentTemplate, /retryJob\(job\)/);
});
