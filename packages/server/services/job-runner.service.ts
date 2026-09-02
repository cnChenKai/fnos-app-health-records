import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import {
  ocrRecognitionModeCatalog,
  type OcrRecognitionMode,
} from "../domain/ocr-recognition";
import { createId } from "../utils/identifier";
import { writeLog } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";
import { assertMemberAccess, assertMemberManage } from "./member.service";
import {
  requestWorker,
  type WorkerRequest,
  type WorkerResponse,
} from "./ocr-worker-client";
import {
  isAiExtractionConfigured,
  persistAiExtraction,
  requestAiExtraction,
  type AiExecutor,
} from "./ai-extraction.service";
import { executeAiExtractionPlan } from "./ai-extraction-orchestrator.service";
import { rebuildMorphologyTrackingForReport } from "./morphology-finding.service";
import { normalizeReportObservations } from "./indicator-normalization.service";
import { listManualReportFieldKeys } from "./report-field-overrides.service";
import { findLocalDuplicateEvidence } from "./report-duplicate-precheck.service";
import { enqueueFileGarbage } from "./file-gc.service";
import {
  loadProcessingBatchForJob,
  loadReportProcessingBatchContext,
  parseProcessingJobQueuedDetail,
  type ProcessingJobQueuedDetail,
} from "./processing-job-batches.service";
import { buildProcessingJobDiagnostics } from "./processing-job-diagnostics.service";
import {
  getOcrRecognitionSettings,
  validateOcrBatchSelection,
  type OcrBatchSelectionInput,
} from "./ocr-recognition-settings.service";
import {
  recognizePageWithMinerU,
  type MinerURecognitionResult,
  type MinerURecognitionExecutor,
  type MinerURemoteReference,
} from "./mineru-client.service";

type JobRow = {
  id: string;
  reportId: string;
  pageId: string | null;
  jobType: "pdf_extract" | "thumbnail" | "ocr" | "ai_extract";
  pipelineVersion: string;
  attempts: number;
  storagePath: string | null;
  fileSize: number | null;
  thumbnailPath: string | null;
  mimeType: string | null;
  pageNumber: number | null;
  sourcePageNumber: number | null;
  sourcePageCount: number | null;
  rotation: number | null;
};

export type WorkerExecutor = (
  request: WorkerRequest,
) => Promise<WorkerResponse>;

type JobExecutionResponse = MinerURecognitionResult;

const maxAttempts = 3;
const retryDelays = [30, 120, 600];
const permanentSourceErrorCodes = new Set([
  "INPUT_FORMAT_MISMATCH",
  "IMAGE_DECODE_FAILED",
  "PDF_DECODE_FAILED",
  "MINERU_LIMIT_EXCEEDED_LOCAL_RUNTIME_UNAVAILABLE",
]);
function leaseHeartbeatIntervalMs() {
  const value = Number(process.env.PROCESSING_JOB_LEASE_HEARTBEAT_INTERVAL_MS);
  if (!Number.isFinite(value)) return 60_000;
  return Math.min(4 * 60_000, Math.max(25, Math.round(value)));
}
let started = false;
let busy = false;
let timer: NodeJS.Timeout | null = null;
let lastRunAt: string | null = null;
let lastError: string | null = null;
let activeJob: { id: string; reportId: string } | null = null;

type JobEventType =
  | "queued"
  | "started"
  | "completed"
  | "retry_scheduled"
  | "failed"
  | "manual_retry"
  | "cancelled";

function safeDetailJson(detail?: Record<string, unknown>) {
  if (!detail) return "{}";
  return JSON.stringify(detail, (_key, value) => {
    if (typeof value === "string") return value.slice(0, 500);
    return value;
  });
}

function hasOcrRuntime(config = getAppConfig()) {
  if (!existsSync(config.ocrPythonBin) || !existsSync(config.ocrWorkerScript))
    return false;
  const markerPath = join(dirname(dirname(config.ocrPythonBin)), ".health-records-ocr-ready");
  if (!existsSync(markerPath))
    return false;
  if (process.arch === "arm64") {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        backend?: string;
        engine?: string;
      };
      if ((marker.engine || marker.backend) !== "rapidocr-onnxruntime") return false;
    } catch {
      return false;
    }
  }
  const statusPath = join(
    config.storageDir,
    "config",
    "ocr-install-status.json",
  );
  if (!existsSync(statusPath)) return true;
  try {
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
      state?: string;
    };
    return status.state !== "failed";
  } catch {
    return false;
  }
}

