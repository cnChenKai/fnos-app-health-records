import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { writeLog } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";
import { assertMemberAccess, assertMemberManage } from "./member.service";
import { requestWorker, type WorkerRequest, type WorkerResponse } from "./ocr-worker-client";
import {
  buildAiExtractionInput, isAiExtractionConfigured, persistAiExtraction, requestAiExtraction,
  type AiExecutor
} from "./ai-extraction.service";
import {
  normalizeReportObservationsWithAiFallback,
  requestAiIndicatorNormalization,
  type AiIndicatorExecutor
} from "./indicator-normalization.service";
import { listManualReportFieldKeys, reportFieldDefinitions } from "./report-field-overrides.service";

type JobRow = {
  id: string;
  reportId: string;
  pageId: string | null;
  jobType: "pdf_extract" | "thumbnail" | "ocr" | "ai_extract";
  attempts: number;
  storagePath: string | null;
  mimeType: string | null;
  pageNumber: number | null;
  sourcePageNumber: number | null;
  rotation: number | null;
};

export type WorkerExecutor = (request: WorkerRequest) => Promise<WorkerResponse>;

const maxAttempts = 3;
const retryDelays = [30, 120, 600];
let started = false;
let busy = false;
let timer: NodeJS.Timeout | null = null;
let lastRunAt: string | null = null;
let lastError: string | null = null;

type JobEventType = "queued" | "started" | "completed" | "retry_scheduled" | "failed" | "manual_retry" | "cancelled";

function safeDetailJson(detail?: Record<string, unknown>) {
  if (!detail) return "{}";
  return JSON.stringify(detail, (_key, value) => {
    if (typeof value === "string") return value.slice(0, 500);
    return value;
  });
}

