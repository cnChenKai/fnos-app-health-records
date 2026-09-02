import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  listProcessingJobEvents,
  cleanupStaleMineruTemporaryFiles,
  claimNextJob,
  processNextJob,
  reprocessReportOcrAndAi,
  type WorkerExecutor,
} from "../services/job-runner.service.ts";
import { importLocalFiles, listLocalImportDirectory } from "../services/local-file-import.service.ts";
import type { MinerURecognitionExecutor } from "../services/mineru-client.service.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import { saveOcrRecognitionSettings } from "../services/ocr-recognition-settings.service.ts";
import {
  deleteReportPage,
  getReportPageOcrDetail,
  updateReportPages,
} from "../services/records.service.ts";
import { createUpload, listProcessingJobs } from "../services/upload.service.ts";

const manager: RequestUser = {
  id: "mineru-runner-manager",
  displayName: "MinerU 任务管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true,
};

function pngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
}

async function withDatabase(run: (storageDir: string) => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-mineru-runner-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('mineru-runner-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('mineru-runner-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    await run(storageDir);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.IMPORT_ROOTS;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function workerRecorder(actions: string[] = []): WorkerExecutor {
  return async (request) => {
    actions.push(request.action);
    if (request.action === "inspect_pdf") {
      return {
        ok: true,
        pageCount: 2,
        pages: [
          { pageNumber: 1, width: 600, height: 840 },
          { pageNumber: 2, width: 600, height: 840 },
        ],
        elapsedMs: 4,
      };
    }
    if (request.action === "thumbnail") {
      return { ok: true, width: 600, height: 840, elapsedMs: 3 };
    }
    return {
      ok: true,
      engine: "local-test-ocr",
      modelVersion: "local-v1",
      lines: [{ id: "local-line", text: "本地识别结果", box: [0, 0, 10, 10], confidence: 0.99 }],
      elapsedMs: 5,
    };
  };
}

function successfulMineru(engine: "mineru-agent" | "mineru-precise" = "mineru-agent"): MinerURecognitionExecutor {
  return async () => ({
    ok: true,
    engine,
    modelVersion: engine === "mineru-agent" ? "agent" : "vlm",
    lines: [{ id: "mineru-line", text: "MinerU 识别结果" }],
    elapsedMs: 12,
    engineElapsed: { source: "mineru_markdown", coordinateAvailable: false },
  });
}

function successfulPrecisePdf(): MinerURecognitionExecutor {
  return async () => ({
    ok: true,
    engine: "mineru-precise",
    modelVersion: "vlm",
    lines: [{ id: "mineru-line-1", text: "第一页" }],
    remotePages: [
      { pageNumber: 1, lines: [{ id: "mineru-page-1", text: "第一页" }] },
      { pageNumber: 2, lines: [{ id: "mineru-page-2", text: "第二页" }] },
    ],
    pageMappingAvailable: true,
    elapsedMs: 12,
    engineElapsed: { source: "mineru_markdown", coordinateAvailable: false },
  });
}

test("remote source OCR runs without a local OCR runtime and queues one task per source", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_precise", apiToken: "precise-test-token" });
    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "remote-source.png", data: pngBytes() },
    ], { ocrMode: "mineru_precise", remoteProcessingAccepted: true });

    assert.equal(upload.jobCount, 1);
    const queued = getDatabase().prepare(
      "SELECT job_type AS jobType FROM processing_jobs WHERE report_id = ? ORDER BY rowid",
    ).all(upload.reportId) as Array<{ jobType: string }>;
    assert.deepEqual(queued.map((job) => job.jobType), ["ocr"]);

    /* Use the production worker reference (rather than a fake worker) so the
       scheduler still performs its local-runtime capability filter. The
       injected MinerU executor is the only engine invoked for this batch. */
    assert.equal(
      await processNextJob(undefined, undefined, successfulMineru("mineru-precise")),
      true,
    );
    const jobs = listProcessingJobs(manager, upload.reportId);
    assert.equal(jobs.some((job) => job.jobType === "thumbnail" || job.jobType === "pdf_extract"), false);
    const ocrJob = jobs.find((job) => job.jobType === "ocr");
    assert.equal(ocrJob?.status, "completed");
    assert.equal(ocrJob?.ocrMode, "mineru_precise");
    const result = getDatabase().prepare(
      "SELECT engine FROM ocr_results WHERE job_id = ?",
    ).get(ocrJob?.id) as { engine: string } | undefined;
    assert.equal(result?.engine, "mineru-precise");
  });
});