function appendJobEvent(input: {
  jobId: string;
  reportId: string;
  eventType: JobEventType;
  status: string;
  attempt?: number;
  message?: string | null;
  detail?: Record<string, unknown>;
}) {
  getDatabase()
    .prepare(
      `
    INSERT INTO processing_job_events (
      id, job_id, report_id, event_type, status, attempt, message, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      createId("event"),
      input.jobId,
      input.reportId,
      input.eventType,
      input.status,
      Math.max(0, Math.round(input.attempt || 0)),
      input.message?.slice(0, 500) || null,
      safeDetailJson(input.detail),
    );
}

function queueRemoteSourceJob(
  reportId: string,
  pageId: string,
  pipelineVersion: string,
  detail: ProcessingJobQueuedDetail,
  source: string,
) {
  const jobId = createId("job");
  const batchId = detail.batchId || "initial-upload";
  const result = getDatabase().prepare(
    `
    INSERT OR IGNORE INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, ?, 'ocr', ?, ?)
  `,
  ).run(
    jobId,
    reportId,
    pageId,
    pipelineVersion,
    `${reportId}:${pageId}:ocr:remote-source:${batchId}`,
  );
  if (Number(result.changes) < 1) return false;
  appendJobEvent({
    jobId,
    reportId,
    eventType: "queued",
    status: "queued",
    message: "已恢复 MinerU 源文件识别任务",
    detail: {
      jobType: "ocr",
      pageId,
      source,
      batchId,
      remoteScope: "source",
      ocrMode: detail.ocrMode,
      remoteProcessingAccepted: detail.remoteProcessingAccepted,
      previousReportStatus: detail.previousReportStatus,
    },
  });
  return true;
}

function reconcileLegacyRemoteJobs() {
  const db = getDatabase();
  const candidates = db.prepare(
    `
    SELECT j.id, j.report_id AS reportId, j.page_id AS pageId, j.job_type AS jobType,
      j.pipeline_version AS pipelineVersion, j.status, j.attempts,
      p.storage_path AS storagePath, p.page_number AS pageNumber,
      p.mime_type AS mimeType
    FROM processing_jobs j
    JOIN report_pages p ON p.id = j.page_id
    WHERE j.job_type IN ('pdf_extract', 'thumbnail', 'ocr')
      AND j.status IN ('queued', 'processing')
      AND EXISTS (
        SELECT 1 FROM processing_job_events queued
        WHERE queued.job_id = j.id AND queued.event_type = 'queued'
          AND queued.detail_json LIKE '%"ocrMode":"mineru_%'
      )
    ORDER BY j.report_id, p.storage_path, p.page_number, j.created_at, j.id
  `,
  ).all() as Array<{
    id: string;
    reportId: string;
    pageId: string;
    jobType: JobRow["jobType"];
    pipelineVersion: string;
    status: string;
    attempts: number;
    storagePath: string;
    pageNumber: number;
    mimeType: string;
  }>;
  const groups = new Map<string, {
    reportId: string;
    storagePath: string;
    pageId: string;
    pageNumber: number;
    pipelineVersion: string;
    detail: ProcessingJobQueuedDetail;
    hasSourceJob: boolean;
    submittedPageIds: Set<string>;
  }>();
  for (const candidate of candidates) {
    const detail = readQueuedJobDetail(candidate.id);
    if (detail.ocrMode === "local") continue;
    /* Keep the source path as structured data.  NAS paths can contain `:`;
       splitting a concatenated key would otherwise recover the wrong source. */
    const key = `${candidate.reportId}\u0000${candidate.storagePath}`;
    const group = groups.get(key) || {
      reportId: candidate.reportId,
      storagePath: candidate.storagePath,
      pageId: candidate.pageId,
      pageNumber: candidate.pageNumber,
      pipelineVersion: candidate.pipelineVersion,
      detail,
      hasSourceJob: detail.remoteScope === "source",
      submittedPageIds: new Set<string>(),
    };
    group.hasSourceJob ||= candidate.jobType === "ocr" && detail.remoteScope === "source";
    const resumeReference = candidate.jobType === "ocr" && detail.remoteScope !== "source"
      ? readMineruResumeReference(candidate.id, detail.ocrMode).reference
      : null;
    if (resumeReference) group.submittedPageIds.add(candidate.pageId);
    if (candidate.pageNumber < group.pageNumber) {
      group.pageId = candidate.pageId;
      group.pageNumber = candidate.pageNumber;
    }
    groups.set(key, group);
    /* A legacy OCR page that already has a remote task must continue polling
       that task.  Other legacy page OCR and all local prerequisites are no
       longer useful for remote batches and can be cancelled safely. */
    const preserveSubmittedPageJob = candidate.jobType === "ocr"
      && detail.remoteScope !== "source"
      && Boolean(resumeReference);
    if (candidate.jobType === "ocr" && detail.remoteScope === "source") continue;
    if (preserveSubmittedPageJob) continue;
    const cancelled = db.prepare(
      `
      UPDATE processing_jobs SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
        next_retry_at = NULL, error_code = 'MINERU_LEGACY_LOCAL_PREREQUISITE',
        error_message = '远程 OCR 不再依赖本地拆页/缩略图任务', finished_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('queued', 'processing')
    `,
    ).run(candidate.id);
    if (Number(cancelled.changes) < 1) continue;
    appendJobEvent({
      jobId: candidate.id,
      reportId: candidate.reportId,
      eventType: "cancelled",
      status: "cancelled",
      attempt: candidate.attempts,
      message: "远程 OCR 批次已移除本地前置任务",
      detail: {
        jobType: candidate.jobType,
        source: "legacy_remote_recovery",
        code: "MINERU_LEGACY_LOCAL_PREREQUISITE",
      },
    });
  }
  for (const group of groups.values()) {
    /* A submitted legacy page task is still valuable and must keep polling, but
       it only covers that one page.  Inspect the source rows and add one
       source-file task whenever another page has neither a completed OCR
       result nor an already-submitted remote task.  This handles a process
       restart in the middle of a PDF fan-out without leaving a partial report
       permanently stuck.  A one-page image with an already-submitted task is
       complete from the recovery scheduler's point of view and does not need a
       duplicate upload. */
    if (group.hasSourceJob) continue;
    const sourcePages = db.prepare(
      `
      SELECT p.id,
        EXISTS (
          SELECT 1 FROM ocr_results o
          JOIN processing_jobs completed ON completed.id = o.job_id
          WHERE o.page_id = p.id AND completed.job_type = 'ocr'
            AND completed.status = 'completed'
        ) AS hasCompletedOcr
      FROM report_pages p
      WHERE p.report_id = ? AND p.storage_path = ?
      ORDER BY p.page_number, p.id
    `,
    ).all(group.reportId, group.storagePath) as Array<{
      id: string;
      hasCompletedOcr: number;
    }>;
    const hasUncoveredPage = sourcePages.some((page) =>
      !page.hasCompletedOcr && !group.submittedPageIds.has(page.id),
    );
    if (hasUncoveredPage) {
      queueRemoteSourceJob(group.reportId, group.pageId, group.pipelineVersion, group.detail, "legacy_remote_recovery");
    }
  }
}

function appendDuplicateDetectedEvent(
  reportId: string,
  candidates: Array<{ reason: string }>,
  sourceJobId?: string,
) {
  const job = sourceJobId
    ? { id: sourceJobId }
    : (getDatabase()
        .prepare(
          `
        SELECT id FROM processing_jobs
        WHERE report_id = ? AND job_type = 'ocr' AND status = 'completed'
        ORDER BY finished_at DESC, created_at DESC, id DESC
        LIMIT 1
      `,
        )
        .get(reportId) as { id: string } | undefined);
  if (!job) return;
  const existing = getDatabase()
    .prepare(
      `
    SELECT 1 AS found FROM processing_job_events
    WHERE job_id = ? AND detail_json LIKE '%"stage":"duplicate_precheck"%'
    LIMIT 1
  `,
    )
    .get(job.id);
  if (existing) return;
  appendJobEvent({
    jobId: job.id,
    reportId,
    eventType: "completed",
    status: "completed",
    message: "本地重复检测发现高度重复候选，已暂缓自动 AI 整理",
    detail: {
      jobType: "ocr",
      stage: "duplicate_precheck",
      candidateCount: candidates.length,
      reasons: candidates.map((candidate) => candidate.reason),
    },
  });
}

function safeStoragePath(relativePath: string) {
  const root = resolve(getAppConfig().storageDir);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw Object.assign(new Error("存储路径越界"), {
      code: "INVALID_STORAGE_PATH",
    });
  }
  return path;
}

export function claimNextJob(options: { ignoreLocalRuntime?: boolean } = {}) {
  const db = getDatabase();
  const localRuntimeAvailable = options.ignoreLocalRuntime === true || hasOcrRuntime();
  db.exec("BEGIN IMMEDIATE");
  try {
    reconcileLegacyRemoteJobs();
    const expiredJobs = db
      .prepare(
        `
      SELECT j.id, j.report_id AS reportId, j.job_type AS jobType, j.attempts, r.status AS reportStatus
      FROM processing_jobs j JOIN reports r ON r.id = j.report_id
      WHERE j.status = 'processing'
        AND (lease_expires_at IS NULL OR lease_expires_at < CURRENT_TIMESTAMP)
    `,
      )
      .all() as Array<{
      id: string;
      reportId: string;
      jobType: JobRow["jobType"];
      attempts: number;
      reportStatus: string;
    }>;
    const reportsToReconcile = new Set<string>();
    for (const expired of expiredJobs) {
      if (expired.reportStatus === "trashed") {
        db.prepare(
          `
          UPDATE processing_jobs SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
            next_retry_at = NULL, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
          WHERE id = ? AND status = 'processing'
        `,
        ).run(expired.id);
        appendJobEvent({
          jobId: expired.id,
          reportId: expired.reportId,
          eventType: "cancelled",
          status: "cancelled",
          attempt: expired.attempts,
          message: "报告已进入回收站，过期任务不再恢复",
          detail: { jobType: expired.jobType, source: "lease_recovery" },
        });
        continue;
      }
      const finalFailure = expired.attempts >= maxAttempts;
      db.prepare(
        `
        UPDATE processing_jobs SET
          status = ?, error_code = CASE WHEN ? THEN 'LEASE_EXPIRED' ELSE error_code END,
          error_message = CASE WHEN ? THEN '任务执行超时' ELSE error_message END,
          locked_at = NULL, lease_expires_at = NULL,
          next_retry_at = CASE WHEN ? THEN NULL ELSE CURRENT_TIMESTAMP END,
          finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END
        WHERE id = ? AND status = 'processing'
      `,
      ).run(
        finalFailure ? "failed" : "queued",
        finalFailure ? 1 : 0,
        finalFailure ? 1 : 0,
        finalFailure ? 1 : 0,
        finalFailure ? 1 : 0,
        expired.id,
      );
      appendJobEvent({
        jobId: expired.id,
        reportId: expired.reportId,
        eventType: finalFailure ? "failed" : "retry_scheduled",
        status: finalFailure ? "failed" : "queued",
        attempt: expired.attempts,
        message: finalFailure
          ? "任务执行超时，已达到最大重试次数"
          : "任务租约过期，已自动恢复到队列",
        detail: {
          code: "LEASE_EXPIRED",
          jobType: expired.jobType,
          finalFailure,
          source: "lease_recovery",
        },
      });
      reportsToReconcile.add(expired.reportId);
    }
    const orphanedReports = db
      .prepare(
        `
      SELECT r.id
      FROM reports r
      WHERE r.status = 'processing'
        AND NOT EXISTS (
          SELECT 1 FROM processing_jobs j
          WHERE j.report_id = r.id AND j.status IN ('queued', 'processing')
        )
    `,
      )
      .all() as Array<{ id: string }>;
    for (const report of orphanedReports) reportsToReconcile.add(report.id);
    for (const reportId of reportsToReconcile)
      reconcileReportProcessingStatus(reportId);

    /* When the local runtime is unavailable, do the capability check in SQL
       before applying the scheduling limit.  Filtering the first 100 rows in
       JavaScript lets a large backlog of local PDF/thumbnail jobs hide a
       runnable MinerU or AI job behind the limit.  Legacy jobs without an
       explicit mode intentionally stay out of this lane and are handled by a
       local runner once the runtime is installed. */
    const runtimeFilter = localRuntimeAvailable
      ? ""
      : `
        AND (
          j.job_type = 'ai_extract'
          OR (
            j.job_type = 'ocr'
            AND EXISTS (
              SELECT 1 FROM processing_job_events remoteQueued
              WHERE remoteQueued.job_id = j.id
                AND remoteQueued.event_type = 'queued'
                AND remoteQueued.detail_json LIKE '%\"ocrMode\":\"mineru_%'
            )
          )
        )`;
    const candidates = db
      .prepare(
        `
      SELECT j.id, j.job_type AS jobType FROM processing_jobs j
      JOIN reports r ON r.id = j.report_id AND r.status <> 'trashed'
      LEFT JOIN report_pages p ON p.id = j.page_id
      WHERE j.status = 'queued'
        AND (j.next_retry_at IS NULL OR j.next_retry_at <= CURRENT_TIMESTAMP)
        ${runtimeFilter}
      ORDER BY
        CASE j.job_type WHEN 'pdf_extract' THEN 0 WHEN 'thumbnail' THEN 1 WHEN 'ocr' THEN 2 ELSE 3 END,
        CASE
          WHEN j.job_type = 'ai_extract' THEN 0
          ELSE COALESCE((
            SELECT MAX(event.rowid)
            FROM processing_job_events event
            JOIN processing_jobs dispatched ON dispatched.id = event.job_id
            WHERE event.report_id = j.report_id
              AND event.event_type = 'started'
              AND dispatched.job_type = j.job_type
          ), 0)
        END,
        COALESCE(p.page_number, 2147483647),
        j.created_at, j.id
      LIMIT 100
    `,
      )
      .all() as Array<{ id: string; jobType: JobRow["jobType"] }>;
    const candidate = candidates[0];
    if (!candidate) {
      db.exec("COMMIT");
      return null;
    }
    const claimed = db
      .prepare(
        `
      UPDATE processing_jobs SET status = 'processing', attempts = attempts + 1,
        locked_at = CURRENT_TIMESTAMP, lease_expires_at = datetime('now', '+5 minutes'),
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP), next_retry_at = NULL
      WHERE id = ? AND status = 'queued'
    `,
      )
      .run(candidate.id);
    if (Number(claimed.changes) < 1) {
      db.exec("COMMIT");
      return null;
    }
    const job = db
      .prepare(
        `
      SELECT j.id, j.report_id AS reportId, j.page_id AS pageId, j.job_type AS jobType,
        j.pipeline_version AS pipelineVersion, j.attempts, p.storage_path AS storagePath, p.file_size AS fileSize,
        p.thumbnail_path AS thumbnailPath, p.mime_type AS mimeType,
        p.page_number AS pageNumber, p.source_page_number AS sourcePageNumber,
        p.source_page_count AS sourcePageCount, p.rotation
      FROM processing_jobs j LEFT JOIN report_pages p ON p.id = j.page_id WHERE j.id = ?
    `,
      )
      .get(candidate.id) as JobRow;
    db.prepare(
      "UPDATE reports SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'trashed'",
    ).run(job.reportId);
    appendJobEvent({
      jobId: job.id,
      reportId: job.reportId,
      eventType: "started",
      status: "processing",
      attempt: job.attempts,
      detail: {
        jobType: job.jobType,
        pageId: job.pageId,
        pageNumber: job.pageNumber,
        schedulerPolicy: "report-round-robin-v1",
        schedulerLane: job.jobType,
      },
    });
    db.exec("COMMIT");
    return job;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function isJobStillProcessable(job: JobRow) {
  const row = getDatabase()
    .prepare(
      `
    SELECT j.status, j.report_id AS reportId, r.status AS reportStatus,
      j.page_id AS pageId, p.report_id AS pageReportId
    FROM processing_jobs j
    JOIN reports r ON r.id = j.report_id
    LEFT JOIN report_pages p ON p.id = j.page_id
    WHERE j.id = ?
  `,
    )
    .get(job.id) as
    | {
        status: string;
        reportId: string;
        reportStatus: string;
        pageId: string | null;
        pageReportId: string | null;
      }
    | undefined;
  if (!row || row.status !== "processing" || row.reportStatus === "trashed")
    return false;
  if (row.reportId !== job.reportId || row.pageId !== job.pageId) return false;
  return !row.pageId || row.pageReportId === row.reportId;
}

export function isReportJobActive(reportId: string) {
  return activeJob?.reportId === reportId;
}

function queueJob(
  reportId: string,
  pageId: string,
  jobType: "thumbnail" | "ocr",
  inheritedDetail?: ProcessingJobQueuedDetail,
  deduplicationSuffix = "",
) {
  const jobId = createId("job");
  const result = getDatabase()
    .prepare(
      `
    INSERT OR IGNORE INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, ?, ?, 'worker-v1', ?)
  `,
    )
    .run(
      jobId,
      reportId,
      pageId,
      jobType,
      `${reportId}:${pageId}:${jobType}:worker-v1${deduplicationSuffix ? `:${deduplicationSuffix}` : ""}`,
    );
  if (Number(result.changes) > 0) {
    appendJobEvent({
      jobId,
      reportId,
      eventType: "queued",
      status: "queued",
      detail: {
        jobType,
        pageId,
        source: "worker",
        ...(inheritedDetail?.batchId ? { batchId: inheritedDetail.batchId } : {}),
        ...(inheritedDetail?.previousReportStatus
          ? { previousReportStatus: inheritedDetail.previousReportStatus }
          : {}),
        ...(inheritedDetail?.remoteScope ? { remoteScope: inheritedDetail.remoteScope } : {}),
        ocrMode: inheritedDetail?.ocrMode || "local",
        remoteProcessingAccepted: inheritedDetail?.remoteProcessingAccepted === true,
      },
    });
  }
}

function readQueuedJobDetail(jobId: string): ProcessingJobQueuedDetail {
  const event = getDatabase()
    .prepare(
      `
    SELECT detail_json AS detailJson
    FROM processing_job_events
    WHERE job_id = ? AND event_type = 'queued'
    ORDER BY created_at, rowid
    LIMIT 1
  `,
    )
    .get(jobId) as { detailJson: string } | undefined;
  return parseProcessingJobQueuedDetail(event?.detailJson);
}

function reportOcrTextLength(reportId: string) {
  /* text_length 列后加，旧行只按 lines_json 是否含文本估算，避免把历史报告误判为空 */
  const row = getDatabase()
    .prepare(
      `
    SELECT COALESCE(SUM(
      CASE
        WHEN o.text_length IS NOT NULL THEN o.text_length
        WHEN o.lines_json IS NOT NULL AND o.lines_json NOT IN ('', '[]') THEN 1
        ELSE 0
      END
    ), 0) AS total
    FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
    WHERE p.report_id = ?
  `,
    )
    .get(reportId) as { total: number };
  return Number(row.total || 0);
}

function isLastActiveOcrJobForReport(job: JobRow) {
  if (job.jobType !== "ocr") return false;
  const row = getDatabase()
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM processing_jobs
    WHERE report_id = ? AND id <> ?
      AND job_type IN ('ocr', 'pdf_extract')
      AND status IN ('queued', 'processing')
  `,
    )
    .get(job.reportId, job.id) as { count: number };
  /*
   * A delayed PDF inspection can create more OCR pages later. Treating the
   * currently visible OCR as the report boundary would recycle the worker
   * between pages of the same mixed report and waste a costly model reload.
   */
  return Number(row.count || 0) === 0;
}

function readQueuedJobBatchId(reportId: string, jobId?: string) {
  if (!jobId) return null;
  const detail = readQueuedJobDetail(jobId);
  return detail.batchId;
}