function hasOcrRuntime(config = getAppConfig()) {
  if (!existsSync(config.ocrPythonBin) || !existsSync(config.ocrWorkerScript)) return false;
  if (!existsSync(join(dirname(dirname(config.ocrPythonBin)), ".health-records-ocr-ready"))) return false;
  const statusPath = join(config.storageDir, "config", "ocr-install-status.json");
  if (!existsSync(statusPath)) return true;
  try {
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as { state?: string };
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
  getDatabase().prepare(`
    INSERT INTO processing_job_events (
      id, job_id, report_id, event_type, status, attempt, message, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId("event"), input.jobId, input.reportId, input.eventType, input.status,
    Math.max(0, Math.round(input.attempt || 0)), input.message?.slice(0, 500) || null,
    safeDetailJson(input.detail)
  );
}

function safeStoragePath(relativePath: string) {
  const root = resolve(getAppConfig().storageDir);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw Object.assign(new Error("存储路径越界"), { code: "INVALID_STORAGE_PATH" });
  }
  return path;
}

export function claimNextJob() {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE processing_jobs SET
        status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
        error_code = CASE WHEN attempts >= ? THEN 'LEASE_EXPIRED' ELSE error_code END,
        error_message = CASE WHEN attempts >= ? THEN '任务执行超时' ELSE error_message END,
        locked_at = NULL, lease_expires_at = NULL,
        next_retry_at = CASE WHEN attempts >= ? THEN NULL ELSE CURRENT_TIMESTAMP END,
        finished_at = CASE WHEN attempts >= ? THEN CURRENT_TIMESTAMP ELSE finished_at END
      WHERE status = 'processing' AND lease_expires_at < CURRENT_TIMESTAMP
    `).run(maxAttempts, maxAttempts, maxAttempts, maxAttempts, maxAttempts);
    const candidate = db.prepare(`
      SELECT j.id FROM processing_jobs j
      WHERE j.status = 'queued'
        AND (j.next_retry_at IS NULL OR j.next_retry_at <= CURRENT_TIMESTAMP)
      ORDER BY CASE j.job_type WHEN 'pdf_extract' THEN 0 WHEN 'thumbnail' THEN 1 WHEN 'ocr' THEN 2 ELSE 3 END,
        j.created_at, j.id LIMIT 1
    `).get() as { id: string } | undefined;
    if (!candidate) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`
      UPDATE processing_jobs SET status = 'processing', attempts = attempts + 1,
        locked_at = CURRENT_TIMESTAMP, lease_expires_at = datetime('now', '+5 minutes'),
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP), next_retry_at = NULL
      WHERE id = ? AND status = 'queued'
    `).run(candidate.id);
    const job = db.prepare(`
      SELECT j.id, j.report_id AS reportId, j.page_id AS pageId, j.job_type AS jobType,
        j.attempts, p.storage_path AS storagePath, p.mime_type AS mimeType,
        p.page_number AS pageNumber, p.source_page_number AS sourcePageNumber, p.rotation
      FROM processing_jobs j LEFT JOIN report_pages p ON p.id = j.page_id WHERE j.id = ?
    `).get(candidate.id) as JobRow;
    db.prepare("UPDATE reports SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(job.reportId);
    appendJobEvent({
      jobId: job.id,
      reportId: job.reportId,
      eventType: "started",
      status: "processing",
      attempt: job.attempts,
      detail: { jobType: job.jobType, pageId: job.pageId, pageNumber: job.pageNumber }
    });
    db.exec("COMMIT");
    return job;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function queueJob(reportId: string, pageId: string, jobType: "thumbnail" | "ocr") {
  const jobId = createId("job");
  const result = getDatabase().prepare(`
    INSERT OR IGNORE INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, ?, ?, 'worker-v1', ?)
  `).run(jobId, reportId, pageId, jobType, `${reportId}:${pageId}:${jobType}:worker-v1`);
  if (Number(result.changes) > 0) {
    appendJobEvent({
      jobId,
      reportId,
      eventType: "queued",
      status: "queued",
      detail: { jobType, pageId, source: "worker" }
    });
  }
}

function reportOcrTextLength(reportId: string) {
  const row = getDatabase().prepare(`
    SELECT COALESCE(SUM(o.text_length), 0) AS total
    FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
    WHERE p.report_id = ?
  `).get(reportId) as { total: number };
  return Number(row.total || 0);
}

function queueAiJobIfReady(reportId: string) {
  if (!isAiExtractionConfigured()) return false;
  const db = getDatabase();
  const counts = db.prepare(`
    SELECT
      SUM(job_type <> 'ai_extract' AND status IN ('queued', 'processing')) AS activeLocal,
      SUM(job_type <> 'ai_extract' AND status = 'failed') AS failedLocal,
      SUM(job_type = 'ocr' AND status = 'completed') AS completedOcr,
      SUM(job_type = 'ai_extract' AND status IN ('queued', 'processing')) AS activeAi,
      SUM(job_type = 'ai_extract' AND status = 'completed') AS completedAi
    FROM processing_jobs WHERE report_id = ?
  `).get(reportId) as { activeLocal: number; failedLocal: number; completedOcr: number; activeAi: number; completedAi: number };
  if (Number(counts.activeLocal) > 0 || Number(counts.failedLocal) > 0 || Number(counts.completedOcr) < 1) return false;
  if (reportOcrTextLength(reportId) < 1) return false;
  if (Number(counts.activeAi) > 0) return false;
  if (Number(counts.completedAi) > 0) {
    const report = db.prepare("SELECT title FROM reports WHERE id = ?").get(reportId) as { title: string } | undefined;
    if (report?.title !== "待识别报告") return false;
  }
  const result = db.prepare(`
    INSERT OR IGNORE INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, NULL, 'ai_extract', 'health-record-v1', ?)
  `);
  const jobId = createId("job");
  const queued = result.run(jobId, reportId, `${reportId}:ai_extract:auto:${jobId}`);
  if (Number(queued.changes) > 0) {
    appendJobEvent({
      jobId,
      reportId,
      eventType: "queued",
      status: "queued",
      detail: { jobType: "ai_extract", source: "ocr_completed" }
    });
  }
  return Number(queued.changes) > 0;
}

function expandPdf(job: JobRow, response: WorkerResponse) {
  if (!job.pageId || job.pageNumber === null) throw new Error("PDF 任务缺少页面信息");
  const pageCount = Math.round(Number(response.pageCount || 0));
  if (pageCount < 1 || pageCount > 500) {
    throw Object.assign(new Error("PDF 页数无效或超过 500 页"), { code: "INVALID_PDF_PAGE_COUNT" });
  }
  const db = getDatabase();
  const source = db.prepare(`
    SELECT original_name AS originalName, storage_path AS storagePath, mime_type AS mimeType,
      file_size AS fileSize, sha256, rotation, source_page_count AS sourcePageCount
    FROM report_pages WHERE id = ?
  `).get(job.pageId) as {
    originalName: string; storagePath: string; mimeType: string; fileSize: number;
    sha256: string; rotation: number; sourcePageCount: number | null;
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!source.sourcePageCount) {
      if (pageCount > 1) {
        db.prepare(`
          UPDATE report_pages SET page_number = -page_number
          WHERE report_id = ? AND page_number > ?
        `).run(job.reportId, job.pageNumber);
        db.prepare(`
          UPDATE report_pages SET page_number = -page_number + ?
          WHERE report_id = ? AND page_number < 0
        `).run(pageCount - 1, job.reportId);
      }
      db.prepare(`
        UPDATE report_pages SET source_page_number = 1, source_page_count = ? WHERE id = ?
      `).run(pageCount, job.pageId);
      for (let sourcePage = 2; sourcePage <= pageCount; sourcePage += 1) {
        const pageId = createId("page");
        db.prepare(`
          INSERT INTO report_pages (
            id, report_id, page_number, original_name, storage_path, mime_type, file_size,
            sha256, rotation, source_page_number, source_page_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pageId, job.reportId, job.pageNumber + sourcePage - 1, source.originalName,
          source.storagePath, source.mimeType, source.fileSize, source.sha256, source.rotation,
          sourcePage, pageCount
        );
        queueJob(job.reportId, pageId, "thumbnail");
        queueJob(job.reportId, pageId, "ocr");
      }
      queueJob(job.reportId, job.pageId, "ocr");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function scoreOcrQuality(lines: Array<Record<string, unknown>>) {
  const texts = lines.map((line) => typeof line.text === "string" ? line.text.trim() : "").filter(Boolean);
  const text = texts.join("\n");
  const textLength = text.length;
  const digitCount = (text.match(/\d/g) || []).length;
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  const usefulRatio = textLength ? (digitCount + cjkCount + latinCount) / textLength : 0;
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
    confidences.length ? `均值置信度${Math.round(avgConfidence * 100)}%` : "无置信度"
  ].join(" · ");
  return { score: bounded, level, reason, textLength };
}

function completeJob(job: JobRow, response: WorkerResponse) {
  if (!job.pageId) throw new Error("页面任务缺少页面 ID");
  const db = getDatabase();
  const ocrMeta = typeof response.engineElapsed === "object" && response.engineElapsed !== null
    ? (response.engineElapsed as Record<string, unknown>)
    : {};
  if (job.jobType === "pdf_extract") {
    expandPdf(job, response);
  } else if (job.jobType === "thumbnail") {
    const relativeThumbnail = `thumbnails/${job.reportId}/${job.pageId}.jpg`;
    db.prepare(`
      UPDATE report_pages SET thumbnail_path = ?, width = ?, height = ? WHERE id = ?
    `).run(relativeThumbnail, Number(response.width || 0) || null, Number(response.height || 0) || null, job.pageId);
  } else if (job.jobType === "ocr") {
    const quality = scoreOcrQuality(response.lines || []);
    db.prepare(`
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json,
        quality_score, quality_level, quality_reason, text_length, elapsed_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        engine = excluded.engine, model_version = excluded.model_version,
        lines_json = excluded.lines_json,
        quality_score = excluded.quality_score,
        quality_level = excluded.quality_level,
        quality_reason = excluded.quality_reason,
        text_length = excluded.text_length,
        elapsed_ms = excluded.elapsed_ms
    `).run(
      createId("ocr"), job.id, job.pageId, response.engine || "rapidocr-openvino",
      response.modelVersion || "unknown", JSON.stringify(response.lines || []),
      quality.score, quality.level, quality.reason, quality.textLength, response.elapsedMs || null
    );
  }
  db.prepare(`
    UPDATE processing_jobs SET status = 'completed', locked_at = NULL, lease_expires_at = NULL,
      error_code = NULL, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(job.id);
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
      ocrSource: typeof ocrMeta.source === "string" ? ocrMeta.source : undefined,
      renderScale: typeof ocrMeta.renderScale === "number" ? ocrMeta.renderScale : undefined,
      pdfTextLines: typeof ocrMeta.pdfTextLines === "number" ? ocrMeta.pdfTextLines : undefined,
      ocrLines: typeof ocrMeta.ocrLines === "number" ? ocrMeta.ocrLines : undefined,
      mergedLines: typeof ocrMeta.mergedLines === "number" ? ocrMeta.mergedLines : undefined,
      imageCoverage: typeof ocrMeta.imageCoverage === "number" ? ocrMeta.imageCoverage : undefined,
      elapsedMs: response.elapsedMs
    }
  });
  if (job.jobType === "ocr") queueAiJobIfReady(job.reportId);
}

function updateReportStatus(reportId: string) {
  const db = getDatabase();
  const previous = db.prepare("SELECT status, member_id AS memberId, title FROM reports WHERE id = ?")
    .get(reportId) as { status: string; memberId: string; title: string } | undefined;
  const counts = db.prepare(`
    SELECT
      SUM(status = 'failed') AS failed,
      SUM(status IN ('queued', 'processing')) AS active,
      SUM(job_type = 'ai_extract' AND status = 'completed') AS completedAi
    FROM processing_jobs WHERE report_id = ?
  `).get(reportId) as { failed: number; active: number; completedAi: number };
  const status = Number(counts.failed) > 0 ? "failed" : Number(counts.active) > 0 ? "processing" : "needs_review";
  db.prepare("UPDATE reports SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(status, reportId);
  if (!previous || previous.status === status) return;
  if (status === "needs_review") {
    const hasAiResult = Number(counts.completedAi) > 0;
    const ocrTextEmpty = !hasAiResult && reportOcrTextLength(reportId) < 1;
    db.prepare(`
      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
      VALUES (?, ?, ?, 'report_processed', ?, ?, ?)
    `).run(
      createId("notice"),
      previous.memberId,
      reportId,
      ocrTextEmpty ? "报告未识别到文字" : "报告处理完成",
      ocrTextEmpty
        ? `「${previous.title}」OCR 未提取到任何文字，可能不是有效的体检报告。请确认原件清晰后重新上传，或手动录入报告内容。`
        : hasAiResult
          ? `「${previous.title}」已完成 OCR 和 AI 整理，等待确认归档。`
          : `「${previous.title}」已完成 OCR 识别，等待确认归档。`,
      ocrTextEmpty ? "warning" : "success"
    );
  } else if (status === "failed") {
    db.prepare(`
      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
      VALUES (?, ?, ?, 'report_failed', ?, ?, 'error')
    `).run(
      createId("notice"),
      previous.memberId,
      reportId,
      "报告处理失败",
      `「${previous.title}」处理失败，可在报告详情中查看日志并重试。`
    );
  }
}

function failJob(job: JobRow, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : "任务执行失败";
  const code = String((error as { code?: string })?.code || "WORKER_TASK_FAILED").slice(0, 80);
  const finalFailure = job.attempts >= maxAttempts;
  const delay = retryDelays[Math.min(job.attempts - 1, retryDelays.length - 1)];
  getDatabase().prepare(`
    UPDATE processing_jobs SET status = ?, locked_at = NULL, lease_expires_at = NULL,
      next_retry_at = CASE WHEN ? THEN NULL ELSE datetime('now', ?) END,
      error_code = ?, error_message = ?, finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id = ?
  `).run(
    finalFailure ? "failed" : "queued", finalFailure ? 1 : 0, `+${delay} seconds`,
    code, message, finalFailure ? 1 : 0, job.id
  );
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
      retryDelaySeconds: finalFailure ? null : delay
    }
  });
}