test("deleting the first page keeps an active precise source task resumable", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_precise", apiToken: "precise-test-token" });
    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "source.pdf", data: Buffer.from("%PDF-1.4\n%%EOF") },
    ], { ocrMode: "mineru_precise", remoteProcessingAccepted: true });
    const db = getDatabase();
    const first = db.prepare(`
      SELECT id, original_name AS originalName, storage_path AS storagePath,
        mime_type AS mimeType, file_size AS fileSize, sha256, rotation
      FROM report_pages WHERE id = ?
    `).get(upload.pages[0]!.id) as {
      id: string; originalName: string; storagePath: string; mimeType: string;
      fileSize: number; sha256: string; rotation: number;
    };
    db.prepare("UPDATE report_pages SET source_page_count = 2 WHERE id = ?").run(first.id);
    db.prepare(`
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, storage_path, mime_type,
        file_size, sha256, rotation, source_page_number, source_page_count
      ) VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, 2, 2)
    `).run(
      "mineru-second-source-page", upload.reportId, first.originalName, first.storagePath,
      first.mimeType, first.fileSize, first.sha256, first.rotation,
    );

    const claimed = claimNextJob();
    assert.equal(claimed?.jobType, "ocr");
    assert.equal(claimed?.pageId, first.id);

    deleteReportPage(manager, upload.reportId, first.id, {
      ocrMode: "mineru_precise",
      remoteProcessingAccepted: true,
    });

    const survivingJob = db.prepare(`
      SELECT j.page_id AS pageId, j.status
      FROM processing_jobs j
      WHERE j.id = ?
    `).get(claimed!.id) as { pageId: string | null; status: string };
    assert.equal(survivingJob.pageId, "mineru-second-source-page");
    assert.equal(survivingJob.status, "processing");
    const cancelled = db.prepare(`
      SELECT 1 AS found FROM processing_job_events
      WHERE job_id = ? AND event_type = 'cancelled'
    `).get(claimed!.id);
    assert.equal(Boolean(cancelled), false);
  });
});

test("precise source PDF expands validated remote pages without local worker tasks", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_precise", apiToken: "precise-test-token" });
    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "source.pdf", data: Buffer.from("%PDF-1.4\n%%EOF") },
    ], { ocrMode: "mineru_precise", remoteProcessingAccepted: true });

    assert.equal(
      await processNextJob(undefined, undefined, successfulPrecisePdf()),
      true,
    );
    const db = getDatabase();
    const pages = db.prepare(`
      SELECT page_number AS pageNumber, source_page_number AS sourcePageNumber,
        source_page_count AS sourcePageCount
      FROM report_pages WHERE report_id = ? ORDER BY page_number
    `).all(upload.reportId) as Array<{
      pageNumber: number;
      sourcePageNumber: number | null;
      sourcePageCount: number | null;
    }>;
    assert.deepEqual(pages.map((page) => ({ ...page })), [
      { pageNumber: 1, sourcePageNumber: 1, sourcePageCount: 2 },
      { pageNumber: 2, sourcePageNumber: 2, sourcePageCount: 2 },
    ]);
    const jobs = listProcessingJobs(manager, upload.reportId).filter((job) => job.jobType === "ocr");
    assert.equal(jobs.length, 2);
    assert.equal(jobs.every((job) => job.status === "completed"), true);
    assert.equal(jobs.every((job) => job.ocrMode === "mineru_precise"), true);
    assert.deepEqual(
      (db.prepare(`
        SELECT o.page_id AS pageId, o.engine, o.lines_json AS linesJson
        FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
        ORDER BY p.page_number
      `).all() as Array<{ pageId: string; engine: string; linesJson: string }>).map((row) => ({
        engine: row.engine,
        text: JSON.parse(row.linesJson)[0]?.text,
      })),
      [
        { engine: "mineru-precise", text: "第一页" },
        { engine: "mineru-precise", text: "第二页" },
      ],
    );
  });
});

