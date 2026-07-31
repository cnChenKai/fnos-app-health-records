import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  listProcessingJobEvents,
  processNextJob,
  queueManualAiExtraction,
  reprocessReportOcrAndAi,
  retryProcessingJob,
  type WorkerExecutor
} from "../services/job-runner.service.ts";
import { buildReportTitle, normalizeAiExtraction, type AiExecutor } from "../services/ai-extraction.service.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import { createUpload, listProcessingJobs } from "../services/upload.service.ts";
import { getReportDetail, permanentlyDeleteReport, trashReport, updateReportFields } from "../services/records.service.ts";

const manager: RequestUser = {
  id: "runner-manager",
  displayName: "任务管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};
const samplePhone = ["138", "0013", "8000"].join("");
const sampleIdentityCard = ["110105", "19491231", "002X"].join("");
const sensitiveSamplePattern = new RegExp(`${samplePhone}|${sampleIdentityCard}|家庭住址|联系电话|身份证号`);

function pngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
}

function anotherPngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03]);
}

async function withDatabase(run: () => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-runner-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('runner-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('runner-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    await run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

test("completes thumbnail and OCR jobs then marks the report for review", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "report.png", data: pngBytes() }
    ]);
    const executor: WorkerExecutor = async (request) => request.action === "thumbnail"
      ? { ok: true, width: 240, height: 320, elapsedMs: 8 }
      : {
          ok: true,
          engine: "test-ocr",
          modelVersion: "test-v1",
          lines: [{ id: "line_1", text: "检查日期 2026-07-21", confidence: 0.99, box: [0, 0, 10, 10] }],
          elapsedMs: 12
        };
    assert.equal(await processNextJob(executor), true);
    assert.equal(await processNextJob(executor), true);
    assert.equal(await processNextJob(executor), false);

    const report = getDatabase().prepare("SELECT status FROM reports WHERE id = ?").get(upload.reportId) as { status: string };
    assert.equal(report.status, "needs_review");
    const notice = getDatabase().prepare(`
      SELECT type, status, title, severity FROM app_notifications WHERE report_id = ?
    `).get(upload.reportId) as { type: string; status: string; title: string; severity: string };
    assert.equal(notice.type, "report_processed");
    assert.equal(notice.status, "unread");
    assert.equal(notice.title, "报告处理完成");
    assert.equal(notice.severity, "success");
    const page = getDatabase().prepare(`
      SELECT thumbnail_path AS thumbnailPath, width, height FROM report_pages WHERE report_id = ?
    `).get(upload.reportId) as { thumbnailPath: string; width: number; height: number };
    assert.match(page.thumbnailPath, /^thumbnails\//);
    assert.deepEqual({ width: page.width, height: page.height }, { width: 240, height: 320 });
    const ocr = getDatabase().prepare("SELECT engine, lines_json AS linesJson FROM ocr_results").get() as {
      engine: string; linesJson: string;
    };
    assert.equal(ocr.engine, "test-ocr");
    assert.equal(JSON.parse(ocr.linesJson)[0].text, "检查日期 2026-07-21");
  });
});