function queueAiJobIfReady(reportId: string, sourceJobId?: string) {
  if (!isAiExtractionConfigured()) return false;
  const db = getDatabase();
  const batchContext = sourceJobId
    ? loadProcessingBatchForJob(reportId, sourceJobId)
    : null;
  const sourceQueuedDetail = sourceJobId ? batchContext?.queuedDetails.get(sourceJobId) : undefined;
  const batchJobs = batchContext?.batchJobs || [];
  const activeLocal = batchJobs.filter(
    (job) =>
      job.jobType !== "ai_extract" &&
      ["queued", "processing"].includes(job.status),
  ).length;
  const failedLocal = batchJobs.filter(
    (job) => job.jobType !== "ai_extract" && job.status === "failed",
  ).length;
  const completedOcr = batchJobs.filter(
    (job) => job.jobType === "ocr" && job.status === "completed",
  ).length;
  const activeAi = batchJobs.filter(
    (job) =>
      job.jobType === "ai_extract" &&
      ["queued", "processing"].includes(job.status),
  ).length;
  const completedAi = batchJobs.filter(
    (job) => job.jobType === "ai_extract" && job.status === "completed",
  ).length;
  if (activeLocal > 0 || failedLocal > 0 || completedOcr < 1) return false;
  if (reportOcrTextLength(reportId) < 1) return false;
  if (activeAi > 0) return false;
  const sourceJob = sourceJobId
    ? (db
        .prepare(
          `
        SELECT pipeline_version AS pipelineVersion
        FROM processing_jobs
        WHERE id = ? AND report_id = ?
      `,
        )
        .get(sourceJobId, reportId) as { pipelineVersion: string } | undefined)
    : undefined;
  const isManualRefresh =
    sourceJob?.pipelineVersion === "manual-reprocess-v1" ||
    sourceJob?.pipelineVersion === "manual-page-v1";
  const batchId = isManualRefresh
    ? readQueuedJobBatchId(reportId, sourceJobId)
    : null;
  const duplicateCandidates = findLocalDuplicateEvidence(reportId).filter(
    (candidate) => candidate.confidence === "high",
  );
  if (duplicateCandidates.length) {
    appendDuplicateDetectedEvent(reportId, duplicateCandidates, sourceJobId);
    return false;
  }
  if (!isManualRefresh && completedAi > 0) {
    const report = db
      .prepare("SELECT title FROM reports WHERE id = ?")
      .get(reportId) as { title: string } | undefined;
    if (report?.title !== "待识别报告") return false;
  }
  const pipelineVersion = isManualRefresh
    ? sourceJob?.pipelineVersion || "manual-reprocess-v1"
    : "health-record-v1";
  const result = db.prepare(`
    INSERT OR IGNORE INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, NULL, 'ai_extract', ?, ?)
  `);
  const jobId = createId("job");
  const deduplicationKey = batchId
    ? `${reportId}:ai_extract:auto:${batchId}:${jobId}`
    : `${reportId}:ai_extract:auto:${jobId}`;
  const queued = result.run(jobId, reportId, pipelineVersion, deduplicationKey);
  if (Number(queued.changes) > 0) {
    appendJobEvent({
      jobId,
      reportId,
      eventType: "queued",
      status: "queued",
      detail: {
        jobType: "ai_extract",
        source: "ocr_completed",
        ...(batchId ? { batchId } : {}),
        ...(batchContext?.previousReportStatus
          ? { previousReportStatus: batchContext.previousReportStatus }
          : {}),
        ocrMode: sourceQueuedDetail?.ocrMode || "local",
        remoteProcessingAccepted: sourceQueuedDetail?.remoteProcessingAccepted === true,
      },
    });
  }
  return Number(queued.changes) > 0;
}