test("Agent source PDF stays a single logical page with no reliable internal page mapping", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_agent" });
    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "agent-source.pdf", data: Buffer.from("%PDF-1.4\n%%EOF") },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });
    const response: MinerURecognitionExecutor = async () => ({
      ok: true,
      engine: "mineru-agent",
      modelVersion: "agent",
      lines: [{ id: "agent-logical", text: "整份文档文字" }],
      elapsedMs: 8,
      engineElapsed: { source: "mineru_markdown", coordinateAvailable: false },
    });
    assert.equal(await processNextJob(undefined, undefined, response), true);
    const db = getDatabase();
    const pages = db.prepare(`
      SELECT page_number AS pageNumber, source_page_number AS sourcePageNumber,
        source_page_count AS sourcePageCount
      FROM report_pages WHERE report_id = ? ORDER BY page_number
    `).all(upload.reportId) as Array<{
      pageNumber: number;
      sourcePageNumber: number | null;
      sourcePageCount: number | null;
    }>;
    assert.deepEqual(pages.map((page) => ({ ...page })), [{ pageNumber: 1, sourcePageNumber: 1, sourcePageCount: null }]);
    const ocr = db.prepare("SELECT engine, lines_json AS linesJson FROM ocr_results").get() as {
      engine: string;
      linesJson: string;
    };
    assert.equal(ocr.engine, "mineru-agent");
    assert.equal(JSON.parse(ocr.linesJson)[0]?.text, "整份文档文字");
    assert.equal(listProcessingJobs(manager, upload.reportId).some((job) => job.jobType === "thumbnail"), false);
  });
});

test("snapshots the selected mode per upload batch even after the global setting changes", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_agent" });
    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "health-page.png", data: pngBytes() },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });
    saveOcrRecognitionSettings({ mode: "local" });
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-ai-token",
    });

    const actions: string[] = [];
    const modes: string[] = [];
    const mineru: MinerURecognitionExecutor = async (input) => {
      modes.push(input.mode);
      assert.match(input.remoteFileName, /^source-[A-Za-z0-9_-]+\.png$/);
      assert.equal(input.remoteFileName.includes("health-page"), false);
      return (await successfulMineru()(input));
    };
    assert.equal(await processNextJob(workerRecorder(actions), undefined, mineru), true);
    assert.deepEqual(modes, ["mineru_agent"]);
    assert.deepEqual(actions, []);

    const jobs = listProcessingJobs(manager, upload.reportId);
    const ocrJob = jobs.find((job) => job.jobType === "ocr")!;
    assert.equal(ocrJob.ocrMode, "mineru_agent");
    assert.equal(ocrJob.remoteProcessingAccepted, true);
    const storedEngine = getDatabase().prepare(
      "SELECT engine FROM ocr_results WHERE job_id = ?",
    ).get(ocrJob.id) as { engine: string };
    assert.equal(storedEngine.engine, "mineru-agent");
    assert.equal(jobs.some((job) => job.jobType === "ai_extract" && job.status === "queued"), true);

    const page = getDatabase().prepare(
      "SELECT id FROM report_pages WHERE report_id = ?",
    ).get(upload.reportId) as { id: string };
    getDatabase().prepare(
      "UPDATE report_pages SET mime_type = 'application/pdf', source_page_number = 1 WHERE id = ?",
    ).run(page.id);
    let coordinateRepairCalls = 0;
    const detail = await getReportPageOcrDetail(manager, upload.reportId, page.id, (async () => {
      coordinateRepairCalls += 1;
      return { pageCount: 1, pages: [{ pageNumber: 1, width: 600, height: 840 }] };
    }) as never);
    assert.equal(coordinateRepairCalls, 0);
    assert.equal(detail?.engine, "mineru-agent");
    assert.equal(detail?.coordWidth, null);
    assert.equal(detail?.coordHeight, null);
    assert.equal(detail?.lines[0]?.box, null);
  });
});