test("pauses automatic AI extraction when local OCR precheck finds a high-confidence duplicate", async () => {
  await withDatabase(async () => {
    const ocrLines = [
      "健康体检检验结果汇总",
      "白细胞计数 5.62 10^9/L 3.50-9.50",
      "红细胞计数 4.83 10^12/L 4.30-5.80",
      "血红蛋白 151 g/L 130-175",
      "血小板计数 226 10^9/L 125-350",
      "空腹血糖 5.18 mmol/L 3.90-6.10",
      "总胆固醇 4.26 mmol/L 0.00-5.20",
      "甘油三酯 1.12 mmol/L 0.00-1.70",
      "谷丙转氨酶 22 U/L 9-50",
      "肌酐 78 μmol/L 57-111"
    ].map((text, index) => ({
      id: `line_${index + 1}`,
      text,
      confidence: 0.99,
      box: [0, index * 20, 520, index * 20 + 14]
    }));
    const worker: WorkerExecutor = async (request) => request.action === "thumbnail"
      ? { ok: true, width: 900, height: 1200, elapsedMs: 5 }
      : {
          ok: true,
          engine: "test-ocr",
          modelVersion: "test-v1",
          lines: ocrLines,
          elapsedMs: 12
        };

    const existing = createUpload(manager, "runner-member", [
      { originalName: "existing.png", data: pngBytes() }
    ]);
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);
    getDatabase().prepare("UPDATE reports SET status = 'ready', title = '既有体检报告' WHERE id = ?")
      .run(existing.reportId);

    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret"
    });
    const incoming = createUpload(manager, "runner-member", [
      { originalName: "rescanned.png", data: anotherPngBytes() }
    ]);
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);

    const queuedAi = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ai_extract'
    `).get(incoming.reportId) as { count: number };
    assert.equal(queuedAi.count, 0);

    const detail = getReportDetail(manager, incoming.reportId);
    assert.equal(detail.status, "needs_review");
    assert.equal(detail.duplicateCandidates.length, 1);
    assert.equal(detail.duplicateCandidates[0].id, existing.reportId);
    assert.equal(detail.duplicateCandidates[0].confidence, "high");
    assert.match(detail.duplicateCandidates[0].reason, /OCR.*高度一致/);

    const notice = getDatabase().prepare(`
      SELECT title, severity, message FROM app_notifications
      WHERE report_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(incoming.reportId) as { title: string; severity: string; message: string };
    assert.equal(notice.title, "发现可能重复报告");
    assert.equal(notice.severity, "warning");
    assert.match(notice.message, /暂缓自动 AI 整理/);

    const incomingOcrJob = getDatabase().prepare(`
      SELECT id FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ocr'
      ORDER BY created_at DESC LIMIT 1
    `).get(incoming.reportId) as { id: string };
    const events = listProcessingJobEvents(manager, incomingOcrJob.id);
    assert.equal(
      events.some((event) => (event.detail as Record<string, unknown>)?.stage === "duplicate_precheck"),
      true,
      JSON.stringify(events)
    );

    const manualAi = queueManualAiExtraction(manager, incoming.reportId);
    assert.equal(manualAi.status, "queued");
  });
});

test("discards an in-flight worker result after the report is moved to trash", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "cancelled.png", data: pngBytes() }
    ]);
    let finishWorker!: (response: Awaited<ReturnType<WorkerExecutor>>) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const executor: WorkerExecutor = async () => new Promise((resolve) => {
      finishWorker = resolve;
      markStarted();
    });

    const processing = processNextJob(executor);
    await started;
    trashReport(manager, upload.reportId);
    assert.throws(() => permanentlyDeleteReport(manager, upload.reportId), /结束处理中/);
    finishWorker({ ok: true, width: 240, height: 320, elapsedMs: 8 });
    assert.equal(await processing, true);

    const report = getDatabase().prepare("SELECT status FROM reports WHERE id = ?").get(upload.reportId) as { status: string };
    const job = getDatabase().prepare(`
      SELECT status FROM processing_jobs WHERE report_id = ? AND job_type = 'thumbnail'
    `).get(upload.reportId) as { status: string };
    const page = getDatabase().prepare(`
      SELECT thumbnail_path AS thumbnailPath FROM report_pages WHERE report_id = ?
    `).get(upload.reportId) as { thumbnailPath: string | null };
    assert.equal(report.status, "trashed");
    assert.equal(job.status, "cancelled");
    assert.equal(page.thumbnailPath, null);
  });
});

