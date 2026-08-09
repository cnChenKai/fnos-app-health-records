import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  processNextJob,
  reprocessReportOcrAndAi,
  type WorkerExecutor,
} from "../services/job-runner.service.ts";
import { requestWorker, stopWorker } from "../services/ocr-worker-client.ts";
import { createUpload } from "../services/upload.service.ts";
import { normalizeReportObservations } from "../services/indicator-normalization.service.ts";
import {
  getReportPagePreviewFile,
  listTrendSeries,
} from "../services/records.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/p3-ocr-worker-decode-failure-golden.json", import.meta.url),
    "utf8",
  ),
) as {
  expected: {
    pdfDecodeCode: string;
    imageDecodeCode: string;
    formatMismatchCode: string;
    ocrEngineLoadsBeforeDecodeFailure: number;
    permanentFailureAttempts: number;
    permanentFailureWorkerRequests: number;
    cancelledSiblingJobs: number;
    activeJobsAfterPermanentFailure: number;
    partialThumbnailExists: boolean;
    failedReportStatus: string;
    pdfPagesAfterDecodeFailure: number;
    pdfOcrResultsAfterDecodeFailure: number;
    ocrResultsAfterRecovery: number;
    reportStatusAfterRecovery: string;
    preservedOcrResultsAfterRerunFailure: number;
    preservedObservationsAfterRerunFailure: number;
    preservedTrendPointsAfterRerunFailure: number;
    preservedReportStatusAfterRerunFailure: string;
    previewFailureStatusCode: number;
  };
};

const manager: RequestUser = {
  id: "p3-decode-failure-manager",
  displayName: "解码失败金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-decode-failure-member";

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x31,
  ]);
}

function pdfBytes() {
  return Buffer.from("%PDF-1.7\ntruncated-pdf-body");
}

function errorCode(error: unknown) {
  return (error as { code?: string })?.code;
}