test("remote Agent PDF stays source-scoped without local PDF expansion", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_agent" });
    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "multi-page.pdf", data: Buffer.from("%PDF-1.4\n%%EOF") },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });

    assert.equal(await processNextJob(undefined, undefined, successfulMineru()), true);
    const jobs = listProcessingJobs(manager, upload.reportId);
    const ocrJobs = jobs.filter((job) => job.jobType === "ocr");
    assert.equal(ocrJobs.length, 1);
    assert.equal(ocrJobs.every((job) => job.ocrMode === "mineru_agent"), true);
    assert.equal(ocrJobs.every((job) => job.remoteProcessingAccepted), true);
    assert.equal(jobs.some((job) => job.jobType === "pdf_extract" || job.jobType === "thumbnail"), false);
    const queued = getDatabase().prepare(`
      SELECT detail_json AS detailJson FROM processing_job_events
      WHERE report_id = ? AND event_type = 'queued'
    `).all(upload.reportId) as Array<{ detailJson: string }>;
    assert.equal(queued.length, 1);
    const detail = JSON.parse(queued[0]!.detailJson) as Record<string, unknown>;
    assert.equal(detail.remoteScope, "source");
    assert.equal(detail.ocrMode, "mineru_agent");
    assert.equal(detail.remoteProcessingAccepted, true);
  });
});

test("legacy queued jobs without a mode always use local OCR", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_agent" });
    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "legacy.png", data: pngBytes() },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });
    const ocrJob = getDatabase().prepare(
      "SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ocr'",
    ).get(upload.reportId) as { id: string };
    getDatabase().prepare(`
      UPDATE processing_job_events SET detail_json = ?
      WHERE job_id = ? AND event_type = 'queued'
    `).run(JSON.stringify({ jobType: "ocr", source: "upload", batchId: "initial-upload" }), ocrJob.id);

    const actions: string[] = [];
    let mineruCalls = 0;
    const mineru: MinerURecognitionExecutor = async () => {
      mineruCalls += 1;
      return successfulMineru()({} as never);
    };
    assert.equal(await processNextJob(workerRecorder(actions), undefined, mineru), true);
    assert.equal(mineruCalls, 0);
    assert.deepEqual(actions, ["ocr"]);
    const result = getDatabase().prepare(
      "SELECT engine FROM ocr_results WHERE job_id = ?",
    ).get(ocrJob.id) as { engine: string };
    assert.equal(result.engine, "local-test-ocr");
  });
});