test("skips AI extraction and warns when OCR extracts no text", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret"
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "blank.png", data: pngBytes() }
    ]);
    const worker: WorkerExecutor = async (request) => request.action === "thumbnail"
      ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
      : { ok: true, engine: "test-ocr", modelVersion: "test-v1", lines: [], elapsedMs: 6 };
    let aiCalls = 0;
    const ai: AiExecutor = async () => {
      aiCalls += 1;
      throw new Error("AI should not be called for empty OCR text");
    };

    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), false);
    assert.equal(aiCalls, 0);

    const aiJobs = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'
    `).get(upload.reportId) as { count: number };
    assert.equal(aiJobs.count, 0);
    const report = getDatabase().prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(report.status, "needs_review");
    const notice = getDatabase().prepare(`
      SELECT type, title, severity FROM app_notifications WHERE report_id = ?
    `).get(upload.reportId) as { type: string; title: string; severity: string };
    assert.deepEqual(
      { type: notice.type, title: notice.title, severity: notice.severity },
      { type: "report_processed", title: "报告未识别到文字", severity: "warning" }
    );
    assert.throws(
      () => queueManualAiExtraction(manager, upload.reportId),
      /暂无可用于 AI 整理的 OCR 文本/
    );
  });
});

test("treats legacy OCR rows without text_length as having content", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret"
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "legacy.png", data: pngBytes() }
    ]);
    const worker: WorkerExecutor = async (request) => request.action === "thumbnail"
      ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
      : {
          ok: true,
          engine: "test-ocr",
          modelVersion: "test-v1",
          lines: [{ text: "空腹血糖 5.2 mmol/L", confidence: 0.99, box: [0, 0, 10, 10] }],
          elapsedMs: 6
        };
    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);
    getDatabase().prepare("DELETE FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'")
      .run(upload.reportId);
    /* 模拟 text_length 列加入之前的历史数据：只有 lines_json */
    getDatabase().prepare("UPDATE ocr_results SET text_length = NULL").run();

    const jobs = listProcessingJobs(manager, upload.reportId) as Array<{ jobType: string; ocrTextLength: number | null }>;
    assert.equal(jobs.find((job) => job.jobType === "ocr")?.ocrTextLength, 1);
    const manual = queueManualAiExtraction(manager, upload.reportId);
    assert.equal(manual.status, "queued");
  });
});

test("expands a multi-page PDF and queues work for every source page", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "report.pdf", data: Buffer.from("%PDF-1.4\n%%EOF") }
    ]);
    const recycleFlags: Array<boolean | undefined> = [];
    const executor: WorkerExecutor = async (request) => {
      if (request.action === "inspect_pdf") {
        return {
          ok: true,
          pageCount: 3,
          pages: [
            { pageNumber: 1, width: 595, height: 842 },
            { pageNumber: 2, width: 595, height: 842 },
            { pageNumber: 3, width: 595, height: 842 }
          ]
        };
      }
      if (request.action === "thumbnail") return { ok: true, width: 240, height: 320 };
      recycleFlags.push(request.recycleAfterResponse);
      return {
        ok: true,
        engine: "test-ocr",
        modelVersion: "test-v1",
        lines: [{ id: "line_1", text: "检查结果", confidence: 0.99, box: [0, 0, 10, 10] }]
      };
    };
    assert.equal(await processNextJob(executor), true);
    const pages = getDatabase().prepare(`
      SELECT page_number AS pageNumber, source_page_number AS sourcePageNumber,
        source_page_count AS sourcePageCount
      FROM report_pages WHERE report_id = ? ORDER BY page_number
    `).all(upload.reportId) as Array<{ pageNumber: number; sourcePageNumber: number; sourcePageCount: number }>;
    assert.deepEqual(pages.map((page) => page.sourcePageNumber), [1, 2, 3]);
    assert.equal(pages.every((page) => page.sourcePageCount === 3), true);
    const jobCount = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ?
    `).get(upload.reportId) as { count: number };
    assert.equal(jobCount.count, 7);
    for (let index = 0; index < 6; index += 1) {
      assert.equal(await processNextJob(executor), true);
    }
    assert.deepEqual(recycleFlags, [false, false, true]);
  });
});

test("rejects an incomplete PDF inspection before creating partial page records", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "incomplete.pdf", data: Buffer.from("%PDF-1.4\n%%EOF") }
    ]);
    const executor: WorkerExecutor = async () => ({
      ok: true,
      pageCount: 3,
      pages: [
        { pageNumber: 1, width: 595, height: 842 },
        { pageNumber: 3, width: 595, height: 842 }
      ]
    });

    await assert.rejects(
      () => processNextJob(executor),
      (error: unknown) => (error as { code?: string }).code === "PDF_INSPECTION_INCOMPLETE"
    );
    const pages = getDatabase().prepare(`
      SELECT source_page_count AS sourcePageCount
      FROM report_pages WHERE report_id = ?
    `).all(upload.reportId) as Array<{ sourcePageCount: number | null }>;
    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.sourcePageCount, null);
  });
});

test("allows a manager to retry a failed processing job", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "report.png", data: pngBytes() }
    ]);
    const job = getDatabase().prepare(`
      SELECT id FROM processing_jobs WHERE report_id = ? LIMIT 1
    `).get(upload.reportId) as { id: string };
    getDatabase().prepare(`
      UPDATE processing_jobs SET status = 'failed', attempts = 3, error_code = 'TEST' WHERE id = ?
    `).run(job.id);
    assert.deepEqual(retryProcessingJob(manager, job.id), { id: job.id, status: "queued" });
    const retried = getDatabase().prepare(`
      SELECT status, attempts, error_code AS errorCode FROM processing_jobs WHERE id = ?
    `).get(job.id) as { status: string; attempts: number; errorCode: string | null };
    assert.equal(retried.status, "queued");
    assert.equal(retried.attempts, 0);
    assert.equal(retried.errorCode, null);
    const events = listProcessingJobEvents(manager, job.id) as Array<{ eventType: string; status: string; message: string | null }>;
    assert.equal(events.some((event) => event.eventType === "manual_retry" && event.status === "queued"), true);
  });
});