export async function processNextJob(
  executor: WorkerExecutor = requestWorker,
  aiExecutor: AiExecutor = requestAiExtraction,
  indicatorAiExecutor: AiIndicatorExecutor = requestAiIndicatorNormalization
) {
  const job = claimNextJob();
  if (!job) return false;
  try {
    if (job.jobType === "ai_extract") {
      const persisted = getDatabase().prepare("SELECT 1 AS found FROM report_extractions WHERE job_id = ?")
        .get(job.id) as { found: number } | undefined;
      if (!persisted) {
        const input = buildAiExtractionInput(job.reportId);
        const extraction = await aiExecutor(input);
        persistAiExtraction(job.reportId, job.id, extraction, input.inputCharacters);
        let indicatorNormalization: Record<string, unknown> | null = null;
        try {
          const fallback = await normalizeReportObservationsWithAiFallback(job.reportId, job.id, indicatorAiExecutor);
          indicatorNormalization = fallback.ai;
        } catch (error) {
          indicatorNormalization = {
            skipped: true,
            error: error instanceof Error ? error.message : "AI 指标兜底失败"
          };
        }
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
            inputCharacters: input.inputCharacters,
            promptTokens: extraction.promptTokens,
            completionTokens: extraction.completionTokens,
            elapsedMs: extraction.elapsedMs,
            indicatorNormalization
          }
        });
      }
      getDatabase().prepare(`
        UPDATE processing_jobs SET status = 'completed', locked_at = NULL, lease_expires_at = NULL,
          error_code = NULL, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(job.id);
    } else {
      if (!job.storagePath || !job.pageId) throw new Error("页面任务缺少原件信息");
      const imagePath = safeStoragePath(job.storagePath);
      const request: WorkerRequest = {
        action: job.jobType === "pdf_extract" ? "inspect_pdf" : job.jobType,
        imagePath,
        pageNumber: job.sourcePageNumber,
        rotation: job.rotation || 0
      };
      if (job.jobType === "thumbnail") {
        const relativeThumbnail = `thumbnails/${job.reportId}/${job.pageId}.jpg`;
        const outputPath = safeStoragePath(relativeThumbnail);
        mkdirSync(dirname(outputPath), { recursive: true });
        request.outputPath = outputPath;
      }
      const response = await executor(request);
      if (!response.ok) throw Object.assign(new Error(response.errorMessage || "Worker 任务失败"), { code: response.errorCode });
      completeJob(job, response);
    }
  } catch (error) {
    failJob(job, error);
    throw error;
  } finally {
    updateReportStatus(job.reportId);
  }
  return true;
}

async function tick() {
  if (busy) return;
  const config = getAppConfig();
  if (!hasOcrRuntime(config)) return;
  busy = true;
  try {
    lastRunAt = new Date().toISOString();
    lastError = null;
    await processNextJob();
  } catch (error) {
    lastError = error instanceof Error ? error.message : "任务执行失败";
    await writeLog("warn", "processing-job-failed", { error: lastError });
  } finally {
    busy = false;
  }
}

export function startJobRunner() {
  if (started || process.env.DISABLE_JOB_RUNNER === "true") return;
  started = true;
  timer = setInterval(() => { void tick(); }, 1500);
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
  const counts = getDatabase().prepare(`
    SELECT
      SUM(status = 'queued') AS queued,
      SUM(status = 'processing') AS processing,
      SUM(status = 'failed') AS failed
    FROM processing_jobs
  `).get() as { queued: number; processing: number; failed: number };
  return {
    started,
    busy,
    runtimeAvailable: hasOcrRuntime(config),
    lastRunAt,
    lastError,
    queued: Number(counts.queued || 0),
    processing: Number(counts.processing || 0),
    failed: Number(counts.failed || 0)
  };
}

export function retryProcessingJob(user: RequestUser, jobId: string) {
  const job = getDatabase().prepare(`
    SELECT j.id, j.report_id AS reportId, r.member_id AS memberId, j.status
    FROM processing_jobs j JOIN reports r ON r.id = j.report_id WHERE j.id = ?
  `).get(jobId) as { id: string; reportId: string; memberId: string; status: string } | undefined;
  if (!job) throw createError({ statusCode: 404, statusMessage: "处理任务不存在" });
  assertMemberManage(user, job.memberId);
  if (job.status !== "failed") throw createError({ statusCode: 409, statusMessage: "只有失败任务可以重试" });
  getDatabase().prepare(`
    UPDATE processing_jobs SET status = 'queued', attempts = 0, next_retry_at = CURRENT_TIMESTAMP,
      error_code = NULL, error_message = NULL, finished_at = NULL WHERE id = ?
  `).run(jobId);
  getDatabase().prepare("UPDATE reports SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(job.reportId);
  appendJobEvent({
    jobId,
    reportId: job.reportId,
    eventType: "manual_retry",
    status: "queued",
    attempt: 0,
    message: "用户手动重试任务"
  });
  return { id: jobId, status: "queued" };
}

export function queueManualAiExtraction(user: RequestUser, reportId: string) {
  const db = getDatabase();
  const report = db.prepare("SELECT member_id AS memberId, status FROM reports WHERE id = ? AND status <> 'trashed'")
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  if (!isAiExtractionConfigured()) {
    throw createError({ statusCode: 409, statusMessage: "AI 解析尚未启用或配置不完整" });
  }
  const counts = db.prepare(`
    SELECT
      SUM(job_type <> 'ai_extract' AND status IN ('queued', 'processing')) AS activeLocal,
      SUM(job_type <> 'ai_extract' AND status = 'failed') AS failedLocal,
      SUM(job_type = 'ocr' AND status = 'completed') AS completedOcr,
      SUM(job_type = 'ai_extract' AND status IN ('queued', 'processing')) AS activeAi,
      SUM(job_type = 'ai_extract' AND status = 'completed') AS completedAi
    FROM processing_jobs WHERE report_id = ?
  `).get(reportId) as { activeLocal: number; failedLocal: number; completedOcr: number; activeAi: number; completedAi: number };
  if (Number(counts.activeLocal) > 0) throw createError({ statusCode: 409, statusMessage: "本地识别仍在处理中，完成后再整理" });
  if (Number(counts.failedLocal) > 0) throw createError({ statusCode: 409, statusMessage: "存在失败的 OCR/PDF 任务，请先重试本地识别" });
  if (Number(counts.completedOcr) < 1 || reportOcrTextLength(reportId) < 1) {
    throw createError({ statusCode: 409, statusMessage: "暂无可用于 AI 整理的 OCR 文本" });
  }
  if (Number(counts.activeAi) > 0) throw createError({ statusCode: 409, statusMessage: "AI 整理任务已在队列中" });
  if (Number(counts.completedAi) > 0) {
    const content = db.prepare(`
      SELECT
        (
          NULLIF(TRIM(COALESCE(summary, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(findings, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(impression, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(recommendation, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(clinical_diagnosis, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(purpose, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(chief_complaint, '')), '') IS NOT NULL
          OR EXISTS (SELECT 1 FROM observations WHERE report_id = reports.id)
        ) AS hasContent
      FROM reports WHERE id = ?
    `).get(reportId) as { hasContent: number } | undefined;
    if (Number(content?.hasContent || 0) > 0) {
      throw createError({ statusCode: 409, statusMessage: "这份报告已经完成 AI 整理" });
    }
  }

  const failedAi = db.prepare(`
    SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract' AND status = 'failed'
    ORDER BY created_at DESC LIMIT 1
  `).get(reportId) as { id: string } | undefined;
  if (failedAi) return retryProcessingJob(user, failedAi.id);

  const jobId = createId("job");
  db.prepare(`
    INSERT INTO processing_jobs (
      id, report_id, page_id, job_type, pipeline_version, deduplication_key
    ) VALUES (?, ?, NULL, 'ai_extract', 'health-record-v1', ?)
  `).run(jobId, reportId, `${reportId}:ai_extract:manual:${jobId}`);
  appendJobEvent({
    jobId,
    reportId,
    eventType: "queued",
    status: "queued",
    message: "用户手动触发 AI 整理",
    detail: { jobType: "ai_extract", source: "manual" }
  });
  db.prepare("UPDATE reports SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(reportId);
  return { id: jobId, status: "queued" };
}

export function reprocessReportOcrAndAi(user: RequestUser, reportId: string) {
  const db = getDatabase();
  const report = db.prepare(`
    SELECT id, member_id AS memberId, title, status
    FROM reports WHERE id = ? AND status <> 'trashed'
  `).get(reportId) as { id: string; memberId: string; title: string; status: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const pages = db.prepare(`
    SELECT id, page_number AS pageNumber FROM report_pages
    WHERE report_id = ? ORDER BY page_number
  `).all(reportId) as Array<{ id: string; pageNumber: number }>;
  if (!pages.length) throw createError({ statusCode: 409, statusMessage: "这份报告没有可重新识别的原件页" });
  const running = db.prepare(`
    SELECT job_type AS jobType FROM processing_jobs
    WHERE report_id = ? AND status = 'processing'
    LIMIT 1
  `).get(reportId) as { jobType: string } | undefined;
  if (running) {
    throw createError({ statusCode: 409, statusMessage: "这份报告仍有任务正在处理，请稍后再重新识别" });
  }

  const batchId = createId("batch");
  const cancellable = db.prepare(`
    SELECT id, job_type AS jobType, attempts FROM processing_jobs
    WHERE report_id = ? AND status IN ('queued', 'failed')
  `).all(reportId) as Array<{ id: string; jobType: JobRow["jobType"]; attempts: number }>;
  const queuedOcrJobs: string[] = [];
  const manualFieldKeys = listManualReportFieldKeys(reportId);
  const resetFields = reportFieldDefinitions.filter((field) => !manualFieldKeys.has(field.key));

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const job of cancellable) {
      db.prepare(`
        UPDATE processing_jobs
        SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL,
          next_retry_at = NULL, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
        WHERE id = ?
      `).run(job.id);
      appendJobEvent({
        jobId: job.id,
        reportId,
        eventType: "cancelled",
        status: "cancelled",
        attempt: job.attempts,
        message: "重新识别报告时取消旧任务",
        detail: { jobType: job.jobType, source: "manual_reprocess", batchId }
      });
    }
    db.prepare(`
      DELETE FROM ocr_results
      WHERE page_id IN (SELECT id FROM report_pages WHERE report_id = ?)
    `).run(reportId);
    db.prepare("DELETE FROM observations WHERE report_id = ?").run(reportId);
    db.prepare(`
      UPDATE reports SET
        status = 'processing',
        ${resetFields.map((field) => `${field.column} = ?`).join(",\n        ")}${resetFields.length ? "," : ""}
        organization_id = NULL,
        source_version = source_version + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...resetFields.map((field) => field.resetValue), reportId);
    for (const page of pages) {
      const jobId = createId("job");
      db.prepare(`
        INSERT INTO processing_jobs (
          id, report_id, page_id, job_type, pipeline_version, deduplication_key
        ) VALUES (?, ?, ?, 'ocr', 'manual-reprocess-v1', ?)
      `).run(jobId, reportId, page.id, `${reportId}:${page.id}:ocr:manual-reprocess:${batchId}:${jobId}`);
      appendJobEvent({
        jobId,
        reportId,
        eventType: "queued",
        status: "queued",
        message: "用户重新识别报告",
        detail: { jobType: "ocr", pageId: page.id, pageNumber: page.pageNumber, source: "manual_reprocess", batchId }
      });
      queuedOcrJobs.push(jobId);
    }
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.reprocess_ocr_ai', 'report', ?, ?)
    `).run(createId("audit"), user.id, reportId, JSON.stringify({
      memberId: report.memberId,
      previousStatus: report.status,
      previousTitle: report.title,
      pageCount: pages.length,
      queuedOcr: queuedOcrJobs.length,
      aiConfigured: isAiExtractionConfigured(),
      manualFieldKeys: [...manualFieldKeys],
      batchId
    }));
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
    aiWillRun: isAiExtractionConfigured()
  };
}

export function listProcessingJobEvents(user: RequestUser, jobId: string) {
  const job = getDatabase().prepare(`
    SELECT j.id, j.report_id AS reportId, r.member_id AS memberId,
      j.job_type AS jobType, j.status, j.attempts, j.error_code AS errorCode,
      j.error_message AS errorMessage, j.created_at AS createdAt,
      j.started_at AS startedAt, j.finished_at AS finishedAt
    FROM processing_jobs j JOIN reports r ON r.id = j.report_id WHERE j.id = ?
  `).get(jobId) as {
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
  } | undefined;
  if (!job) throw createError({ statusCode: 404, statusMessage: "处理任务不存在" });
  assertMemberAccess(user, job.memberId);
  const rows = getDatabase().prepare(`
    SELECT id, job_id AS jobId, report_id AS reportId, event_type AS eventType,
      status, attempt, message, detail_json AS detailJson, created_at AS createdAt
    FROM processing_job_events
    WHERE job_id = ?
    ORDER BY created_at, rowid
  `).all(jobId);
  if (!rows.length) {
    const eventType: JobEventType = job.status === "completed" ? "completed"
      : job.status === "failed" ? "failed"
        : job.status === "processing" ? "started"
          : "queued";
    return [{
      id: `${job.id}:snapshot`,
      jobId: job.id,
      reportId: job.reportId,
      eventType,
      status: job.status,
      attempt: job.attempts,
      message: job.errorMessage || "历史任务暂无详细事件日志，已显示当前状态快照",
      detail: {
        jobType: job.jobType,
        code: job.errorCode,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
      },
      createdAt: job.finishedAt || job.startedAt || job.createdAt
    }];
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
    try { detail = JSON.parse(event.detailJson) as Record<string, unknown>; } catch { /* ignore malformed legacy detail */ }
    return { ...event, detail, detailJson: undefined };
  });
}