test("automatic retries resume an already uploaded remote task without persisting signed URLs", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_agent" });
    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "resume.png", data: pngBytes() },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });
    const worker = workerRecorder();

    const remoteId = "resume-remote-task";
    const first: MinerURecognitionExecutor = async (input) => {
      assert.equal(input.resume, null);
      input.onSubmitted?.({ kind: "task", id: remoteId });
      input.onState?.({ kind: "task", id: remoteId }, "pending");
      throw Object.assign(new Error("MinerU network unavailable"), { code: "MINERU_NETWORK_ERROR" });
    };
    await assert.rejects(
      () => processNextJob(worker, undefined, first),
      (error: unknown) => (error as { code?: string }).code === "MINERU_NETWORK_ERROR",
    );
    getDatabase().prepare(`
      UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP
      WHERE report_id = ? AND job_type = 'ocr'
    `).run(upload.reportId);

    let resumed = false;
    const second: MinerURecognitionExecutor = async (input) => {
      resumed = true;
      assert.deepEqual(input.resume, { kind: "task", id: remoteId });
      assert.equal(typeof input.remoteStartedAtMs, "number");
      assert.equal((input.remoteStartedAtMs || 0) > 0, true);
      return successfulMineru()(input);
    };
    assert.equal(await processNextJob(worker, undefined, second), true);
    assert.equal(resumed, true);

    const ocrJob = getDatabase().prepare(
      "SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ocr'",
    ).get(upload.reportId) as { id: string };
    const events = listProcessingJobEvents(manager, ocrJob.id);
    assert.equal(events.filter((event) => (event.detail as Record<string, unknown>).stage === "mineru_submitted").length, 1);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("signature="), false);
    assert.equal(serialized.includes("markdown_url"), false);
    assert.equal(serialized.includes("full_zip_url"), false);
    assert.equal(serialized.includes(remoteId), true);
  });
});