test("isolates corrupt, disguised, and permanently undecodable OCR inputs without overwriting recoverable data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "health-records-p3-decode-failure-"));
  const previousPythonPath = process.env.PYTHONPATH;
  const previousPythonBin = process.env.OCR_PYTHON_BIN;
  const previousWorkerScript = process.env.OCR_WORKER_SCRIPT;
  process.env.STORAGE_DIR = directory;
  process.env.LOG_DIR = join(directory, "logs");
  process.env.OCR_WORKER_TIMEOUT_MS = "1000";
  process.env.OCR_WORKER_STARTUP_TIMEOUT_MS = "500";
  try {
    const fakeModules = join(directory, "python-modules");
    const pilDirectory = join(fakeModules, "PIL");
    mkdirSync(pilDirectory, { recursive: true });
    const engineLoadMarker = join(directory, "python-engine-loaded");
    writeFileSync(
      join(fakeModules, "fitz.py"),
      `
def open(path):
    raise RuntimeError("damaged xref and trailer at /private/source/report.pdf")
class Matrix:
    def __init__(self, *args): pass
`,
    );
    writeFileSync(join(pilDirectory, "__init__.py"), "from . import Image\n");
    writeFileSync(
      join(pilDirectory, "Image.py"),
      `
MAX_IMAGE_PIXELS = None
def open(path):
    raise RuntimeError("cannot identify image file /private/source/report.png")
`,
    );
    for (const moduleName of ["rapidocr_openvino.py", "rapidocr_onnxruntime.py"]) {
      writeFileSync(
        join(fakeModules, moduleName),
        `
from pathlib import Path
Path(${JSON.stringify(engineLoadMarker)}).write_text("loaded")
class RapidOCR:
    def __call__(self, path): return ([], {})
`,
      );
    }
    process.env.PYTHONPATH = previousPythonPath
      ? `${fakeModules}:${previousPythonPath}`
      : fakeModules;
    process.env.OCR_PYTHON_BIN = "/usr/bin/python3";
    process.env.OCR_WORKER_SCRIPT = resolve("packages/ocr-worker/worker.py");
    stopWorker();

    const corruptPdf = join(directory, "corrupt.pdf");
    const corruptImage = join(directory, "corrupt.png");
    const disguisedPdf = join(directory, "disguised.pdf");
    writeFileSync(corruptPdf, pdfBytes());
    writeFileSync(corruptImage, pngBytes());
    writeFileSync(disguisedPdf, pngBytes());

    await assert.rejects(
      () =>
        requestWorker({
          action: "inspect_pdf",
          imagePath: corruptPdf,
          mimeType: "application/pdf",
        }),
      (error: unknown) => errorCode(error) === fixture.expected.pdfDecodeCode,
    );
    await assert.rejects(
      () =>
        requestWorker({
          action: "ocr",
          imagePath: corruptImage,
          mimeType: "image/png",
        }),
      (error: unknown) => errorCode(error) === fixture.expected.imageDecodeCode,
    );
    await assert.rejects(
      () =>
        requestWorker({
          action: "ocr",
          imagePath: disguisedPdf,
          mimeType: "application/pdf",
        }),
      (error: unknown) => errorCode(error) === fixture.expected.formatMismatchCode,
    );
    assert.equal(
      Number(existsSync(engineLoadMarker)),
      fixture.expected.ocrEngineLoadsBeforeDecodeFailure,
    );
    stopWorker();

    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(
      `
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES (?, '本人', 'self', ?)
    `,
    ).run(memberId, manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `,
    ).run(memberId, manager.id, manager.id);

    const imageUpload = createUpload(manager, memberId, [
      { originalName: "损坏图片.png", data: pngBytes() },
    ]);
    let permanentWorkerRequests = 0;
    let partialThumbnailPath = "";
    const permanentImageFailure: WorkerExecutor = async (request) => {
      permanentWorkerRequests += 1;
      partialThumbnailPath = request.outputPath || "";
      if (request.outputPath) {
        mkdirSync(dirname(request.outputPath), { recursive: true });
        writeFileSync(request.outputPath, Buffer.from([0xff, 0xd8, 0xff]));
      }
      return {
        ok: false,
        errorCode: fixture.expected.imageDecodeCode,
        errorMessage: "Image file cannot be decoded",
      };
    };
    await assert.rejects(
      () => processNextJob(permanentImageFailure),
      /Image file cannot be decoded/,
    );

    const imageJobs = db
      .prepare(
        `
        SELECT status, attempts, error_code AS errorCode, next_retry_at AS nextRetryAt
        FROM processing_jobs WHERE report_id = ? ORDER BY job_type
      `,
      )
      .all(imageUpload.reportId) as Array<{
      status: string;
      attempts: number;
      errorCode: string | null;
      nextRetryAt: string | null;
    }>;
    const failedImageJob = imageJobs.find((job) => job.status === "failed");
    assert.equal(failedImageJob?.attempts, fixture.expected.permanentFailureAttempts);
    assert.equal(failedImageJob?.errorCode, fixture.expected.imageDecodeCode);
    assert.equal(failedImageJob?.nextRetryAt, null);
    assert.equal(
      imageJobs.filter((job) => job.status === "cancelled").length,
      fixture.expected.cancelledSiblingJobs,
    );
    assert.equal(
      permanentWorkerRequests,
      fixture.expected.permanentFailureWorkerRequests,
    );
    assert.equal(
      existsSync(partialThumbnailPath),
      fixture.expected.partialThumbnailExists,
    );
    const activeImageJobs = db
      .prepare(
        `
        SELECT COUNT(*) AS count FROM processing_jobs
        WHERE report_id = ? AND status IN ('queued', 'processing')
      `,
      )
      .get(imageUpload.reportId) as { count: number };
    assert.equal(
      activeImageJobs.count,
      fixture.expected.activeJobsAfterPermanentFailure,
    );
    const failedImageReport = db
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(imageUpload.reportId) as { status: string };
    assert.equal(failedImageReport.status, fixture.expected.failedReportStatus);

    reprocessReportOcrAndAi(manager, imageUpload.reportId);
    const recoveryWorker: WorkerExecutor = async () => ({
      ok: true,
      engine: "decode-recovery-golden",
      modelVersion: "decode-recovery-v1",
      lines: [{ text: "空腹血糖 5.1 mmol/L", confidence: 0.99 }],
      elapsedMs: 4,
    });
    assert.equal(await processNextJob(recoveryWorker), true);
    const recovered = db
      .prepare(
        `
        SELECT r.status,
          (SELECT COUNT(*) FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
            WHERE p.report_id = r.id) AS ocrCount
        FROM reports r WHERE r.id = ?
      `,
      )
      .get(imageUpload.reportId) as { status: string; ocrCount: number };
    assert.equal(recovered.ocrCount, fixture.expected.ocrResultsAfterRecovery);
    assert.equal(recovered.status, fixture.expected.reportStatusAfterRecovery);

    db.prepare(
      `
      UPDATE reports SET status = 'ready', report_issued_at = '2026-08-07' WHERE id = ?
    `,
    ).run(imageUpload.reportId);
    db.prepare(
      `
      INSERT INTO observations (
        id, report_id, item_name, normalized_name, result_text, numeric_value, unit, evidence_json
      ) VALUES ('p3-decode-preserved-observation', ?, '空腹血糖', '空腹血糖', '5.1', 5.1, 'mmol/L', '[]')
    `,
    ).run(imageUpload.reportId);
    normalizeReportObservations(imageUpload.reportId);
    reprocessReportOcrAndAi(manager, imageUpload.reportId);
    await assert.rejects(
      () => processNextJob(permanentImageFailure),
      /Image file cannot be decoded/,
    );
    const preserved = db
      .prepare(
        `
        SELECT r.status,
          (SELECT COUNT(*) FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
            WHERE p.report_id = r.id) AS ocrCount,
          (SELECT COUNT(*) FROM observations o WHERE o.report_id = r.id) AS observationCount
        FROM reports r WHERE r.id = ?
      `,
      )
      .get(imageUpload.reportId) as {
      status: string;
      ocrCount: number;
      observationCount: number;
    };
    const preservedTrendPoints = listTrendSeries(manager, memberId)
      .flatMap((series) => series.points)
      .filter((point) => point.reportId === imageUpload.reportId);
    assert.equal(
      preserved.ocrCount,
      fixture.expected.preservedOcrResultsAfterRerunFailure,
    );
    assert.equal(
      preserved.observationCount,
      fixture.expected.preservedObservationsAfterRerunFailure,
    );
    assert.equal(
      preservedTrendPoints.length,
      fixture.expected.preservedTrendPointsAfterRerunFailure,
    );
    assert.equal(
      preserved.status,
      fixture.expected.preservedReportStatusAfterRerunFailure,
    );

    const pdfUpload = createUpload(manager, memberId, [
      { originalName: "损坏报告.pdf", data: pdfBytes() },
    ]);
    let pdfWorkerRequests = 0;
    const permanentPdfFailure: WorkerExecutor = async () => {
      pdfWorkerRequests += 1;
      return {
        ok: false,
        errorCode: fixture.expected.pdfDecodeCode,
        errorMessage: "PDF file cannot be decoded",
      };
    };
    await assert.rejects(
      () => processNextJob(permanentPdfFailure),
      /PDF file cannot be decoded/,
    );
    const failedPdf = db
      .prepare(
        `
        SELECT r.status,
          (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount,
          (SELECT COUNT(*) FROM ocr_results o JOIN report_pages p ON p.id = o.page_id
            WHERE p.report_id = r.id) AS ocrCount,
          (SELECT COUNT(*) FROM processing_jobs j WHERE j.report_id = r.id
            AND j.status IN ('queued', 'processing')) AS activeJobs
        FROM reports r WHERE r.id = ?
      `,
      )
      .get(pdfUpload.reportId) as {
      status: string;
      pageCount: number;
      ocrCount: number;
      activeJobs: number;
    };
    assert.equal(pdfWorkerRequests, fixture.expected.permanentFailureWorkerRequests);
    assert.equal(failedPdf.status, fixture.expected.failedReportStatus);
    assert.equal(failedPdf.pageCount, fixture.expected.pdfPagesAfterDecodeFailure);
    assert.equal(failedPdf.ocrCount, fixture.expected.pdfOcrResultsAfterDecodeFailure);
    assert.equal(failedPdf.activeJobs, fixture.expected.activeJobsAfterPermanentFailure);
    const pdfPage = db
      .prepare("SELECT id FROM report_pages WHERE report_id = ?")
      .get(pdfUpload.reportId) as { id: string };
    await assert.rejects(
      () => getReportPagePreviewFile(manager, pdfUpload.reportId, pdfPage.id),
      (error: unknown) =>
        (error as { statusCode?: number })?.statusCode ===
        fixture.expected.previewFailureStatusCode,
    );
  } finally {
    stopWorker();
    closeDatabaseForTests();
    if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previousPythonPath;
    if (previousPythonBin === undefined) delete process.env.OCR_PYTHON_BIN;
    else process.env.OCR_PYTHON_BIN = previousPythonBin;
    if (previousWorkerScript === undefined) delete process.env.OCR_WORKER_SCRIPT;
    else process.env.OCR_WORKER_SCRIPT = previousWorkerScript;
    delete process.env.OCR_WORKER_TIMEOUT_MS;
    delete process.env.OCR_WORKER_STARTUP_TIMEOUT_MS;
    delete process.env.STORAGE_DIR;
    delete process.env.LOG_DIR;
    rmSync(directory, { recursive: true, force: true });
  }
});