function expandPdf(
  job: JobRow,
  response: WorkerResponse,
  inheritedDetailOverride?: ProcessingJobQueuedDetail,
  deduplicationSuffix = "",
) {
  if (!job.pageId || job.pageNumber === null)
    throw new Error("PDF 任务缺少页面信息");
  const pageCount = Math.round(Number(response.pageCount || 0));
  if (pageCount < 1 || pageCount > 500) {
    throw Object.assign(new Error("PDF 页数无效或超过 500 页"), {
      code: "INVALID_PDF_PAGE_COUNT",
    });
  }
  const inspectedPages = Array.isArray(response.pages) ? response.pages : [];
  const inspectedPageNumbers = inspectedPages
    .map((page) => Math.round(Number(page.pageNumber)))
    .filter((pageNumber) => Number.isFinite(pageNumber))
    .sort((left, right) => left - right);
  if (
    inspectedPageNumbers.length !== pageCount ||
    inspectedPageNumbers.some((pageNumber, index) => pageNumber !== index + 1)
  ) {
    throw Object.assign(
      new Error(
        `PDF 页数检查不完整：声明 ${pageCount} 页，实际返回 ${inspectedPageNumbers.length} 页`,
      ),
      { code: "PDF_INSPECTION_INCOMPLETE" },
    );
  }
  const db = getDatabase();
  const inheritedDetail = inheritedDetailOverride || readQueuedJobDetail(job.id);
  const source = db
    .prepare(
      `
    SELECT original_name AS originalName, storage_path AS storagePath, mime_type AS mimeType,
      file_size AS fileSize, sha256, rotation, source_page_count AS sourcePageCount
    FROM report_pages WHERE id = ?
  `,
    )
    .get(job.pageId) as {
    originalName: string;
    storagePath: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    rotation: number;
    sourcePageCount: number | null;
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    if (source.sourcePageCount && source.sourcePageCount !== pageCount) {
      throw Object.assign(
        new Error(
          `PDF 页数发生变化：已记录 ${source.sourcePageCount} 页，本次检查为 ${pageCount} 页`,
        ),
        { code: "PDF_PAGE_COUNT_MISMATCH" },
      );
    }
    if (!source.sourcePageCount) {
      if (pageCount > 1) {
        db.prepare(
          `
          UPDATE report_pages SET page_number = -page_number
          WHERE report_id = ? AND page_number > ?
        `,
        ).run(job.reportId, job.pageNumber);
        db.prepare(
          `
          UPDATE report_pages SET page_number = -page_number + ?
          WHERE report_id = ? AND page_number < 0
        `,
        ).run(pageCount - 1, job.reportId);
      }
      db.prepare(
        `
        UPDATE report_pages SET source_page_number = 1, source_page_count = ? WHERE id = ?
      `,
      ).run(pageCount, job.pageId);
      for (let sourcePage = 2; sourcePage <= pageCount; sourcePage += 1) {
        const pageId = createId("page");
        db.prepare(
          `
          INSERT INTO report_pages (
            id, report_id, page_number, original_name, storage_path, mime_type, file_size,
            sha256, rotation, source_page_number, source_page_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          pageId,
          job.reportId,
          job.pageNumber + sourcePage - 1,
          source.originalName,
          source.storagePath,
          source.mimeType,
          source.fileSize,
          source.sha256,
          source.rotation,
          sourcePage,
          pageCount,
        );
        queueJob(job.reportId, pageId, "thumbnail", inheritedDetail, deduplicationSuffix);
        queueJob(job.reportId, pageId, "ocr", inheritedDetail, deduplicationSuffix);
      }
      if (inheritedDetail.source === "mineru_limit_fallback") {
        queueJob(job.reportId, job.pageId, "thumbnail", inheritedDetail, deduplicationSuffix);
      }
      queueJob(job.reportId, job.pageId, "ocr", inheritedDetail, deduplicationSuffix);
    }
    const expandedPages = db
      .prepare(
        `
      SELECT source_page_number AS sourcePageNumber, source_page_count AS sourcePageCount
      FROM report_pages
      WHERE report_id = ? AND storage_path = ?
      ORDER BY source_page_number
    `,
      )
      .all(job.reportId, source.storagePath) as Array<{
      sourcePageNumber: number | null;
      sourcePageCount: number | null;
    }>;
    if (
      expandedPages.length !== pageCount ||
      expandedPages.some(
        (page, index) =>
          page.sourcePageNumber !== index + 1 ||
          page.sourcePageCount !== pageCount,
      )
    ) {
      throw Object.assign(
        new Error(
          `PDF 拆页记录不完整：应有 ${pageCount} 页，实际生成 ${expandedPages.length} 页`,
        ),
        { code: "PDF_PAGE_EXPANSION_INCOMPLETE" },
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function scoreOcrQuality(lines: Array<Record<string, unknown>>) {
  const texts = lines
    .map((line) => (typeof line.text === "string" ? line.text.trim() : ""))
    .filter(Boolean);
  const text = texts.join("\n");
  const textLength = text.length;
  const digitCount = (text.match(/\d/g) || []).length;
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  const usefulRatio = textLength
    ? (digitCount + cjkCount + latinCount) / textLength
    : 0;
  const confidences = lines
    .map((line) => Number(line.confidence))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  const avgConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  let score = 0;
  if (texts.length >= 20) score += 30;
  else if (texts.length >= 8) score += 20;
  else if (texts.length >= 3) score += 10;
  if (textLength >= 800) score += 30;
  else if (textLength >= 300) score += 22;
  else if (textLength >= 80) score += 12;
  if (digitCount >= 20) score += 15;
  else if (digitCount >= 6) score += 8;
  if (usefulRatio >= 0.65) score += 15;
  else if (usefulRatio >= 0.45) score += 8;
  if (avgConfidence >= 0.85) score += 10;
  else if (avgConfidence >= 0.65) score += 6;
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  const level = bounded >= 70 ? "good" : bounded >= 40 ? "weak" : "poor";
  const reason = [
    `文本${textLength}字`,
    `${texts.length}行`,
    digitCount ? `数字${digitCount}个` : "数字少",
    confidences.length
      ? `均值置信度${Math.round(avgConfidence * 100)}%`
      : "无置信度",
  ].join(" · ");
  return { score: bounded, level, reason, textLength };
}

function persistOcrResult(
  db: ReturnType<typeof getDatabase>,
  jobId: string,
  pageId: string,
  response: WorkerResponse,
  lines: Array<Record<string, unknown>>,
) {
  const quality = scoreOcrQuality(lines);
  const coordWidth =
    typeof response.coordWidth === "number" &&
    Number.isFinite(response.coordWidth) &&
    response.coordWidth > 0
      ? response.coordWidth
      : null;
  const coordHeight =
    typeof response.coordHeight === "number" &&
    Number.isFinite(response.coordHeight) &&
    response.coordHeight > 0
      ? response.coordHeight
      : null;
  db.prepare(
    `
    INSERT INTO ocr_results (
      id, job_id, page_id, engine, model_version, lines_json,
      quality_score, quality_level, quality_reason, text_length, elapsed_ms,
      coord_width, coord_height
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      engine = excluded.engine, model_version = excluded.model_version,
      lines_json = excluded.lines_json,
      quality_score = excluded.quality_score,
      quality_level = excluded.quality_level,
      quality_reason = excluded.quality_reason,
      text_length = excluded.text_length,
      elapsed_ms = excluded.elapsed_ms,
      coord_width = excluded.coord_width,
      coord_height = excluded.coord_height
  `,
  ).run(
    createId("ocr"),
    jobId,
    pageId,
    response.engine || "rapidocr-openvino",
    response.modelVersion || "unknown",
    JSON.stringify(lines),
    quality.score,
    quality.level,
    quality.reason,
    quality.textLength,
    response.elapsedMs || null,
    coordWidth,
    coordHeight,
  );
  db.prepare("DELETE FROM ocr_results WHERE page_id = ? AND job_id <> ?")
    .run(pageId, jobId);
}

/*
 * A report can contain pages from several source files, and an earlier
 * precise/local run may have expanded one PDF into several report_pages.  An
 * Agent rerun intentionally changes that source to one logical page.  Keep
 * the old structured result usable while the replacement AI job is pending by
 * remapping evidence references before removing the obsolete child pages.
 */
const remoteCollapseEvidenceTables = [
  "observations",
  "morphology_findings",
  "report_diagnoses",
  "report_medications",
  "report_procedures",
  "vaccination_records",
  "billing_summaries",
  "billing_items",
  "report_structured_sections",
] as const;

function remapRemoteCollapseEvidence(value: unknown, pageMapping: Map<number, number>): unknown {
  if (Array.isArray(value)) return value.map((entry) => remapRemoteCollapseEvidence(entry, pageMapping));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const pageNumber = Number(record.pageNumber);
  const mappedPage = Number.isInteger(pageNumber) && pageNumber > 0
    ? pageMapping.get(pageNumber)
    : undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    output[key] = remapRemoteCollapseEvidence(entry, pageMapping);
  }
  if (mappedPage !== undefined) output.pageNumber = mappedPage;
  return output;
}

function remapEvidenceForRemoteCollapse(
  db: ReturnType<typeof getDatabase>,
  reportId: string,
  pageMapping: Map<number, number>,
) {
  for (const table of remoteCollapseEvidenceTables) {
    const rows = db
      .prepare(`SELECT id, evidence_json AS evidenceJson FROM ${table} WHERE report_id = ?`)
      .all(reportId) as Array<{ id: string; evidenceJson: string }>;
    const update = db.prepare(`UPDATE ${table} SET evidence_json = ? WHERE id = ?`);
    for (const row of rows) {
      try {
        update.run(
          JSON.stringify(remapRemoteCollapseEvidence(JSON.parse(row.evidenceJson), pageMapping)),
          row.id,
        );
      } catch {
        // Preserve malformed historical evidence rather than failing a valid OCR result.
      }
    }
  }
  const extractionRows = db
    .prepare(
      `
      SELECT id, fields_json AS fieldsJson, evidence_json AS evidenceJson,
        raw_response_json AS rawResponseJson
      FROM report_extractions WHERE report_id = ?
    `,
    )
    .all(reportId) as Array<{
    id: string;
    fieldsJson: string;
    evidenceJson: string;
    rawResponseJson: string;
  }>;
  const updateExtraction = db.prepare(
    `UPDATE report_extractions SET fields_json = ?, evidence_json = ?, raw_response_json = ? WHERE id = ?`,
  );
  const remapJson = (json: string) => {
    try {
      return JSON.stringify(remapRemoteCollapseEvidence(JSON.parse(json), pageMapping));
    } catch {
      return json;
    }
  };
  for (const row of extractionRows) {
    updateExtraction.run(
      remapJson(row.fieldsJson),
      remapJson(row.evidenceJson),
      remapJson(row.rawResponseJson),
      row.id,
    );
  }
}

function completeRemoteAgentPdf(job: JobRow, response: MinerURecognitionResult) {
  if (!job.pageId || !job.storagePath) {
    throw Object.assign(new Error("MinerU Agent 结果缺少源文件页面"), { code: "MINERU_INVALID_RESULT" });
  }
  const db = getDatabase();
  const inheritedDetail = readQueuedJobDetail(job.id);
  const allPages = db
    .prepare(
      `
      SELECT id, page_number AS pageNumber, storage_path AS storagePath,
        thumbnail_path AS thumbnailPath
      FROM report_pages WHERE report_id = ? ORDER BY page_number, id
    `,
    )
    .all(job.reportId) as Array<{
    id: string;
    pageNumber: number;
    storagePath: string;
    thumbnailPath: string | null;
  }>;
  const sourcePages = allPages.filter((page) => page.storagePath === job.storagePath);
  if (!sourcePages.length) {
    throw Object.assign(new Error("MinerU Agent 源文件页面不存在"), { code: "MINERU_INVALID_RESULT" });
  }
  const survivor = sourcePages.reduce((current, page) =>
    page.pageNumber < current.pageNumber ? page : current,
  );
  const retained = allPages.filter((page) =>
    page.id === survivor.id || page.storagePath !== job.storagePath,
  );
  const pageMapping = new Map<number, number>();
  const retainedPageNumbers = new Map<string, number>();
  retained.forEach((page, index) => {
    const pageNumber = index + 1;
    retainedPageNumbers.set(page.id, pageNumber);
    pageMapping.set(page.pageNumber, pageNumber);
  });
  const survivorPageNumber = retainedPageNumbers.get(survivor.id);
  if (!survivorPageNumber) {
    throw Object.assign(new Error("MinerU Agent 逻辑页排序失败"), { code: "MINERU_INVALID_RESULT" });
  }
  for (const page of sourcePages) pageMapping.set(page.pageNumber, survivorPageNumber);

  db.exec("BEGIN IMMEDIATE");
  try {
    const oldThumbnails = sourcePages
      .map((page) => page.thumbnailPath)
      .filter((path): path is string => Boolean(path));
    /* The claimed job may currently point at a child page that will be
       removed. Repoint it before the FK cascade deletes that page. */
    if (job.pageId !== survivor.id) {
      db.prepare("UPDATE processing_jobs SET page_id = ? WHERE id = ?")
        .run(survivor.id, job.id);
    }
    db.prepare("UPDATE report_pages SET page_number = -page_number WHERE report_id = ?")
      .run(job.reportId);
    const obsolete = sourcePages.filter((page) => page.id !== survivor.id);
    if (obsolete.length) {
      const placeholders = obsolete.map(() => "?").join(", ");
      db.prepare(`DELETE FROM report_pages WHERE id IN (${placeholders})`).run(
        ...obsolete.map((page) => page.id),
      );
    }
    db.prepare(
      `
      UPDATE report_pages
      SET page_number = ?, source_page_number = 1, source_page_count = NULL,
        thumbnail_path = NULL, width = NULL, height = NULL
      WHERE id = ? AND report_id = ?
    `,
    ).run(-survivorPageNumber, survivor.id, job.reportId);
    for (const page of retained) {
      if (page.id === survivor.id) continue;
      const nextPageNumber = retainedPageNumbers.get(page.id);
      if (!nextPageNumber) {
        throw Object.assign(new Error("MinerU Agent 逻辑页排序失败"), { code: "MINERU_INVALID_RESULT" });
      }
      db.prepare("UPDATE report_pages SET page_number = ? WHERE id = ? AND report_id = ?")
        .run(nextPageNumber, page.id, job.reportId);
    }
    db.prepare("UPDATE report_pages SET page_number = ? WHERE id = ? AND report_id = ?")
      .run(survivorPageNumber, survivor.id, job.reportId);
    remapEvidenceForRemoteCollapse(db, job.reportId, pageMapping);
    persistOcrResult(db, job.id, survivor.id, response, response.lines || []);
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'completed', locked_at = NULL, lease_expires_at = NULL,
        error_code = NULL, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ?
    `,
    ).run(job.id);
    if (oldThumbnails.length) {
      enqueueFileGarbage(
        oldThumbnails.map((storagePath) => ({ storagePath, fileKind: "thumbnail" as const })),
        "mineru_agent_logical_pdf",
        db,
      );
    }
    appendJobEvent({
      jobId: job.id,
      reportId: job.reportId,
      eventType: "completed",
      status: "completed",
      attempt: job.attempts,
      message: "MinerU Agent 已保存为整份文档逻辑页",
      detail: {
        jobType: "ocr",
        source: "mineru_agent",
        remoteScope: "source",
        pageId: survivor.id,
        pageCount: 1,
        pageMappingAvailable: false,
        requestedOcrMode: inheritedDetail.ocrMode,
        actualOcrEngine: response.engine,
        coordinateAvailable: false,
        elapsedMs: response.elapsedMs,
      },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  queueAiJobIfReady(job.reportId, job.id);
}

function createCompletedRemotePageJob(
  db: ReturnType<typeof getDatabase>,
  sourceJob: JobRow,
  pageId: string,
  pageNumber: number,
  response: MinerURecognitionResult,
  lines: Array<Record<string, unknown>>,
  inheritedDetail: ProcessingJobQueuedDetail,
) {
  const jobId = createId("job");
  db.prepare(
    `
    INSERT INTO processing_jobs (
      id, report_id, page_id, job_type, status, attempts, pipeline_version,
      deduplication_key, started_at, finished_at
    ) VALUES (?, ?, ?, 'ocr', 'completed', 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `,
  ).run(
    jobId,
    sourceJob.reportId,
    pageId,
    sourceJob.pipelineVersion,
    `${sourceJob.reportId}:${pageId}:ocr:remote-result:${sourceJob.id}`,
  );
  appendJobEvent({
    jobId,
    reportId: sourceJob.reportId,
    eventType: "queued",
    status: "queued",
    detail: {
      jobType: "ocr",
      pageId,
      pageNumber,
      source: "mineru_result_page",
      sourceJobId: sourceJob.id,
      batchId: inheritedDetail.batchId,
      previousReportStatus: inheritedDetail.previousReportStatus,
      ocrMode: inheritedDetail.ocrMode,
      remoteProcessingAccepted: inheritedDetail.remoteProcessingAccepted,
    },
  });
  persistOcrResult(db, jobId, pageId, response, lines);
  appendJobEvent({
    jobId,
    reportId: sourceJob.reportId,
    eventType: "completed",
    status: "completed",
    attempt: 1,
    message: "MinerU 精准解析页已落库",
    detail: {
      jobType: "ocr",
      pageId,
      pageNumber,
      source: "mineru_result_page",
      sourceJobId: sourceJob.id,
      requestedOcrMode: inheritedDetail.ocrMode,
      actualOcrEngine: response.engine,
      coordinateAvailable: false,
    },
  });
}

function completeRemotePrecisePdf(
  job: JobRow,
  response: MinerURecognitionResult,
) {
  if (!job.pageId || !job.storagePath) {
    throw Object.assign(new Error("MinerU 精准结果缺少源文件页面"), { code: "MINERU_INVALID_RESULT" });
  }
  const remotePages = Array.isArray(response.remotePages) ? response.remotePages : [];
  if (!remotePages.length || remotePages.some((page, index) => page.pageNumber !== index + 1)) {
    throw Object.assign(new Error("MinerU 精准结果页码不连续"), { code: "MINERU_INVALID_RESULT" });
  }
  if (remotePages.length > 200) {
    throw Object.assign(new Error("MinerU 精准结果超过 200 页"), { code: "MINERU_LIMIT_EXCEEDED" });
  }
  const db = getDatabase();
  const inheritedDetail = readQueuedJobDetail(job.id);
  const source = db.prepare(
    `
    SELECT original_name AS originalName, storage_path AS storagePath, mime_type AS mimeType,
      file_size AS fileSize, sha256, rotation, page_number AS pageNumber,
      source_page_count AS sourcePageCount
    FROM report_pages WHERE id = ?
  `,
  ).get(job.pageId) as {
    originalName: string;
    storagePath: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    rotation: number;
    pageNumber: number;
    sourcePageCount: number | null;
  } | undefined;
  if (!source) throw Object.assign(new Error("MinerU 源文件页面不存在"), { code: "MINERU_INVALID_RESULT" });
  db.exec("BEGIN IMMEDIATE");
  try {
    const pageCount = remotePages.length;
    if (source.sourcePageCount && source.sourcePageCount !== pageCount) {
      throw Object.assign(new Error("MinerU 返回页数与历史页数不一致"), { code: "MINERU_INVALID_RESULT" });
    }
    const existingPages = db.prepare(
      `
      SELECT id, page_number AS pageNumber, source_page_number AS sourcePageNumber
      FROM report_pages WHERE report_id = ? AND storage_path = ? ORDER BY source_page_number, page_number
    `,
    ).all(job.reportId, source.storagePath) as Array<{
      id: string; pageNumber: number; sourcePageNumber: number | null;
    }>;
    if (!source.sourcePageCount) {
      if (pageCount > 1) {
        db.prepare("UPDATE report_pages SET page_number = -page_number WHERE report_id = ? AND page_number > ?")
          .run(job.reportId, source.pageNumber);
        db.prepare("UPDATE report_pages SET page_number = -page_number + ? WHERE report_id = ? AND page_number < 0")
          .run(pageCount - 1, job.reportId);
      }
      db.prepare("UPDATE report_pages SET source_page_number = 1, source_page_count = ? WHERE id = ?")
        .run(pageCount, job.pageId);
      for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
        const pageId = createId("page");
        db.prepare(
          `
          INSERT INTO report_pages (
            id, report_id, page_number, original_name, storage_path, mime_type, file_size,
            sha256, rotation, source_page_number, source_page_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          pageId,
          job.reportId,
          source.pageNumber + pageNumber - 1,
          source.originalName,
          source.storagePath,
          source.mimeType,
          source.fileSize,
          source.sha256,
          source.rotation,
          pageNumber,
          pageCount,
        );
      }
    } else {
      /* A user may have removed one or more precise source pages after the
         previous run.  The source PDF is still submitted as a whole, so
         match returned pages by their validated source_page_number and keep
         the intentional deletions instead of recreating them. */
      const pageRows = existingPages.filter((page) => page.sourcePageNumber !== null);
      const sourceNumbers = pageRows.map((page) => page.sourcePageNumber as number);
      if (
        pageRows.some((page) =>
          !Number.isInteger(page.sourcePageNumber)
          || (page.sourcePageNumber as number) < 1
          || (page.sourcePageNumber as number) > pageCount,
        )
        || new Set(sourceNumbers).size !== sourceNumbers.length
      ) {
        throw Object.assign(new Error("MinerU 精准结果无法匹配现有页面"), { code: "MINERU_INVALID_RESULT" });
      }
    }
    const pageRows = db.prepare(
      `
      SELECT id, source_page_number AS sourcePageNumber
      FROM report_pages WHERE report_id = ? AND storage_path = ?
      ORDER BY source_page_number
    `,
    ).all(job.reportId, source.storagePath) as Array<{ id: string; sourcePageNumber: number | null }>;
    if (
      !pageRows.length
      || pageRows.some((page) =>
        !Number.isInteger(page.sourcePageNumber)
        || (page.sourcePageNumber as number) < 1
        || (page.sourcePageNumber as number) > pageCount,
      )
      || new Set(pageRows.map((page) => page.sourcePageNumber)).size !== pageRows.length
    ) {
      throw Object.assign(new Error("MinerU 精准结果页面记录不完整"), { code: "MINERU_INVALID_RESULT" });
    }
    const pageRowsBySourceNumber = new Map(
      pageRows.map((page) => [page.sourcePageNumber as number, page]),
    );
    /* The source task is normally attached to source page 1.  If a user
       deletes that page while the remote batch is running, the task is
       rebound to the first surviving page before the FK cascade.  Persist
       that page with the source task itself so a completed source task can
       never be left without an OCR result.  Every other retained page gets
       its own completed child task below. */
    const sourceResultPage = pageRows[0];
    if (!sourceResultPage) {
      throw Object.assign(new Error("MinerU 精准结果没有可保存的页面"), { code: "MINERU_INVALID_RESULT" });
    }
    if (job.pageId !== sourceResultPage.id) {
      db.prepare("UPDATE processing_jobs SET page_id = ? WHERE id = ?")
        .run(sourceResultPage.id, job.id);
    }
    for (const page of remotePages) {
      const pageRow = pageRowsBySourceNumber.get(page.pageNumber);
      /* Missing source pages are explicit user deletions; do not recreate
         them, but also do not treat the returned document as malformed. */
      if (!pageRow) continue;
      if (pageRow.id === sourceResultPage.id) {
        persistOcrResult(db, job.id, pageRow.id, response, page.lines);
      } else {
        createCompletedRemotePageJob(
          db,
          job,
          pageRow.id,
          page.pageNumber,
          response,
          page.lines,
          inheritedDetail,
        );
      }
    }
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'completed', locked_at = NULL, lease_expires_at = NULL,
        error_code = NULL, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ?
    `,
    ).run(job.id);
    appendJobEvent({
      jobId: job.id,
      reportId: job.reportId,
      eventType: "completed",
      status: "completed",
      attempt: job.attempts,
      message: "MinerU 精准解析已完成并恢复逐页结果",
      detail: {
        jobType: "ocr",
        source: "mineru_precise",
        pageCount,
        pageMappingAvailable: true,
        requestedOcrMode: inheritedDetail.ocrMode,
        actualOcrEngine: response.engine,
        coordinateAvailable: false,
        elapsedMs: response.elapsedMs,
      },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  queueAiJobIfReady(job.reportId, job.id);
}

function completeJob(job: JobRow, response: JobExecutionResponse) {
  const queuedDetail = job.jobType === "ocr" ? readQueuedJobDetail(job.id) : null;
  if (
    job.jobType === "ocr"
    && job.mimeType === "application/pdf"
    && response.engine === "mineru-agent"
    && queuedDetail?.remoteScope === "source"
  ) {
    completeRemoteAgentPdf(job, response);
    return;
  }
  /* Only the new source-file scoped precise task is allowed to expand a PDF.
   * Legacy MinerU jobs were submitted one page at a time; their content list
   * also contains page indexes, but those indexes describe the already
   * selected page rather than the whole source document.  Treating such a
   * result as a source expansion would reject a valid resumed task whenever
   * the old local split had more than one page. */
  if (
    job.jobType === "ocr"
    && job.mimeType === "application/pdf"
    && queuedDetail?.remoteScope === "source"
    && response.remotePages?.length
  ) {
    completeRemotePrecisePdf(job, response);
    return;
  }
  if (!job.pageId) throw new Error("页面任务缺少页面 ID");
  const db = getDatabase();
  const ocrMeta =
    typeof response.engineElapsed === "object" &&
    response.engineElapsed !== null
      ? (response.engineElapsed as Record<string, unknown>)
      : {};
  if (job.jobType === "pdf_extract") {
    expandPdf(job, response);
  } else if (job.jobType === "thumbnail") {
    const relativeThumbnail = `thumbnails/${job.reportId}/${job.pageId}.jpg`;
    db.prepare(
      `
      UPDATE report_pages SET thumbnail_path = ?, width = ?, height = ? WHERE id = ?
    `,
    ).run(
      relativeThumbnail,
      Number(response.width || 0) || null,
      Number(response.height || 0) || null,
      job.pageId,
    );
  } else if (job.jobType === "ocr") {
    db.exec("BEGIN IMMEDIATE");
    try {
      persistOcrResult(db, job.id, job.pageId, response, response.lines || []);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.prepare(
    `
    UPDATE processing_jobs SET status = 'completed', locked_at = NULL, lease_expires_at = NULL,
      error_code = NULL, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ?
  `,
  ).run(job.id);
  appendJobEvent({
    jobId: job.id,
    reportId: job.reportId,
    eventType: "completed",
    status: "completed",
    attempt: job.attempts,
    detail: {
      jobType: job.jobType,
      pageId: job.pageId,
      pageNumber: job.pageNumber,
      pageCount: response.pageCount,
      width: response.width,
      height: response.height,
      engine: response.engine,
      modelVersion: response.modelVersion,
      requestedOcrMode:
        typeof ocrMeta.requestedMode === "string"
          ? ocrMeta.requestedMode
          : undefined,
      actualOcrEngine: response.engine,
      limitFallbackReason:
        typeof ocrMeta.limitFallbackReason === "string"
          ? ocrMeta.limitFallbackReason
          : undefined,
      coordinateAvailable:
        typeof ocrMeta.coordinateAvailable === "boolean"
          ? ocrMeta.coordinateAvailable
          : undefined,
      pageMappingAvailable:
        typeof response.pageMappingAvailable === "boolean"
          ? response.pageMappingAvailable
          : undefined,
      ocrSource:
        typeof ocrMeta.source === "string" ? ocrMeta.source : undefined,
      renderScale:
        typeof ocrMeta.renderScale === "number"
          ? ocrMeta.renderScale
          : undefined,
      pdfTextLines:
        typeof ocrMeta.pdfTextLines === "number"
          ? ocrMeta.pdfTextLines
          : undefined,
      ocrLines:
        typeof ocrMeta.ocrLines === "number" ? ocrMeta.ocrLines : undefined,
      mergedLines:
        typeof ocrMeta.mergedLines === "number"
          ? ocrMeta.mergedLines
          : undefined,
      imageCoverage:
        typeof ocrMeta.imageCoverage === "number"
          ? ocrMeta.imageCoverage
          : undefined,
      elapsedMs: response.elapsedMs,
      workerRssBytes: response.workerRssBytes,
      workerPeakRssBytes: response.workerPeakRssBytes,
      workerRequestCount: response.workerRequestCount,
      workerOcrRequestCount: response.workerOcrRequestCount,
      workerRecycleRecommended: response.recycleRecommended,
      workerRecycleReason: response.recycleReason,
      workerHeartbeatCount: response.workerHeartbeatCount,
      workerLastHeartbeatElapsedMs: response.workerLastHeartbeatElapsedMs,
    },
  });
  if (job.jobType === "ocr") queueAiJobIfReady(job.reportId, job.id);
}

function reportHasUsableStructuredResult(reportId: string) {
  const row = getDatabase()
    .prepare(
      `
    SELECT
      EXISTS(SELECT 1 FROM observations WHERE report_id = ?) AS hasObservations,
      EXISTS(SELECT 1 FROM report_extractions WHERE report_id = ?) AS hasExtraction
  `,
    )
    .get(reportId, reportId) as {
    hasObservations: number;
    hasExtraction: number;
  };
  return Boolean(row.hasObservations || row.hasExtraction);
}

function preservedReportStatus(
  reportId: string,
  previousReportStatus: string | null,
) {
  if (
    previousReportStatus === "ready" ||
    previousReportStatus === "needs_review"
  )
    return previousReportStatus;
  return reportHasUsableStructuredResult(reportId) ? "needs_review" : "failed";
}

export function reconcileReportProcessingStatus(reportId: string) {
  const db = getDatabase();
  const previous = db
    .prepare(
      "SELECT status, member_id AS memberId, title FROM reports WHERE id = ?",
    )
    .get(reportId) as
    { status: string; memberId: string; title: string } | undefined;
  if (!previous || previous.status === "trashed")
    return previous?.status || null;

  const context = loadReportProcessingBatchContext(reportId);
  const currentJobs = context.currentBatch?.jobs || [];
  const hasActive = currentJobs.some((job) =>
    ["queued", "processing"].includes(job.status),
  );
  const hasFailure = currentJobs.some((job) => job.status === "failed");
  const hasCompleted = currentJobs.some((job) => job.status === "completed");
  const allCancelled =
    currentJobs.length > 0 &&
    currentJobs.every((job) => job.status === "cancelled");
  let status = previous.status;
  if (hasActive) {
    status = "processing";
  } else if (hasFailure) {
    status = preservedReportStatus(reportId, context.previousReportStatus);
  } else if (allCancelled) {
    status = preservedReportStatus(reportId, context.previousReportStatus);
  } else if (hasCompleted) {
    status = "needs_review";
  } else if (["queued", "processing", "uploading"].includes(previous.status)) {
    status = preservedReportStatus(reportId, context.previousReportStatus);
  }

  db.prepare(
    "UPDATE reports SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'trashed'",
  ).run(status, reportId);
  if (previous.status === status) return status;

  if (hasFailure && status !== "failed") {
    db.prepare(
      `
      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
      VALUES (?, ?, ?, 'report_failed', ?, ?, 'warning')
    `,
    ).run(
      createId("notice"),
      previous.memberId,
      reportId,
      "重新处理失败，已保留原结果",
      `「${previous.title}」本轮处理未完成，上一版可用内容和趋势数据未被覆盖。可查看任务日志后重试。`,
    );
    return status;
  }

  if (status === "needs_review" && !hasFailure) {
    const hasAiResult = currentJobs.some(
      (job) => job.jobType === "ai_extract" && job.status === "completed",
    );
    const ocrTextEmpty = !hasAiResult && reportOcrTextLength(reportId) < 1;
    const duplicateCandidates =
      !hasAiResult && !ocrTextEmpty
        ? findLocalDuplicateEvidence(reportId).filter(
            (candidate) => candidate.confidence === "high",
          )
        : [];
    const duplicateDetected = duplicateCandidates.length > 0;
    if (duplicateDetected)
      appendDuplicateDetectedEvent(reportId, duplicateCandidates);
    db.prepare(
      `
      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
      VALUES (?, ?, ?, 'report_processed', ?, ?, ?)
    `,
    ).run(
      createId("notice"),
      previous.memberId,
      reportId,
      ocrTextEmpty
        ? "报告未识别到文字"
        : duplicateDetected
          ? "发现可能重复报告"
          : "报告处理完成",
      ocrTextEmpty
        ? `「${previous.title}」OCR 未提取到任何文字，可能不是有效的体检报告。请确认原件清晰后重新上传，或手动录入报告内容。`
        : duplicateDetected
          ? `「${previous.title}」已完成 OCR，本地检测到 ${duplicateCandidates.length} 份高度重复候选${isAiExtractionConfigured() ? "，已暂缓自动 AI 整理" : ""}。请先核对已有报告，也可以在详情中手动继续 AI 整理。`
          : hasAiResult
            ? `「${previous.title}」已完成 OCR 和 AI 整理，等待确认归档。`
            : `「${previous.title}」已完成 OCR 识别，等待确认归档。`,
      ocrTextEmpty || duplicateDetected ? "warning" : "success",
    );
  } else if (status === "failed") {
    db.prepare(
      `
      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
      VALUES (?, ?, ?, 'report_failed', ?, ?, 'error')
    `,
    ).run(
      createId("notice"),
      previous.memberId,
      reportId,
      "报告处理失败",
      `「${previous.title}」处理失败，可在报告详情中查看日志并重试。`,
    );
  }
  return status;
}

function sourceFileError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function assertSourceFileAvailable(job: JobRow, imagePath: string) {
  let stats;
  try {
    stats = lstatSync(imagePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw sourceFileError(
        "SOURCE_FILE_MISSING",
        "报告原件文件不存在，请确认存储目录可用或重新上传原件",
      );
    }
    throw sourceFileError(
      "SOURCE_FILE_UNREADABLE",
      `报告原件无法读取：${error instanceof Error ? error.message : "文件系统访问失败"}`,
    );
  }
  if (!stats.isFile()) {
    throw sourceFileError("SOURCE_FILE_INVALID", "报告原件路径不是有效文件");
  }
  if (job.fileSize !== null && stats.size !== job.fileSize) {
    throw sourceFileError(
      "SOURCE_FILE_SIZE_MISMATCH",
      `报告原件大小不一致：预期 ${job.fileSize} 字节，实际 ${stats.size} 字节`,
    );
  }
}

function cancelQueuedJobsForPermanentSourceFailure(job: JobRow, code: string) {
  if (!job.storagePath) return 0;
  const db = getDatabase();
  const siblings = db
    .prepare(
      `
      SELECT j.id, j.page_id AS pageId, j.job_type AS jobType, j.attempts,
        p.page_number AS pageNumber
      FROM processing_jobs j
      JOIN report_pages p ON p.id = j.page_id
      WHERE j.report_id = ? AND p.storage_path = ? AND j.id <> ?
        AND j.status = 'queued' AND j.job_type IN ('pdf_extract', 'thumbnail', 'ocr')
    `,
    )
    .all(job.reportId, job.storagePath, job.id) as Array<{
    id: string;
    pageId: string;
    jobType: JobRow["jobType"];
    attempts: number;
    pageNumber: number;
  }>;
  for (const sibling of siblings) {
    db.prepare(
      `
      UPDATE processing_jobs SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
        next_retry_at = NULL, error_code = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `,
    ).run(code, "同一原件已确认无法解码，已停止重复处理", sibling.id);
    appendJobEvent({
      jobId: sibling.id,
      reportId: job.reportId,
      eventType: "cancelled",
      status: "cancelled",
      attempt: sibling.attempts,
      message: "同一原件已确认无法解码，已停止重复处理",
      detail: {
        code,
        source: "permanent_source_failure",
        failedJobId: job.id,
        jobType: sibling.jobType,
        pageId: sibling.pageId,
        pageNumber: sibling.pageNumber,
      },
    });
  }
  return siblings.length;
}

function failJob(job: JobRow, error: unknown) {
  const message =
    error instanceof Error ? error.message.slice(0, 500) : "任务执行失败";
  const code = String(
    (error as { code?: string })?.code || "WORKER_TASK_FAILED",
  ).slice(0, 80);
  const permanentFailure = permanentSourceErrorCodes.has(code);
  const finalFailure = permanentFailure || job.attempts >= maxAttempts;
  const delay = retryDelays[Math.min(job.attempts - 1, retryDelays.length - 1)];
  getDatabase()
    .prepare(
      `
    UPDATE processing_jobs SET status = ?, locked_at = NULL, lease_expires_at = NULL,
      next_retry_at = CASE WHEN ? THEN NULL ELSE datetime('now', ?) END,
      error_code = ?, error_message = ?, finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id = ?
  `,
    )
    .run(
      finalFailure ? "failed" : "queued",
      finalFailure ? 1 : 0,
      `+${delay} seconds`,
      code,
      message,
      finalFailure ? 1 : 0,
      job.id,
    );
  const cancelledSiblingJobs = permanentFailure
    ? cancelQueuedJobsForPermanentSourceFailure(job, code)
    : 0;
  appendJobEvent({
    jobId: job.id,
    reportId: job.reportId,
    eventType: finalFailure ? "failed" : "retry_scheduled",
    status: finalFailure ? "failed" : "queued",
    attempt: job.attempts,
    message,
    detail: {
      code,
      jobType: job.jobType,
      pageId: job.pageId,
      pageNumber: job.pageNumber,
      finalFailure,
      permanentFailure,
      cancelledSiblingJobs,
      retryDelaySeconds: finalFailure ? null : delay,
    },
  });
}

function mineruTemporaryDirectory() {
  return safeStoragePath(join("tmp", "mineru"));
}

export function cleanupStaleMineruTemporaryFiles(maxAgeMs = 24 * 60 * 60_000) {
  const directory = mineruTemporaryDirectory();
  if (!existsSync(directory)) return 0;
  const cutoff = Date.now() - Math.max(0, maxAgeMs);
  let removed = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.jpg$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      if (statSync(path).mtimeMs > cutoff) continue;
      rmSync(path, { force: true });
      removed += 1;
    } catch {
      // A concurrent job or temporary storage outage can leave cleanup for the next startup.
    }
  }
  return removed;
}

function readMineruResumeReference(jobId: string, mode: OcrRecognitionMode) {
  const expectedKind = mode === "mineru_agent" ? "task" : "batch";
  const rows = getDatabase()
    .prepare(
      `
    SELECT event_type AS eventType, detail_json AS detailJson, created_at AS createdAt
    FROM processing_job_events
    WHERE job_id = ?
    ORDER BY created_at, rowid
  `,
    )
    .all(jobId) as Array<{ eventType: string; detailJson: string; createdAt: string }>;
  let reference: MinerURemoteReference | null = null;
  let remoteStartedAtMs: number | null = null;
  for (const row of rows) {
    if (row.eventType === "manual_retry") {
      // A user retry starts a fresh wait window but still reuses an uploaded task when possible.
      remoteStartedAtMs = null;
      continue;
    }
    try {
      const detail = JSON.parse(row.detailJson) as {
        stage?: unknown;
        remoteKind?: unknown;
        remoteTaskId?: unknown;
        remoteState?: unknown;
        remoteStartedAtMs?: unknown;
      };
      if (
        detail.stage === "mineru_submitted"
        && detail.remoteKind === expectedKind
        && typeof detail.remoteTaskId === "string"
        && detail.remoteTaskId.length <= 200
        && /^[A-Za-z0-9_-]+$/.test(detail.remoteTaskId)
      ) {
        reference = { kind: expectedKind, id: detail.remoteTaskId };
        const explicitStartedAt = Number(detail.remoteStartedAtMs);
        const historicalStartedAt = Date.parse(`${row.createdAt.replace(" ", "T")}Z`);
        remoteStartedAtMs = Number.isFinite(explicitStartedAt) && explicitStartedAt > 0
          ? explicitStartedAt
          : Number.isFinite(historicalStartedAt)
            ? historicalStartedAt
            : null;
      }
      if (
        reference
        && detail.stage === "mineru_status"
        && detail.remoteTaskId === reference.id
        && detail.remoteState === "failed"
      ) {
        reference = null;
        remoteStartedAtMs = null;
      }
    } catch {
      // Ignore malformed historical events; they must never trigger external processing.
    }
  }
  return { reference, remoteStartedAtMs };
}

function appendMineruSubmittedEvent(
  job: JobRow,
  mode: Exclude<OcrRecognitionMode, "local">,
  reference: MinerURemoteReference,
) {
  appendJobEvent({
    jobId: job.id,
    reportId: job.reportId,
    eventType: "started",
    status: "processing",
    attempt: job.attempts,
    message: "MinerU 源文件已上传，等待远程解析",
    detail: {
      jobType: "ocr",
      stage: "mineru_submitted",
      ocrMode: mode,
      remoteKind: reference.kind,
      remoteTaskId: reference.id,
      remoteStartedAtMs: Date.now(),
    },
  });
}

function appendMineruStateEvent(
  job: JobRow,
  mode: Exclude<OcrRecognitionMode, "local">,
  reference: MinerURemoteReference,
  state: string,
) {
  appendJobEvent({
    jobId: job.id,
    reportId: job.reportId,
    eventType: "started",
    status: "processing",
    attempt: job.attempts,
    message: `MinerU 状态：${state}`,
    detail: {
      jobType: "ocr",
      stage: "mineru_status",
      ocrMode: mode,
      remoteKind: reference.kind,
      remoteTaskId: reference.id,
      remoteState: state,
    },
  });
}

function sourceLimitFallback(job: JobRow, mode: Exclude<OcrRecognitionMode, "local">) {
  const limits = ocrRecognitionModeCatalog[mode].limits;
  const sourcePages = Math.max(1, Number(job.sourcePageCount || 1));
  if (limits.maxFileBytes !== null && Number(job.fileSize || 0) > limits.maxFileBytes) {
    return {
      reason: "source_file_size",
      sourceBytes: Number(job.fileSize || 0),
      sourcePages,
      officialMaxBytes: limits.maxFileBytes,
      officialMaxPages: limits.maxPages,
    };
  }
  if (limits.maxPages !== null && sourcePages > limits.maxPages) {
    return {
      reason: "source_page_count",
      sourceBytes: Number(job.fileSize || 0),
      sourcePages,
      officialMaxBytes: limits.maxFileBytes,
      officialMaxPages: limits.maxPages,
    };
  }
  return null;
}

function appendMineruLimitFallbackEvent(
  job: JobRow,
  mode: Exclude<OcrRecognitionMode, "local">,
  detail: Record<string, unknown>,
) {
  appendJobEvent({
    jobId: job.id,
    reportId: job.reportId,
    eventType: "started",
    status: "processing",
    attempt: job.attempts,
    message: "源文件超过 MinerU 官方限额，准备改用本地 OCR",
    detail: {
      jobType: "ocr",
      stage: "mineru_limit_fallback",
      requestedOcrMode: mode,
      actualOcrMode: "local",
      ...detail,
    },
  });
}

function annotateOcrResponse<T extends WorkerResponse>(
  response: T,
  requestedMode: OcrRecognitionMode,
  limitFallbackReason?: string,
): T {
  const current = typeof response.engineElapsed === "object" && response.engineElapsed !== null
    ? response.engineElapsed as Record<string, unknown>
    : {};
  response.engineElapsed = {
    ...current,
    requestedMode,
    actualMode: response.engine?.startsWith("mineru-") ? requestedMode : "local",
    ...(limitFallbackReason ? { limitFallbackReason } : {}),
    coordinateAvailable: response.engine?.startsWith("mineru-") ? false : true,
  };
  return response;
}

async function executeMineruOcr(
  job: JobRow,
  request: WorkerRequest,
  mode: Exclude<OcrRecognitionMode, "local">,
  executor: WorkerExecutor,
  mineruExecutor: MinerURecognitionExecutor,
) {
  if (!job.storagePath || !job.mimeType) {
    throw Object.assign(new Error("MinerU 源文件信息缺失"), { code: "MINERU_PAGE_PREPARATION_FAILED" });
  }
  const sourcePath = safeStoragePath(job.storagePath);
  assertSourceFileAvailable(job, sourcePath);
  if (!isJobStillProcessable(job)) {
    throw Object.assign(new Error("MinerU 任务已取消"), { code: "MINERU_CANCELLED" });
  }
  const safeJobName = job.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
  const extensionByMime: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  };
  const extension = extensionByMime[job.mimeType] || extname(sourcePath).toLowerCase();
  if (!/^\.(?:pdf|jpe?g|png|webp|heic|heif)$/.test(extension)) {
    throw Object.assign(new Error("MinerU 源文件格式无效"), { code: "MINERU_INVALID_RESULT" });
  }
  const queuedDetail = readQueuedJobDetail(job.id);
  const pageRanges = mode === "mineru_precise"
    && queuedDetail.remoteScope !== "source"
    && job.sourcePageNumber
    ? `${job.sourcePageNumber}--${job.sourcePageNumber}`
    : null;
  const resume = readMineruResumeReference(job.id, mode);
  const settings = getOcrRecognitionSettings(true);
  return await mineruExecutor({
    mode,
    filePath: sourcePath,
    mimeType: job.mimeType,
    remoteFileName: `source-${safeJobName}${extension}`,
    pageRanges,
    apiToken: mode === "mineru_precise" ? settings.apiToken : undefined,
    resume: resume.reference,
    remoteStartedAtMs: resume.remoteStartedAtMs,
    shouldContinue: () => isJobStillProcessable(job),
    onSubmitted: (reference) => appendMineruSubmittedEvent(job, mode, reference),
    onState: (reference, state) => appendMineruStateEvent(job, mode, reference, state),
  });
}

async function executeOcrJob(
  job: JobRow,
  request: WorkerRequest,
  executor: WorkerExecutor,
  mineruExecutor: MinerURecognitionExecutor,
) {
  const queuedDetail = readQueuedJobDetail(job.id);
  const mode = queuedDetail.ocrMode;
  if (mode === "local") return annotateOcrResponse(await executor(request), mode);
  if (!queuedDetail.remoteProcessingAccepted) {
    throw Object.assign(new Error("远程 OCR 任务缺少用户外发确认"), {
      code: "MINERU_CONSENT_MISSING",
    });
  }
  try {
    const preflightFallback = sourceLimitFallback(job, mode);
    if (preflightFallback) {
      throw Object.assign(new Error("源文件超过 MinerU 官方限额"), {
        code: "MINERU_LIMIT_EXCEEDED",
        fallbackDetail: preflightFallback,
      });
    }
    return annotateOcrResponse(
      await executeMineruOcr(job, request, mode, executor, mineruExecutor),
      mode,
    );
  } catch (error) {
    if ((error as { code?: string })?.code !== "MINERU_LIMIT_EXCEEDED") throw error;
    const fallbackDetail = (error as { fallbackDetail?: Record<string, unknown> }).fallbackDetail || {};
    appendMineruLimitFallbackEvent(job, mode, {
      reason: typeof fallbackDetail.reason === "string" ? fallbackDetail.reason : "upstream_document_limit",
      ...fallbackDetail,
    });
    throw error;
  }
}

function localFallbackDetail(job: JobRow) {
  const current = readQueuedJobDetail(job.id);
  return {
    ...current,
    source: "mineru_limit_fallback",
    remoteScope: null,
    ocrMode: "local" as const,
    remoteProcessingAccepted: false,
  } satisfies ProcessingJobQueuedDetail;
}

function completeMineruLimitFallbackJob(
  job: JobRow,
  mode: Exclude<OcrRecognitionMode, "local">,
  detail: Record<string, unknown>,
) {
  const db = getDatabase();
  db.prepare(
    `
    UPDATE processing_jobs SET status = 'completed', locked_at = NULL, lease_expires_at = NULL,
      error_code = NULL, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ?
  `,
  ).run(job.id);
  appendJobEvent({
    jobId: job.id,
    reportId: job.reportId,
    eventType: "completed",
    status: "completed",
    attempt: job.attempts,
    message: "MinerU 超限，已转入本地识别任务",
    detail: {
      jobType: "ocr",
      stage: "mineru_limit_fallback_queued",
      requestedOcrMode: mode,
      actualOcrMode: "local",
      ...detail,
    },
  });
}

function queueLocalJobsForSource(
  reportId: string,
  storagePath: string,
  inheritedDetail: ProcessingJobQueuedDetail,
  deduplicationSuffix = "",
) {
  const pages = getDatabase().prepare(
    "SELECT id FROM report_pages WHERE report_id = ? AND storage_path = ? ORDER BY page_number",
  ).all(reportId, storagePath) as Array<{ id: string }>;
  for (const page of pages) {
    queueJob(reportId, page.id, "thumbnail", inheritedDetail, deduplicationSuffix);
    queueJob(reportId, page.id, "ocr", inheritedDetail, deduplicationSuffix);
  }
}

async function fallbackMineruLimitToLocal(
  job: JobRow,
  request: WorkerRequest,
  executor: WorkerExecutor,
  error: unknown,
) {
  /* Test/in-process callers provide an explicit WorkerExecutor, which is the
     worker capability itself.  The production runner uses requestWorker and
     must still verify the installed runtime before a MinerU-limit fallback. */
  if (executor === requestWorker && !hasOcrRuntime()) {
    const failure = Object.assign(
      new Error("源文件超过 MinerU 官方限额，当前未安装本地 OCR 环境，请安装后重试"),
      { code: "MINERU_LIMIT_EXCEEDED_LOCAL_RUNTIME_UNAVAILABLE" },
    );
    throw failure;
  }
  const queued = readQueuedJobDetail(job.id);
  const mode = queued.ocrMode;
  if (mode === "local") return false;
  const localDetail = localFallbackDetail(job);
  const deduplicationSuffix = `mineru-fallback-${job.id}`;
  const fallbackDetail = (error as { fallbackDetail?: Record<string, unknown> }).fallbackDetail || {
    reason: "upstream_document_limit",
  };
  if (job.mimeType === "application/pdf") {
    const inspection = await executor({
      ...request,
      action: "inspect_pdf",
      recycleAfterResponse: isLastActiveOcrJobForReport(job),
    });
    if (!inspection.ok) {
      throw Object.assign(
        new Error(inspection.errorMessage || "本地 PDF 拆页失败"),
        { code: inspection.errorCode || "PDF_DECODE_FAILED" },
      );
    }
    expandPdf(job, inspection, localDetail, deduplicationSuffix);
    queueLocalJobsForSource(job.reportId, job.storagePath!, localDetail, deduplicationSuffix);
  } else if (job.pageId) {
    queueJob(job.reportId, job.pageId, "thumbnail", localDetail, deduplicationSuffix);
    queueJob(job.reportId, job.pageId, "ocr", localDetail, deduplicationSuffix);
  } else {
    throw Object.assign(new Error("MinerU 超限任务缺少页面信息"), { code: "MINERU_INVALID_RESULT" });
  }
  completeMineruLimitFallbackJob(job, mode, fallbackDetail);
  return true;
}

export async function processNextJob(
  executor: WorkerExecutor = requestWorker,
  aiExecutor: AiExecutor = requestAiExtraction,
  mineruExecutor: MinerURecognitionExecutor = recognizePageWithMinerU,
  options: { enforceLocalRuntime?: boolean } = {},
) {
  /* The timer-driven runner is the scheduler boundary and enforces the local
   * runtime capability there. Direct in-process callers (including recovery
   * tools and tests) may deliberately provide an executor and run a local job
   * without installing the optional OCR runtime. */
  const job = claimNextJob({
    ignoreLocalRuntime: options.enforceLocalRuntime !== true,
  });
  if (!job) return false;
  activeJob = { id: job.id, reportId: job.reportId };
  let rebuildMorphology = false;
  let thumbnailOutputPath: string | null = null;
  let workerRequest: WorkerRequest | null = null;
  const cleanupPendingThumbnail = () => {
    if (!thumbnailOutputPath || job.thumbnailPath) return;
    try {
      rmSync(thumbnailOutputPath, { force: true });
    } catch {
      // Orphan scanning remains the fallback when the storage is temporarily unavailable.
    }
  };
  const renewLease = () => {
    getDatabase()
      .prepare(
        `
      UPDATE processing_jobs SET lease_expires_at = datetime('now', '+5 minutes')
      WHERE id = ? AND status = 'processing'
    `,
      )
      .run(job.id);
  };
  // Every processing job can outlive the five-minute lease on slower household
  // NAS devices. Renew local OCR/PDF jobs as well as AI jobs so another runner
  // cannot recover and duplicate work that is still actively executing.
  const leaseHeartbeat = setInterval(renewLease, leaseHeartbeatIntervalMs());
  leaseHeartbeat.unref();
  try {
    if (job.jobType === "ai_extract") {
      const persisted = getDatabase()
        .prepare("SELECT 1 AS found FROM report_extractions WHERE job_id = ?")
        .get(job.id) as { found: number } | undefined;
      if (!persisted) {
        const execution = await executeAiExtractionPlan(
          job.id,
          job.reportId,
          aiExecutor,
          {
            shouldContinue: () => isJobStillProcessable(job),
            onEvent: (unitEvent) => {
              renewLease();
              const eventType =
                unitEvent.type === "unit_completed"
                  ? "completed"
                  : ["unit_failed", "format_retry"].includes(unitEvent.type)
                    ? "retry_scheduled"
                    : "started";
              appendJobEvent({
                jobId: job.id,
                reportId: job.reportId,
                eventType,
                status: "processing",
                attempt: job.attempts,
                message: unitEvent.message,
                detail: {
                  jobType: "ai_extract",
                  stage: unitEvent.type,
                  ...unitEvent.detail,
                },
              });
            },
          },
        );
        const extraction = execution.result;
        if (!isJobStillProcessable(job)) return true;
        const indicatorNormalization = persistAiExtraction(
          job.reportId,
          job.id,
          extraction,
          execution.inputCharacters,
        );
        if (!isJobStillProcessable(job)) return true;
        appendJobEvent({
          jobId: job.id,
          reportId: job.reportId,
          eventType: "completed",
          status: "completed",
          attempt: job.attempts,
          detail: {
            jobType: "ai_extract",
            provider: extraction.provider,
            model: extraction.model,
            promptVersion: extraction.promptVersion,
            inputCharacters: execution.inputCharacters,
            planHash: execution.plan.planHash,
            plannedUnits: execution.plan.unitCount,
            processedPages: execution.plan.pageCount,
            warningUnits: execution.warningUnits,
            unmatchedCandidates: execution.unmatchedCandidates,
            promptTokens: extraction.promptTokens,
            completionTokens: extraction.completionTokens,
            elapsedMs: extraction.elapsedMs,
            indicatorNormalization,
          },
        });
      } else {
        const indicatorNormalization = normalizeReportObservations(
          job.reportId,
        );
        appendJobEvent({
          jobId: job.id,
          reportId: job.reportId,
          eventType: "completed",
          status: "completed",
          attempt: job.attempts,
          message: "已恢复指标归一化并完成任务",
          detail: {
            jobType: "ai_extract",
            resumedFromPersistedExtraction: true,
            indicatorNormalization,
          },
        });
      }
      getDatabase()
        .prepare(
          `
        UPDATE processing_jobs SET status = 'completed', locked_at = NULL, lease_expires_at = NULL,
          error_code = NULL, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ?
      `,
        )
        .run(job.id);
      rebuildMorphology = true;
    } else {
      if (!job.storagePath || !job.pageId)
        throw new Error("页面任务缺少原件信息");
      const imagePath = safeStoragePath(job.storagePath);
      assertSourceFileAvailable(job, imagePath);
      const request: WorkerRequest = {
        action: job.jobType === "pdf_extract" ? "inspect_pdf" : job.jobType,
        imagePath,
        mimeType: job.mimeType,
        pageNumber: job.sourcePageNumber,
        rotation: job.rotation || 0,
        recycleAfterResponse: isLastActiveOcrJobForReport(job),
      };
      workerRequest = request;
      if (job.jobType === "thumbnail") {
        const relativeThumbnail = `thumbnails/${job.reportId}/${job.pageId}.jpg`;
        const outputPath = safeStoragePath(relativeThumbnail);
        mkdirSync(dirname(outputPath), { recursive: true });
        thumbnailOutputPath = outputPath;
        request.outputPath = outputPath;
      }
      const response = job.jobType === "ocr"
        ? await executeOcrJob(job, request, executor, mineruExecutor)
        : await executor(request);
      if (!isJobStillProcessable(job)) {
        cleanupPendingThumbnail();
        return true;
      }
      if (!response.ok)
        throw Object.assign(
          new Error(response.errorMessage || "Worker 任务失败"),
          { code: response.errorCode },
        );
      completeJob(job, response);
    }
  } catch (error) {
    cleanupPendingThumbnail();
    if (!isJobStillProcessable(job)) return true;
    if (
      job.jobType === "ocr"
      && readQueuedJobDetail(job.id).ocrMode !== "local"
      && (error as { code?: string })?.code === "MINERU_LIMIT_EXCEEDED"
    ) {
      try {
        if (!workerRequest) throw error;
        const switched = await fallbackMineruLimitToLocal(job, workerRequest, executor, error);
        if (switched) return true;
      } catch (fallbackError) {
        error = fallbackError;
      }
    }
    failJob(job, error);
    throw error;
  } finally {
    clearInterval(leaseHeartbeat);
    if (activeJob?.id === job.id) activeJob = null;
    reconcileReportProcessingStatus(job.reportId);
    if (rebuildMorphology) {
      try {
        rebuildMorphologyTrackingForReport(job.reportId);
      } catch (error) {
        await writeLog("warn", "morphology-tracking-rebuild-failed", {
          reportId: job.reportId,
          error: error instanceof Error ? error.message : "形态变化关联失败",
        });
      }
    }
  }
  return true;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    lastRunAt = new Date().toISOString();
    lastError = null;
    await processNextJob(undefined, undefined, undefined, { enforceLocalRuntime: true });
  } catch (error) {
    lastError = error instanceof Error ? error.message : "任务执行失败";
    await writeLog("warn", "processing-job-failed", { error: lastError });
  } finally {
    busy = false;
  }
}

export function startJobRunner() {
  if (started || process.env.DISABLE_JOB_RUNNER === "true") return;
  cleanupStaleMineruTemporaryFiles();
  started = true;
  timer = setInterval(() => {
    void tick();
  }, 1500);
  timer.unref();
  void tick();
}

export function stopJobRunner() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  return { busy };
}

export function getJobRunnerStatus() {
  const config = getAppConfig();
  const counts = getDatabase()
    .prepare(
      `
    SELECT
      SUM(status = 'queued') AS queued,
      SUM(status = 'processing') AS processing,
      SUM(status = 'failed') AS failed
    FROM processing_jobs
  `,
    )
    .get() as { queued: number; processing: number; failed: number };
  return {
    started,
    busy,
    runtimeAvailable: hasOcrRuntime(config),
    lastRunAt,
    lastError,
    queued: Number(counts.queued || 0),
    processing: Number(counts.processing || 0),
    failed: Number(counts.failed || 0),
  };
}

export function retryProcessingJob(user: RequestUser, jobId: string) {
  const job = getDatabase()
    .prepare(
      `
    SELECT j.id, j.report_id AS reportId, r.member_id AS memberId, j.status
    FROM processing_jobs j JOIN reports r ON r.id = j.report_id WHERE j.id = ? AND r.status <> 'trashed'
  `,
    )
    .get(jobId) as
    | { id: string; reportId: string; memberId: string; status: string }
    | undefined;
  if (!job)
    throw createError({ statusCode: 404, statusMessage: "处理任务不存在" });
  assertMemberManage(user, job.memberId);
  if (job.status !== "failed")
    throw createError({
      statusCode: 409,
      statusMessage: "只有失败任务可以重试",
    });
  getDatabase()
    .prepare(
      `
    UPDATE processing_jobs SET status = 'queued', attempts = 0, next_retry_at = CURRENT_TIMESTAMP,
      error_code = NULL, error_message = NULL, finished_at = NULL WHERE id = ?
  `,
    )
    .run(jobId);
  getDatabase()
    .prepare(
      "UPDATE reports SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run(job.reportId);
  appendJobEvent({
    jobId,
    reportId: job.reportId,
    eventType: "manual_retry",
    status: "queued",
    attempt: 0,
    message: "用户手动重试任务",
  });
  return { id: jobId, status: "queued" };
}

export function queueManualAiExtraction(user: RequestUser, reportId: string) {
  const db = getDatabase();
  const report = db
    .prepare(
      "SELECT member_id AS memberId, status FROM reports WHERE id = ? AND status <> 'trashed'",
    )
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  if (!isAiExtractionConfigured()) {
    throw createError({
      statusCode: 409,
      statusMessage: "AI 解析尚未启用或配置不完整",
    });
  }
  const active = db
    .prepare(
      `
    SELECT
      SUM(job_type <> 'ai_extract' AND status IN ('queued', 'processing')) AS activeLocal,
      SUM(job_type = 'ai_extract' AND status IN ('queued', 'processing')) AS activeAi
    FROM processing_jobs WHERE report_id = ?
  `,
    )
    .get(reportId) as { activeLocal: number; activeAi: number };
  if (Number(active.activeLocal) > 0)
    throw createError({
      statusCode: 409,
      statusMessage: "本地识别仍在处理中，完成后再整理",
    });
  if (Number(active.activeAi) > 0)
    throw createError({
      statusCode: 409,
      statusMessage: "AI 整理任务已在队列中",
    });

  const context = loadReportProcessingBatchContext(reportId);
  const currentFailedLocal = context.currentBatch?.jobs.some(
    (job) => job.jobType !== "ai_extract" && job.status === "failed",
  );
  if (currentFailedLocal)
    throw createError({
      statusCode: 409,
      statusMessage: "本轮存在失败的 OCR/PDF 任务，请先重试本地识别",
    });
  const completedOcr = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
    WHERE p.report_id = ?
  `,
    )
    .get(reportId) as { count: number };
  if (Number(completedOcr.count) < 1 || reportOcrTextLength(reportId) < 1) {
    throw createError({
      statusCode: 409,
      statusMessage: "暂无可用于 AI 整理的 OCR 文本",
    });
  }

  const failedAi = context.currentBatch?.jobs.find(
    (job) => job.jobType === "ai_extract" && job.status === "failed",
  );
  if (failedAi) return retryProcessingJob(user, failedAi.id);

  const jobId = createId("job");
  const batchId = `manual-ai:${jobId}`;
  db.prepare(
    `
    INSERT INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, NULL, 'ai_extract', 'manual-ai-v1', ?)
  `,
  ).run(jobId, reportId, `${reportId}:ai_extract:manual:${jobId}`);
  appendJobEvent({
    jobId,
    reportId,
    eventType: "queued",
    status: "queued",
    message: "用户手动触发 AI 整理",
    detail: {
      jobType: "ai_extract",
      source: "manual",
      batchId,
      previousReportStatus: report.status,
    },
  });
  db.prepare(
    "UPDATE reports SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'trashed'",
  ).run(reportId);
  return { id: jobId, status: "queued" };
}

export function reprocessReportOcrAndAi(
  user: RequestUser,
  reportId: string,
  selectionInput: OcrBatchSelectionInput = {},
) {
  const db = getDatabase();
  const report = db
    .prepare(
      `
    SELECT id, member_id AS memberId, title, status
    FROM reports WHERE id = ? AND status <> 'trashed'
  `,
    )
    .get(reportId) as
    { id: string; memberId: string; title: string; status: string } | undefined;
  if (!report)
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const ocrSelection = validateOcrBatchSelection(selectionInput);
  const pages = db
    .prepare(
      `
    SELECT id, page_number AS pageNumber, storage_path AS storagePath,
      mime_type AS mimeType, source_page_number AS sourcePageNumber,
      source_page_count AS sourcePageCount
    FROM report_pages
    WHERE report_id = ? ORDER BY page_number
  `,
    )
    .all(reportId) as Array<{
      id: string;
      pageNumber: number;
      storagePath: string;
      mimeType: string;
      sourcePageNumber: number | null;
      sourcePageCount: number | null;
    }>;
  if (!pages.length)
    throw createError({
      statusCode: 409,
      statusMessage: "这份报告没有可重新识别的原件页",
    });
  const running = db
    .prepare(
      `
    SELECT job_type AS jobType FROM processing_jobs
    WHERE report_id = ? AND status IN ('queued', 'processing')
    LIMIT 1
  `,
    )
    .get(reportId) as { jobType: string } | undefined;
  if (running) {
    throw createError({
      statusCode: 409,
      statusMessage: "这份报告已有任务在排队或处理中，请稍后再重新识别",
    });
  }

  const batchId = createId("batch");
  const cancellable = db
    .prepare(
      `
    SELECT id, job_type AS jobType, attempts FROM processing_jobs
    WHERE report_id = ? AND status = 'failed'
  `,
    )
    .all(reportId) as Array<{
    id: string;
    jobType: JobRow["jobType"];
    attempts: number;
  }>;
  const queuedOcrJobs: string[] = [];
  const manualFieldKeys = listManualReportFieldKeys(reportId);
  const sourcePages = ocrSelection.ocrMode === "local"
    ? pages
    : [...new Map(
      pages
        .slice()
        .sort((left, right) => (left.sourcePageNumber || 1) - (right.sourcePageNumber || 1))
        .map((page) => [page.storagePath, page]),
    ).values()];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const job of cancellable) {
      db.prepare(
        `
        UPDATE processing_jobs
        SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
          next_retry_at = NULL, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
        WHERE id = ?
      `,
      ).run(job.id);
      appendJobEvent({
        jobId: job.id,
        reportId,
        eventType: "cancelled",
        status: "cancelled",
        attempt: job.attempts,
        message: "重新识别报告时取消旧任务",
        detail: {
          jobType: job.jobType,
          source: "manual_reprocess",
          batchId,
          previousReportStatus: report.status,
        },
      });
    }
    /* 保留上一版可用 OCR、指标和报告字段，直到新一轮 AI 成功后原子替换。 */
    db.prepare(
      `
      UPDATE reports SET
        status = 'processing',
        source_version = source_version + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(reportId);
    for (const page of sourcePages) {
      const jobId = createId("job");
      db.prepare(
        `
        INSERT INTO processing_jobs (
          id, report_id, page_id, job_type, pipeline_version, deduplication_key
        ) VALUES (?, ?, ?, 'ocr', 'manual-reprocess-v1', ?)
      `,
      ).run(
        jobId,
        reportId,
        page.id,
        `${reportId}:${page.id}:ocr:manual-reprocess:${batchId}:${jobId}`,
      );
      appendJobEvent({
        jobId,
        reportId,
        eventType: "queued",
        status: "queued",
        message: "用户重新识别报告",
        detail: {
          jobType: "ocr",
        pageId: page.id,
        pageNumber: page.pageNumber,
        source: "manual_reprocess",
        batchId,
        previousReportStatus: report.status,
        ...(ocrSelection.ocrMode !== "local" ? { remoteScope: "source" } : {}),
        ...ocrSelection,
        },
      });
      queuedOcrJobs.push(jobId);
    }
    db.prepare(
      `
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.reprocess_ocr_ai', 'report', ?, ?)
    `,
    ).run(
      createId("audit"),
      user.id,
      reportId,
      JSON.stringify({
        memberId: report.memberId,
        previousStatus: report.status,
        previousTitle: report.title,
        pageCount: pages.length,
        queuedOcr: queuedOcrJobs.length,
        aiConfigured: isAiExtractionConfigured(),
        manualFieldKeys: [...manualFieldKeys],
        batchId,
      }),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    id: reportId,
    status: "processing" as const,
    batchId,
    queuedOcr: queuedOcrJobs.length,
    aiWillRun: isAiExtractionConfigured(),
    ocrMode: ocrSelection.ocrMode,
  };
}

export function listProcessingJobEvents(user: RequestUser, jobId: string) {
  const job = getDatabase()
    .prepare(
      `
    SELECT j.id, j.report_id AS reportId, r.member_id AS memberId,
      j.job_type AS jobType, j.status, j.attempts, j.error_code AS errorCode,
      j.error_message AS errorMessage, j.created_at AS createdAt,
      j.started_at AS startedAt, j.finished_at AS finishedAt
    FROM processing_jobs j JOIN reports r ON r.id = j.report_id WHERE j.id = ?
  `,
    )
    .get(jobId) as
    | {
        id: string;
        reportId: string;
        memberId: string;
        jobType: JobRow["jobType"];
        status: string;
        attempts: number;
        errorCode: string | null;
        errorMessage: string | null;
        createdAt: string;
        startedAt: string | null;
        finishedAt: string | null;
      }
    | undefined;
  if (!job)
    throw createError({ statusCode: 404, statusMessage: "处理任务不存在" });
  assertMemberAccess(user, job.memberId);
  const rows = getDatabase()
    .prepare(
      `
    SELECT id, job_id AS jobId, report_id AS reportId, event_type AS eventType,
      status, attempt, message, detail_json AS detailJson, created_at AS createdAt
    FROM processing_job_events
    WHERE job_id = ?
    ORDER BY created_at, rowid
  `,
    )
    .all(jobId);
  if (!rows.length) {
    const eventType: JobEventType =
      job.status === "completed"
        ? "completed"
        : job.status === "failed"
          ? "failed"
          : job.status === "processing"
            ? "started"
            : "queued";
    return [
      {
        id: `${job.id}:snapshot`,
        jobId: job.id,
        reportId: job.reportId,
        eventType,
        status: job.status,
        attempt: job.attempts,
        message:
          job.errorMessage || "历史任务暂无详细事件日志，已显示当前状态快照",
        detail: {
          jobType: job.jobType,
          code: job.errorCode,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
        },
        createdAt: job.finishedAt || job.startedAt || job.createdAt,
      },
    ];
  }
  return rows.map((row) => {
    const event = row as {
      id: string;
      jobId: string;
      reportId: string;
      eventType: JobEventType;
      status: string;
      attempt: number;
      message: string | null;
      detailJson: string;
      createdAt: string;
    };
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(event.detailJson) as Record<string, unknown>;
    } catch {
      /* ignore malformed legacy detail */
    }
    return { ...event, detail, detailJson: undefined };
  });
}

type ProcessingJobEventItem = ReturnType<
  typeof listProcessingJobEvents
>[number];

function parseNumberArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is number =>
            typeof item === "number" && Number.isFinite(item),
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * AI jobs execute units concurrently, so raw event timestamps do not represent
 * the planned reading order. This projection keeps the raw history intact but
 * makes the extraction plan the primary progress model for clients.
 */
export function getProcessingJobEventDetail(user: RequestUser, jobId: string) {
  const db = getDatabase();
  const job = db
    .prepare(
      `
    SELECT j.id, j.report_id AS reportId, r.member_id AS memberId,
      j.job_type AS jobType, j.status, j.attempts, j.error_code AS errorCode,
      j.error_message AS errorMessage, j.created_at AS createdAt,
      j.started_at AS startedAt, j.finished_at AS finishedAt
    FROM processing_jobs j JOIN reports r ON r.id = j.report_id WHERE j.id = ?
  `,
    )
    .get(jobId) as
    | {
        id: string;
        reportId: string;
        memberId: string;
        jobType: JobRow["jobType"];
        status: string;
        attempts: number;
        errorCode: string | null;
        errorMessage: string | null;
        createdAt: string;
        startedAt: string | null;
        finishedAt: string | null;
      }
    | undefined;
  if (!job)
    throw createError({ statusCode: 404, statusMessage: "处理任务不存在" });
  assertMemberAccess(user, job.memberId);
  const { memberId: _memberId, ...publicJob } = job;

  const events = listProcessingJobEvents(user, jobId);
  if (job.jobType !== "ai_extract") {
    return {
      job: publicJob,
      units: [],
      generalEvents: events,
      diagnostics: buildProcessingJobDiagnostics(publicJob, events),
    };
  }

  const unitRows = db
    .prepare(
      `
    SELECT id, unit_key AS unitKey, unit_index AS unitIndex, unit_type AS unitType,
      page_numbers_json AS pageNumbersJson, status, attempts, model,
      character_count AS characterCount, candidate_count AS candidateCount,
      matched_count AS matchedCount,
      prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
      elapsed_ms AS elapsedMs, error_code AS errorCode, error_message AS errorMessage,
      started_at AS startedAt, finished_at AS finishedAt
    FROM ai_extraction_units
    WHERE job_id = ? AND status <> 'superseded'
    ORDER BY CASE WHEN unit_type = 'supplement' THEN 1 ELSE 0 END, unit_index, id
  `,
    )
    .all(jobId) as Array<{
    id: string;
    unitKey: string;
    unitIndex: number;
    unitType: "complete_pages" | "page_chunk" | "supplement";
    pageNumbersJson: string;
    status: "planned" | "processing" | "completed" | "warning" | "failed";
    attempts: number;
    model: string | null;
    characterCount: number;
    candidateCount: number;
    matchedCount: number;
    promptTokens: number | null;
    completionTokens: number | null;
    elapsedMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  const unitEvents = new Map<string, ProcessingJobEventItem[]>();
  const generalEvents: ProcessingJobEventItem[] = [];
  const unitKeys = new Set(unitRows.map((unit) => unit.unitKey));
  const unitsByIndex = new Map<number, typeof unitRows>();
  for (const unit of unitRows) {
    const matches = unitsByIndex.get(unit.unitIndex) || [];
    matches.push(unit);
    unitsByIndex.set(unit.unitIndex, matches);
  }
  for (const event of events) {
    const detail = (event.detail || {}) as Record<string, unknown>;
    const eventUnitKey =
      typeof detail.unitKey === "string" ? detail.unitKey : null;
    const eventUnitIndex =
      typeof detail.unitIndex === "number" ? detail.unitIndex : null;
    const legacyIndexMatch =
      eventUnitIndex == null ? null : unitsByIndex.get(eventUnitIndex);
    const resolvedKey =
      eventUnitKey && unitKeys.has(eventUnitKey)
        ? eventUnitKey
        : legacyIndexMatch?.length === 1
          ? legacyIndexMatch[0]?.unitKey
          : null;
    if (!resolvedKey) {
      generalEvents.push(event);
      continue;
    }
    const matched = unitEvents.get(resolvedKey) || [];
    matched.push(event);
    unitEvents.set(resolvedKey, matched);
  }

  const units = unitRows
    .map(({ pageNumbersJson, ...unit }) => ({
      ...unit,
      pageNumbers: parseNumberArray(pageNumbersJson),
      events: unitEvents.get(unit.unitKey) || [],
    }))
    .sort((left, right) => {
      const leftSupplement = left.unitType === "supplement" ? 1 : 0;
      const rightSupplement = right.unitType === "supplement" ? 1 : 0;
      return (
        leftSupplement - rightSupplement ||
        (left.pageNumbers[0] ?? Number.MAX_SAFE_INTEGER) -
          (right.pageNumbers[0] ?? Number.MAX_SAFE_INTEGER) ||
        left.unitIndex - right.unitIndex ||
        left.id.localeCompare(right.id)
      );
    });
  return {
    job: publicJob,
    units,
    generalEvents,
    diagnostics: buildProcessingJobDiagnostics(publicJob, events, units),
  };
}