test("records processing job event history for attempts and failures", async () => {
  await withDatabase(async () => {
    const upload = createUpload(manager, "runner-member", [
      { originalName: "report.png", data: pngBytes() }
    ]);
    const job = getDatabase().prepare(`
      SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'thumbnail'
    `).get(upload.reportId) as { id: string };
    const executor: WorkerExecutor = async () => {
      throw Object.assign(new Error("缩略图生成失败"), { code: "TEST_THUMBNAIL_FAILED" });
    };
    await assert.rejects(() => processNextJob(executor), /缩略图生成失败/);
    const events = listProcessingJobEvents(manager, job.id) as Array<{
      eventType: string;
      status: string;
      attempt: number;
      message: string | null;
      detail: Record<string, unknown>;
    }>;
    assert.deepEqual(events.map((event) => event.eventType), ["queued", "started", "retry_scheduled"]);
    assert.equal(events[1].attempt, 1);
    assert.equal(events[2].status, "queued");
    assert.equal(events[2].message, "缩略图生成失败");
    assert.equal(events[2].detail.code, "TEST_THUMBNAIL_FAILED");
  });
});

test("queues AI extraction after OCR, redacts identity data, and persists validated fields", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret"
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "laboratory.png", data: pngBytes() }
    ]);
    const worker: WorkerExecutor = async (request) => request.action === "thumbnail"
      ? { ok: true, width: 300, height: 400, elapsedMs: 4 }
      : {
          ok: true,
          engine: "test-ocr",
          modelVersion: "test-v1",
          lines: [
            { text: "示例市第一医院 检验报告", confidence: 0.99, box: [0, 0, 20, 10] },
            { text: "报告日期 2026-07-21", confidence: 0.99, box: [0, 12, 20, 22] },
            { text: `联系电话 ${samplePhone}`, confidence: 0.99, box: [0, 24, 20, 34] },
            { text: `身份证号 ${sampleIdentityCard}`, confidence: 0.99, box: [0, 36, 20, 46] },
            { text: "家庭住址 示例路 1 号", confidence: 0.99, box: [0, 48, 20, 58] },
            { text: "空腹血糖 5.2 mmol/L", confidence: 0.99, box: [0, 60, 20, 70] },
            { text: "腹部彩超", confidence: 0.99, box: [0, 72, 20, 82] },
            { text: "肝右叶见3.2×2.8cm囊性回声，边界清晰，无血流信号", confidence: 0.99, box: [0, 84, 20, 94] }
          ],
          elapsedMs: 7
        };
    let aiInput = "";
    let aiCalls = 0;
    const ai: AiExecutor = async (input) => {
      aiCalls += 1;
      aiInput += `\n${input.text}`;
      const normalized = normalizeAiExtraction(input.extractionMode === "morphology" ? {
        morphologyFindings: [{
          sectionName: "腹部彩超",
          organ: "肝脏",
          region: "右叶",
          laterality: "right",
          findingType: "囊肿",
          findingName: "肝右叶囊肿",
          presence: "present",
          size: { length: 3.2, width: 2.8, unit: "cm" },
          morphology: "边界清晰，无血流信号",
          classification: null,
          rawText: "肝右叶见3.2×2.8cm囊性回声，边界清晰，无血流信号",
          evidence: [{ pageNumber: 1, quote: "肝右叶见3.2×2.8cm囊性回声，边界清晰，无血流信号" }],
          confidence: 0.96
        }]
      } : {
        reportType: "laboratory",
        title: "血糖检验报告",
        hospitalNameRaw: "示例市第一医院",
        reportIssuedAt: "2026-07-21",
        identifiers: { reportNo: "R-100", identityCard: sampleIdentityCard, phone: samplePhone },
        summary: "空腹血糖结果 5.2 mmol/L。",
        observations: [{
          sectionName: "生化检验",
          itemName: "空腹血糖",
          normalizedName: "空腹血糖",
          resultText: "5.2",
          numericValue: 5.2,
          unit: "mmol/L",
          referenceLow: 3.9,
          referenceHigh: 6.1,
          abnormalFlag: "normal",
          evidence: [{ pageNumber: 1, quote: "空腹血糖 5.2 mmol/L" }]
        }],
        evidence: { reportIssuedAt: [{ pageNumber: 1, quote: "报告日期 2026-07-21" }] },
        confidence: { reportIssuedAt: 0.98 }
      });
      return {
        provider: "test-provider",
        model: "test-model",
        promptVersion: "test-v1",
        ...normalized,
        rawResponseJson: JSON.stringify(normalized),
        promptTokens: 120,
        completionTokens: 80,
        elapsedMs: 25
      };
    };

    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    const queuedAi = getDatabase().prepare(`
      SELECT id, status FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'
    `).get(upload.reportId) as { id: string; status: string };
    assert.equal(queuedAi.status, "queued");
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), false);

    assert.match(aiInput, /示例市第一医院/);
    assert.doesNotMatch(aiInput, sensitiveSamplePattern);
    const report = getDatabase().prepare(`
      SELECT title, report_type AS reportType, hospital_name_raw AS hospitalName,
        report_issued_at AS reportIssuedAt, identifiers_json AS identifiersJson, status
      FROM reports WHERE id = ?
    `).get(upload.reportId) as {
      title: string; reportType: string; hospitalName: string; reportIssuedAt: string;
      identifiersJson: string; status: string;
    };
    assert.deepEqual(
      { title: report.title, reportType: report.reportType, hospitalName: report.hospitalName, reportIssuedAt: report.reportIssuedAt, status: report.status },
      { title: "血糖检验报告", reportType: "laboratory", hospitalName: "示例市第一医院", reportIssuedAt: "2026-07-21", status: "needs_review" }
    );
    assert.deepEqual(JSON.parse(report.identifiersJson), { reportNo: "R-100" });
    const observation = getDatabase().prepare(`
      SELECT item_name AS itemName, numeric_value AS numericValue, unit, abnormal_flag AS abnormalFlag
      FROM observations WHERE report_id = ?
    `).get(upload.reportId) as { itemName: string; numericValue: number; unit: string; abnormalFlag: string };
    assert.deepEqual(
      { itemName: observation.itemName, numericValue: observation.numericValue, unit: observation.unit, abnormalFlag: observation.abnormalFlag },
      { itemName: "空腹血糖", numericValue: 5.2, unit: "mmol/L", abnormalFlag: "normal" }
    );
    const finding = getDatabase().prepare(`
      SELECT organ, region, finding_type AS findingType, finding_name AS findingName,
        size_length AS sizeLength, size_width AS sizeWidth, size_unit AS sizeUnit,
        morphology_text AS morphology, tracking_group_id AS trackingGroupId,
        match_confidence AS matchConfidence
      FROM morphology_findings WHERE report_id = ?
    `).get(upload.reportId) as {
      organ: string; region: string; findingType: string; findingName: string;
      sizeLength: number; sizeWidth: number; sizeUnit: string; morphology: string;
      trackingGroupId: string; matchConfidence: number;
    };
    assert.deepEqual({
      organ: finding.organ,
      region: finding.region,
      findingType: finding.findingType,
      findingName: finding.findingName,
      sizeLength: finding.sizeLength,
      sizeWidth: finding.sizeWidth,
      sizeUnit: finding.sizeUnit,
      morphology: finding.morphology
    }, {
      organ: "肝脏",
      region: "右叶",
      findingType: "囊肿",
      findingName: "肝右叶囊肿",
      sizeLength: 3.2,
      sizeWidth: 2.8,
      sizeUnit: "cm",
      morphology: "边界清晰，无血流信号"
    });
    assert.match(finding.trackingGroupId, /^morph_[a-f0-9]{24}$/);
    assert.equal(finding.matchConfidence > 0.8, true);
    const detail = getReportDetail(manager, upload.reportId);
    assert.equal(detail.morphologyFindings.length, 1);
    assert.deepEqual(detail.morphologyFindings[0]?.size, {
      length: 3.2,
      width: 2.8,
      height: null,
      unit: "cm"
    });
    assert.equal(detail.morphologyFindings[0]?.examDate, "2026-07-21");
    assert.equal(detail.morphologyFindings[0]?.evidence[0]?.pageNumber, 1);
    const normalization = getDatabase().prepare(`
      SELECT canonical_name AS canonicalName, quality, canonical_value AS canonicalValue, canonical_unit AS canonicalUnit
      FROM observation_normalizations WHERE observation_id = (
        SELECT id FROM observations WHERE report_id = ? LIMIT 1
      )
    `).get(upload.reportId) as { canonicalName: string; quality: string; canonicalValue: number; canonicalUnit: string };
    assert.deepEqual(
      { canonicalName: normalization.canonicalName, quality: normalization.quality, canonicalValue: normalization.canonicalValue, canonicalUnit: normalization.canonicalUnit },
      { canonicalName: "空腹血糖", quality: "high", canonicalValue: 5.2, canonicalUnit: "mmol/L" }
    );
    const extraction = getDatabase().prepare(`
      SELECT model, input_characters AS inputCharacters, prompt_tokens AS promptTokens,
        completion_tokens AS completionTokens, raw_response_json AS rawResponseJson
      FROM report_extractions WHERE report_id = ?
    `).get(upload.reportId) as {
      model: string; inputCharacters: number; promptTokens: number; completionTokens: number; rawResponseJson: string;
    };
    assert.equal(extraction.model, "test-model");
    assert.equal(extraction.inputCharacters > 0, true);
    assert.deepEqual({ promptTokens: extraction.promptTokens, completionTokens: extraction.completionTokens }, { promptTokens: 240, completionTokens: 160 });
    assert.doesNotMatch(extraction.rawResponseJson, new RegExp(`${samplePhone}|${sampleIdentityCard}`));

    getDatabase().prepare("UPDATE processing_jobs SET status = 'queued' WHERE id = ?").run(queuedAi.id);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(aiCalls, 2);
    const observationCount = getDatabase().prepare("SELECT COUNT(*) AS count FROM observations WHERE report_id = ?")
      .get(upload.reportId) as { count: number };
    assert.equal(observationCount.count, 1);
  });
});