test("official source and upstream limits fall back locally while auth errors remain retryable failures", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_agent" });
    const sourceLimitUpload = createUpload(manager, "mineru-runner-member", [
      { originalName: "source-limit.png", data: pngBytes() },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });
    getDatabase().prepare(
      "UPDATE report_pages SET source_page_count = 21 WHERE report_id = ?",
    ).run(sourceLimitUpload.reportId);
    const sourceActions: string[] = [];
    let sourceMineruCalls = 0;
    const neverMineru: MinerURecognitionExecutor = async () => {
      sourceMineruCalls += 1;
      return successfulMineru()({} as never);
    };
    assert.equal(await processNextJob(workerRecorder(sourceActions), undefined, neverMineru), true);
    assert.equal(await processNextJob(workerRecorder(sourceActions), undefined, neverMineru), true);
    assert.equal(await processNextJob(workerRecorder(sourceActions), undefined, neverMineru), true);
    assert.equal(sourceMineruCalls, 0);
    assert.deepEqual(sourceActions, ["thumbnail", "ocr"]);
    const sourceEvents = getDatabase().prepare(`
      SELECT detail_json AS detailJson FROM processing_job_events
      WHERE report_id = ? ORDER BY rowid
    `).all(sourceLimitUpload.reportId) as Array<{ detailJson: string }>;
    assert.equal(sourceEvents.some((event) => JSON.parse(event.detailJson).stage === "mineru_limit_fallback"), true);

    const upstreamLimitUpload = createUpload(manager, "mineru-runner-member", [
      { originalName: "upstream-limit.png", data: pngBytes() },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });
    const upstreamActions: string[] = [];
    const upstreamLimit: MinerURecognitionExecutor = async () => {
      throw Object.assign(new Error("document limit"), { code: "MINERU_LIMIT_EXCEEDED" });
    };
    assert.equal(await processNextJob(workerRecorder(upstreamActions), undefined, upstreamLimit), true);
    assert.equal(await processNextJob(workerRecorder(upstreamActions), undefined, upstreamLimit), true);
    assert.equal(await processNextJob(workerRecorder(upstreamActions), undefined, upstreamLimit), true);
    assert.deepEqual(upstreamActions, ["thumbnail", "ocr"]);

    const authUpload = createUpload(manager, "mineru-runner-member", [
      { originalName: "auth-error.png", data: pngBytes() },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });
    const authActions: string[] = [];
    const authFailure: MinerURecognitionExecutor = async () => {
      throw Object.assign(new Error("authentication failed"), { code: "MINERU_AUTH_FAILED" });
    };
    await assert.rejects(
      () => processNextJob(workerRecorder(authActions), undefined, authFailure),
      (error: unknown) => (error as { code?: string }).code === "MINERU_AUTH_FAILED",
    );
    getDatabase().prepare(
      "UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP WHERE report_id = ? AND job_type = 'ocr'",
    ).run(authUpload.reportId);
    await assert.rejects(
      () => processNextJob(workerRecorder(authActions), undefined, authFailure),
      (error: unknown) => (error as { code?: string }).code === "MINERU_AUTH_FAILED",
    );
    assert.deepEqual(authActions, []);
    const authOcrCount = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM ocr_results o
      JOIN report_pages p ON p.id = o.page_id WHERE p.report_id = ?
    `).get(authUpload.reportId) as { count: number };
    assert.equal(authOcrCount.count, 0);
  });
});

test("page rotation, reorder and deletion require confirmation and snapshot the remote mode", async () => {
  await withDatabase(async () => {
    saveOcrRecognitionSettings({ mode: "mineru_agent" });
    assert.throws(
      () => createUpload(manager, "mineru-runner-member", [
        { originalName: "unconfirmed.png", data: pngBytes() },
      ], { ocrMode: "mineru_agent" }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
    );

    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "page-one.png", data: pngBytes() },
      { originalName: "page-two.png", data: Buffer.concat([Buffer.from(pngBytes()), Buffer.from([2])]) },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });
    const pages = getDatabase().prepare(`
      SELECT id, page_number AS pageNumber, rotation FROM report_pages
      WHERE report_id = ? ORDER BY page_number
    `).all(upload.reportId) as Array<{ id: string; pageNumber: number; rotation: number }>;

    assert.throws(
      () => updateReportPages(manager, upload.reportId, {
        pages: pages.map((page) => ({ id: page.id, rotation: page.rotation })),
        ocrMode: "mineru_agent",
      }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
    );
    updateReportPages(manager, upload.reportId, {
      pages: [
        { id: pages[1]!.id, rotation: 90 },
        { id: pages[0]!.id, rotation: 0 },
      ],
      ocrMode: "mineru_agent",
      remoteProcessingAccepted: true,
    });
    const pageEditDetails = getDatabase().prepare(`
      SELECT e.detail_json AS detailJson FROM processing_job_events e
      JOIN processing_jobs j ON j.id = e.job_id
      WHERE e.report_id = ? AND e.event_type = 'queued' AND j.pipeline_version = 'manual-page-v1'
      ORDER BY e.rowid
    `).all(upload.reportId) as Array<{ detailJson: string }>;
    assert.equal(pageEditDetails.length, 0);

    assert.throws(
      () => deleteReportPage(manager, upload.reportId, pages[0]!.id, {
        ocrMode: "mineru_agent",
      }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
    );
    deleteReportPage(manager, upload.reportId, pages[0]!.id, {
      ocrMode: "mineru_agent",
      remoteProcessingAccepted: true,
    });
    const remaining = getDatabase().prepare(
      "SELECT COUNT(*) AS count FROM report_pages WHERE report_id = ?",
    ).get(upload.reportId) as { count: number };
    assert.equal(remaining.count, 1);
    const latestOcr = getDatabase().prepare(`
      SELECT e.detail_json AS detailJson FROM processing_job_events e
      JOIN processing_jobs j ON j.id = e.job_id
      WHERE e.report_id = ? AND e.event_type = 'queued' AND j.job_type = 'ocr'
      ORDER BY e.rowid DESC LIMIT 1
    `).get(upload.reportId) as { detailJson: string };
    assert.deepEqual(
      (({ ocrMode, remoteProcessingAccepted }) => ({ ocrMode, remoteProcessingAccepted }))(
        JSON.parse(latestOcr.detailJson) as { ocrMode: string; remoteProcessingAccepted: boolean },
      ),
      { ocrMode: "mineru_agent", remoteProcessingAccepted: true },
    );
  });
});

test("manual re-recognition uses the newly confirmed mode for the whole rerun batch", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "mineru-runner-member", [
      { originalName: "rerun.png", data: pngBytes() },
    ]);
    const worker = workerRecorder();
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);

    saveOcrRecognitionSettings({ mode: "mineru_agent" });
    assert.throws(
      () => reprocessReportOcrAndAi(manager, upload.reportId, {
        ocrMode: "mineru_agent",
      }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
    );
    assert.throws(
      () => reprocessReportOcrAndAi(manager, upload.reportId, {
        ocrMode: "local",
        remoteProcessingAccepted: true,
      }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    );
    const rerun = reprocessReportOcrAndAi(manager, upload.reportId, {
      ocrMode: "mineru_agent",
      remoteProcessingAccepted: true,
    });
    assert.equal(rerun.ocrMode, "mineru_agent");
    assert.equal(rerun.queuedOcr, 1);
    const queued = getDatabase().prepare(`
      SELECT e.detail_json AS detailJson FROM processing_job_events e
      JOIN processing_jobs j ON j.id = e.job_id
      WHERE e.report_id = ? AND e.event_type = 'queued'
        AND j.pipeline_version = 'manual-reprocess-v1'
    `).get(upload.reportId) as { detailJson: string };
    const detail = JSON.parse(queued.detailJson) as Record<string, unknown>;
    assert.equal(detail.ocrMode, "mineru_agent");
    assert.equal(detail.remoteProcessingAccepted, true);
  });
});

test("NAS imports enforce the same per-batch mode and remote-processing confirmation", async () => {
  await withDatabase(async (storageDir) => {
    const importRoot = join(storageDir, "authorized-import");
    mkdirSync(importRoot, { recursive: true });
    writeFileSync(join(importRoot, "nas-page.png"), pngBytes());
    process.env.AUTH_MODE = "local";
    process.env.IMPORT_ROOTS = JSON.stringify([importRoot]);
    const root = listLocalImportDirectory().roots[0]!;
    saveOcrRecognitionSettings({ mode: "mineru_agent" });

    assert.throws(
      () => importLocalFiles(manager, "mineru-runner-member", [
        { rootId: root.id, path: "nas-page.png" },
      ], { ocrMode: "mineru_agent" }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
    );
    const imported = importLocalFiles(manager, "mineru-runner-member", [
      { rootId: root.id, path: "nas-page.png" },
    ], { ocrMode: "mineru_agent", remoteProcessingAccepted: true });
    assert.equal(imported.ocrMode, "mineru_agent");
    const details = getDatabase().prepare(`
      SELECT detail_json AS detailJson FROM processing_job_events
      WHERE report_id = ? AND event_type = 'queued'
    `).all(imported.reportId) as Array<{ detailJson: string }>;
    assert.equal(details.length, 1);
    assert.equal(details.every((row) => {
      const detail = JSON.parse(row.detailJson) as Record<string, unknown>;
      return detail.ocrMode === "mineru_agent" && detail.remoteProcessingAccepted === true;
    }), true);
  });
});

test("startup cleanup removes only expired MinerU temporary JPEGs", async () => {
  await withDatabase(async (storageDir) => {
    const directory = join(storageDir, "tmp", "mineru");
    mkdirSync(directory, { recursive: true });
    const expired = join(directory, "expired-job.jpg");
    const active = join(directory, "active-job.jpg");
    const unrelated = join(directory, "keep.txt");
    writeFileSync(expired, "old");
    writeFileSync(active, "new");
    writeFileSync(unrelated, "keep");
    const old = new Date(Date.now() - 60_000);
    utimesSync(expired, old, old);

    assert.equal(cleanupStaleMineruTemporaryFiles(10_000), 1);
    assert.equal(existsSync(expired), false);
    assert.equal(existsSync(active), true);
    assert.equal(existsSync(unrelated), true);
  });
});
