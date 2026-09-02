import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ClinicalEvidence, ProcessingJob } from "../../ui/src/types/api.ts";
import { resolveAiTriggerState } from "../../ui/src/utils/ai-trigger-state.ts";
import { resolveClinicalEvidenceNavigation } from "../../ui/src/utils/clinical-evidence-navigation.ts";
import { processingJobBatchLabel } from "../../ui/src/utils/processing-job-batches.ts";
import { resolveReportReprocessNotice } from "../../ui/src/utils/report-reprocess-state.ts";

const golden = JSON.parse(readFileSync(
  join(process.cwd(), "packages/server/tests/fixtures/p3-page-edit-ui-state-golden.json"),
  "utf8"
)) as {
  pageMutationButtonLabel: string;
  pageBatchLabel: string;
  pageRefreshNoticeTitle: string;
  evidence: {
    references: number[];
    currentPages: number[];
    expectedPageNumber: number;
    expectedPageIndex: number;
    missingPageNumber: number;
  };
};

function processingJob(overrides: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: "page-job",
    pageId: "page-2",
    pageNumber: 2,
    originalName: "page-2.png",
    jobType: "ocr",
    pipelineVersion: "manual-page-v1",
    batchId: "page-batch",
    batchKind: "manual_reprocess",
    batchStartedAt: "2026-08-07 10:00:00",
    batchSequence: 1,
    status: "processing",
    attempts: 1,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-08-07 10:00:00",
    startedAt: "2026-08-07 10:00:01",
    finishedAt: null,
    ocrEngine: null,
    ocrModelVersion: null,
    ocrElapsedMs: null,
    ocrTextLength: null,
    ocrQualityLevel: null,
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

test("page mutation and manual-page jobs keep AI actions disabled with explicit progress", () => {
  assert.deepEqual(resolveAiTriggerState({
    triggeringAi: false,
    pageMutationPending: true,
    jobsLoading: false,
    reportStatus: "ready",
    jobs: []
  }), {
    disabled: true,
    loading: true,
    label: golden.pageMutationButtonLabel
  });

  for (const current of [
    processingJob({ jobType: "thumbnail", status: "queued" }),
    processingJob({ jobType: "ocr", status: "processing" }),
    processingJob({ jobType: "ai_extract", pageId: null, pageNumber: null, status: "queued" })
  ]) {
    assert.equal(resolveAiTriggerState({
      triggeringAi: false,
      jobsLoading: false,
      reportStatus: "processing",
      jobs: [current]
    }).disabled, true);
  }
});

test("manual page refresh has a dedicated batch label and preserved-result notice", () => {
  const current = processingJob();
  assert.equal(processingJobBatchLabel({ kind: current.batchKind, jobs: [current] }), golden.pageBatchLabel);
  assert.equal(
    resolveReportReprocessNotice([current], true)?.title,
    golden.pageRefreshNoticeTitle
  );
});

test("evidence navigation skips stale references and resolves the first current page", () => {
  const evidence = golden.evidence.references.map((pageNumber) => ({ pageNumber, quote: `第 ${pageNumber} 页` })) as ClinicalEvidence;
  const pages = golden.evidence.currentPages.map((pageNumber) => ({ pageNumber }));
  assert.deepEqual(resolveClinicalEvidenceNavigation(evidence, pages), {
    status: "ready",
    pageNumber: golden.evidence.expectedPageNumber,
    pageIndex: golden.evidence.expectedPageIndex
  });
  assert.deepEqual(resolveClinicalEvidenceNavigation([
    { pageNumber: golden.evidence.missingPageNumber, quote: "已删除页" }
  ], pages), {
    status: "page_not_found",
    pageNumber: golden.evidence.missingPageNumber,
    pageIndex: null
  });
  assert.equal(resolveClinicalEvidenceNavigation(evidence, pages, true).status, "pending");
});

test("report detail keeps page mutation, job refresh, and evidence navigation in one UI boundary", () => {
  const reportDetail = readFileSync(join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"), "utf8");
  assert.match(reportDetail, /pageMutationPending: savingPages\.value \|\| pageRefreshAwaitingJobs\.value/);
  assert.match(reportDetail, /resolveClinicalEvidenceNavigation\([\s\S]*?savingPages\.value/);
  assert.match(reportDetail, /:disabled="savingPages" @click="openClinicalEvidence/);
  assert.match(reportDetail, /pages\/[\s\S]*?method: "DELETE"[\s\S]*?pageRefreshAwaitingJobs\.value = true[\s\S]*?await refreshJobs\(true\)[\s\S]*?savingPages\.value = false/);
  assert.match(reportDetail, /method: "PUT"[\s\S]*?pageRefreshAwaitingJobs\.value = true[\s\S]*?await refreshJobs\(true\)[\s\S]*?savingPages\.value = false/);
  assert.match(reportDetail, /processingJobBatchLabel\(currentBatch\)/);
});