test("allows manual AI extraction again when a previous AI job produced no structured content", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret"
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "empty-ai.png", data: pngBytes() }
    ]);
    const worker: WorkerExecutor = async (request) => request.action === "thumbnail"
      ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
      : {
          ok: true,
          engine: "test-ocr",
          modelVersion: "test-v1",
          lines: [{ text: "体检报告", confidence: 0.99, box: [0, 0, 10, 10] }],
          elapsedMs: 6
        };

    assert.equal(await processNextJob(worker), true);
    assert.equal(await processNextJob(worker), true);
    const autoAi = getDatabase().prepare(`
      SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'
    `).get(upload.reportId) as { id: string };
    getDatabase().prepare(`
      UPDATE processing_jobs SET status = 'completed', attempts = 1, finished_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(autoAi.id);

    const manual = queueManualAiExtraction(manager, upload.reportId);
    assert.equal(manual.status, "queued");
    assert.notEqual(manual.id, autoAi.id);
    const queuedManualCount = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ai_extract' AND status = 'queued'
    `).get(upload.reportId) as { count: number };
    assert.equal(queuedManualCount.count, 1);
  });
});

test("reprocesses a single report by clearing current OCR and AI content then queuing fresh OCR", async () => {
  await withDatabase(async () => {
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "health-structurer",
      apiKey: "test-secret"
    });
    const upload = createUpload(manager, "runner-member", [
      { originalName: "checkup.png", data: pngBytes() }
    ]);
    let aiRound = 0;
    const worker: WorkerExecutor = async (request) => request.action === "thumbnail"
      ? { ok: true, width: 240, height: 320, elapsedMs: 5 }
      : {
          ok: true,
          engine: "test-ocr",
          modelVersion: `test-v${aiRound + 1}`,
          lines: [{
            text: aiRound === 0
              ? "旧体检报告 血糖 5.2 mmol/L"
              : "新体检报告 血糖 5.8 mmol/L",
            confidence: 0.99
          }],
          elapsedMs: 6
        };
    const ai: AiExecutor = async (input) => {
      aiRound += 1;
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        title: aiRound === 1 ? "旧血糖报告" : "新血糖报告",
        hospitalNameRaw: "示例医院",
        reportIssuedAt: "2026-07-21",
        summary: input.text.includes("新体检报告") ? "新识别结果" : "旧识别结果",
        observations: [{
          itemName: "血糖",
          normalizedName: "血糖",
          resultText: aiRound === 1 ? "5.2" : "5.8",
          numericValue: aiRound === 1 ? 5.2 : 5.8,
          unit: "mmol/L",
          abnormalFlag: "normal",
          evidence: [{
            pageNumber: 1,
            quote: aiRound === 1
              ? "旧体检报告 血糖 5.2 mmol/L"
              : "新体检报告 血糖 5.8 mmol/L"
          }]
        }]
      });
      return {
        provider: "test-provider",
        model: "test-model",
        promptVersion: "test-v1",
        ...normalized,
        rawResponseJson: JSON.stringify(normalized),
        promptTokens: 10,
        completionTokens: 8,
        elapsedMs: 12
      };
    };

    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(aiRound, 1);

    const beforeManualEdit = getReportDetail(manager, upload.reportId);
    const manuallyEdited = updateReportFields(manager, upload.reportId, {
      title: "旧血糖报告",
      reportType: "laboratory",
      hospitalName: "人工医院",
      hospitalBranch: "",
      city: "",
      visitType: "",
      departmentName: "",
      orderingDepartment: "",
      performingDepartment: "",
      reportingDepartment: "",
      bodyPart: beforeManualEdit.bodyPart || "",
      reportIssuedAt: "2026-07-21",
      examinedAt: "",
      clinicalDiagnosis: "",
      purpose: "",
      findings: "",
      impression: "",
      summary: "人工摘要",
      recommendation: ""
    });
    assert.deepEqual([...manuallyEdited.manualFieldKeys].sort(), ["hospitalName", "reportType", "summary"]);

    const reset = reprocessReportOcrAndAi(manager, upload.reportId);
    assert.equal(reset.queuedOcr, 1);
    assert.equal(reset.aiWillRun, true);
    const cleared = getDatabase().prepare(`
      SELECT title, report_type AS reportType, hospital_name_raw AS hospitalName, summary, status,
        (SELECT COUNT(*) FROM ocr_results o JOIN report_pages p ON p.id = o.page_id WHERE p.report_id = reports.id) AS ocrCount,
        (SELECT COUNT(*) FROM observations WHERE report_id = reports.id) AS observationCount,
        (SELECT COUNT(*) FROM report_extractions WHERE report_id = reports.id) AS extractionCount
      FROM reports WHERE id = ?
    `).get(upload.reportId) as {
      title: string; reportType: string; hospitalName: string | null; summary: string | null; status: string;
      ocrCount: number; observationCount: number; extractionCount: number;
    };
    assert.deepEqual({
      title: cleared.title,
      reportType: cleared.reportType,
      hospitalName: cleared.hospitalName,
      summary: cleared.summary,
      status: cleared.status,
      ocrCount: cleared.ocrCount,
      observationCount: cleared.observationCount,
      extractionCount: cleared.extractionCount
    }, {
      title: "待识别报告",
      reportType: "laboratory",
      hospitalName: "人工医院",
      summary: "人工摘要",
      status: "processing",
      ocrCount: 0,
      observationCount: 0,
      extractionCount: 1
    });
    const queuedOcr = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ocr' AND status = 'queued' AND pipeline_version = 'manual-reprocess-v1'
    `).get(upload.reportId) as { count: number };
    assert.equal(queuedOcr.count, 1);

    assert.equal(await processNextJob(worker, ai), true);
    const queuedAi = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ai_extract' AND status = 'queued'
    `).get(upload.reportId) as { count: number };
    assert.equal(queuedAi.count, 1);
    assert.equal(await processNextJob(worker, ai), true);
    assert.equal(aiRound, 2);
    const refreshed = getDatabase().prepare(`
      SELECT title, report_type AS reportType, hospital_name_raw AS hospitalName, summary,
        (SELECT numeric_value FROM observations WHERE report_id = ? AND item_name = '血糖' ORDER BY created_at DESC LIMIT 1) AS glucose,
        (SELECT COUNT(*) FROM report_extractions WHERE report_id = ?) AS extractionCount
      FROM reports WHERE id = ?
    `).get(upload.reportId, upload.reportId, upload.reportId) as {
      title: string; reportType: string; hospitalName: string; summary: string; glucose: number; extractionCount: number;
    };
    assert.equal(refreshed.title, "新血糖报告");
    assert.equal(refreshed.reportType, "laboratory");
    assert.equal(refreshed.hospitalName, "人工医院");
    assert.equal(refreshed.summary, "人工摘要");
    assert.equal(refreshed.glucose, 5.8);
    assert.equal(refreshed.extractionCount, 2);
    const audits = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'report.reprocess_ocr_ai' AND target_id = ?
    `).get(upload.reportId) as { count: number };
    assert.equal(audits.count, 1);
  });
});

test("builds deterministic titles from extracted report fields", () => {
  const imaging = normalizeAiExtraction({
    reportType: "imaging",
    reportSubtype: "CT",
    hospitalNameRaw: "示例市第一医院",
    reportIssuedAt: "2026-07-21",
    bodyParts: [{ raw: "胸部", name: "胸部", laterality: "unspecified" }]
  }).fields;
  assert.equal(buildReportTitle(imaging), "胸部CT报告");

  const outpatient = normalizeAiExtraction({
    reportType: "outpatient",
    hospitalNameRaw: "示例儿童医院",
    examinedAt: "2026-07-20 09:30:00",
    visitDepartment: "儿科"
  }).fields;
  assert.equal(buildReportTitle(outpatient), "儿科门诊记录");

  const genericLaboratory = normalizeAiExtraction({
    reportType: "laboratory",
    title: "检验报告单",
    observations: [
      { sectionName: "生化检验", itemName: "空腹血糖", resultText: "5.6", numericValue: 5.6, unit: "mmol/L" },
      { sectionName: "生化检验", itemName: "总胆固醇", resultText: "4.8", numericValue: 4.8, unit: "mmol/L" }
    ]
  }).fields;
  assert.equal(buildReportTitle(genericLaboratory), "生化检验报告");
  assert.equal(genericLaboratory.bodyParts[0]?.name, "生化检验");

  const genericCheckup = normalizeAiExtraction({
    reportType: "checkup",
    reportSubtype: "checkup"
  }).fields;
  assert.equal(genericCheckup.reportSubtype, null);
  assert.equal(genericCheckup.bodyParts[0]?.name, "综合体检");
  assert.equal(buildReportTitle(genericCheckup), "综合体检报告");

  const leakedBodyPart = normalizeAiExtraction({
    reportType: "physical_exam",
    reportSubtype: "physical_exam",
    bodyParts: [{ raw: "checkup", name: "checkup", laterality: "unspecified" }]
  }).fields;
  assert.equal(leakedBodyPart.reportSubtype, null);
  assert.equal(leakedBodyPart.bodyParts[0]?.name, "综合体检");

  const meaningfulSubtype = normalizeAiExtraction({
    reportType: "imaging",
    reportSubtype: "腹部彩超"
  }).fields;
  assert.equal(meaningfulSubtype.bodyParts[0]?.name, "腹部彩超");
});

test("keeps scalar indicators separate from structured morphology findings", () => {
  const normalized = normalizeAiExtraction({
    reportType: "imaging",
    observations: [
      {
        sectionName: "一般检查",
        itemName: "体重",
        resultText: "68 kg",
        numericValue: 68,
        unit: "kg"
      },
      {
        sectionName: "腹部彩超",
        itemName: "肝右叶囊肿",
        resultText: "3.2×2.8 cm，边界清晰",
        evidence: [{ pageNumber: 4, quote: "肝右叶囊肿3.2×2.8 cm，边界清晰" }]
      }
    ],
    morphologyFindings: [
      {
        sectionName: "甲状腺彩超",
        organ: "甲状腺",
        laterality: "left",
        findingType: "结节",
        findingName: "甲状腺左叶结节",
        presence: "present",
        size: { length: 6, width: 4, unit: "mm" },
        classification: { system: "C-TIRADS", value: "3", text: "C-TIRADS 3类" },
        morphology: "边界清晰",
        rawText: "甲状腺左叶结节6×4mm，C-TIRADS 3类",
        evidence: [{ pageNumber: 5, quote: "甲状腺左叶结节6×4mm，C-TIRADS 3类" }]
      },
      {
        sectionName: "前列腺彩超",
        organ: "前列腺",
        findingType: "检查发现",
        findingName: "未见明显异常",
        presence: "absent",
        rawText: "前列腺未见明显异常",
        evidence: [{ pageNumber: 6, quote: "前列腺未见明显异常" }]
      },
      {
        sectionName: "前列腺彩超",
        organ: "前列腺",
        findingType: "形态发现",
        findingName: "形态规则",
        presence: "present",
        rawText: "前列腺大小正常，形态规则，边界清晰",
        evidence: [{ pageNumber: 6, quote: "前列腺大小正常，形态规则，边界清晰" }]
      },
      {
        sectionName: "前列腺彩超",
        organ: "前列腺",
        findingType: "检查发现",
        findingName: "检查发现",
        presence: "uncertain",
        rawText: "前列腺超声检查",
        evidence: [{ pageNumber: 6, quote: "前列腺超声检查" }]
      },
      {
        sectionName: "甲状腺彩超",
        organ: "甲状腺",
        findingType: "结节",
        findingName: "未见甲状腺结节",
        presence: "absent",
        rawText: "双侧甲状腺未见明确结节",
        evidence: [{ pageNumber: 5, quote: "双侧甲状腺未见明确结节" }]
      }
    ]
  }).fields;

  assert.deepEqual(normalized.observations.map((item) => item.itemName), ["体重"]);
  assert.equal(normalized.morphologyFindings.length, 3);
  assert.deepEqual(
    normalized.morphologyFindings.map((item) => ({
      name: item.findingName,
      type: item.findingType,
      length: item.size.length,
      width: item.size.width,
      unit: item.size.unit
    })),
    [
      { name: "甲状腺左叶结节", type: "结节", length: 6, width: 4, unit: "mm" },
      { name: "未见甲状腺结节", type: "结节", length: null, width: null, unit: null },
      { name: "肝右叶囊肿", type: "囊肿", length: 3.2, width: 2.8, unit: "cm" }
    ]
  );
});
