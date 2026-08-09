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
import { join, resolve } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { processNextJob } from "../services/job-runner.service.ts";
import { requestWorker, stopWorker } from "../services/ocr-worker-client.ts";
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/p3-ocr-worker-memory-lifecycle-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  expected: {
    pythonRequestLimitResponseCount: number;
    pythonRequestLimitProcessCount: number;
    pythonRequestLimitRecycleReason: string;
    pythonMemoryResponseCount: number;
    pythonMemoryProcessCount: number;
    pythonMemoryRecycleReason: string;
    queuedClientRequestCount: number;
    queuedClientProcessCount: number;
    queuedClientRequestLimitRecycleCount: number;
    queuedClientReportBoundaryRecycleCount: number;
    invalidLifecycleProtocolCode: string;
    invalidLifecycleRecoveryProcessCount: number;
    jobReportCount: number;
    jobPageCount: number;
    jobWorkerProcessCount: number;
    jobOcrResultCount: number;
    jobCompletedOcrCount: number;
    jobAttemptTotal: number;
    jobActiveCount: number;
    jobRequestLimitRecycleCount: number;
    jobReportBoundaryRecycleCount: number;
  };
};

const manager: RequestUser = {
  id: "p3-worker-memory-manager",
  displayName: "Worker 内存生命周期金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-worker-memory-member";

function pngBytes(seed = 0x31) {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    seed,
  ]);
}

function countLines(path: string) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).length;
}

function numberFromFile(path: string) {
  return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

function errorCode(error: unknown) {
  return (error as { code?: string })?.code;
}

function configureNodeWorker(scriptPath: string) {
  stopWorker();
  process.env.OCR_PYTHON_BIN = process.execPath;
  process.env.OCR_WORKER_SCRIPT = scriptPath;
}

function writeLifecycleWorker(
  scriptPath: string,
  processCountPath: string,
  requestLogPath?: string,
) {
  writeFileSync(
    scriptPath,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(processCountPath)};
const processNumber = (existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0) + 1;
writeFileSync(countPath, String(processNumber));
let localOcrCount = 0;
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.action === "ocr") localOcrCount += 1;
  let recycleReason = null;
  if (request.action === "ocr" && request.recycleAfterResponse) recycleReason = "report_boundary";
  else if (request.action === "ocr" && localOcrCount >= 3) recycleReason = "request_limit";
  ${requestLogPath ? `appendFileSync(${JSON.stringify(requestLogPath)}, JSON.stringify({ processNumber, localOcrCount, recycleReason, imagePath: request.imagePath }) + "\\n");` : ""}
  console.log(JSON.stringify({
    id: request.id,
    ok: true,
    engine: "memory-golden",
    modelVersion: "memory-v1",
    lines: [{ id: "line-" + processNumber + "-" + localOcrCount, text: "匿名检查项目 " + localOcrCount + ".0 mmol/L", confidence: 0.99, box: [0, 0, 120, 12] }],
    elapsedMs: 3,
    workerRssBytes: 256 * 1024 * 1024,
    workerPeakRssBytes: 320 * 1024 * 1024,
    workerRequestCount: localOcrCount,
    workerOcrRequestCount: localOcrCount,
    recycleRecommended: recycleReason !== null,
    recycleReason
  }));
});
`,
  );
}

test("recycles OCR workers at memory and request high-water marks without losing completed pages", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "health-records-p3-worker-memory-"),
  );
  const previousPythonPath = process.env.PYTHONPATH;
  const previousPythonBin = process.env.OCR_PYTHON_BIN;
  const previousWorkerScript = process.env.OCR_WORKER_SCRIPT;
  const previousMaxRss = process.env.OCR_WORKER_MAX_RSS_BYTES;
  const previousMaxRequests =
    process.env.OCR_WORKER_MAX_OCR_REQUESTS_PER_PROCESS;
  process.env.STORAGE_DIR = directory;
  process.env.LOG_DIR = join(directory, "logs");
  process.env.OCR_WORKER_TIMEOUT_MS = "2000";
  process.env.OCR_WORKER_STARTUP_TIMEOUT_MS = "1000";
  try {
    const fakeModules = join(directory, "python-modules");
    const pilDirectory = join(fakeModules, "PIL");
    mkdirSync(pilDirectory, { recursive: true });
    writeFileSync(join(pilDirectory, "__init__.py"), "from . import Image\n");
    writeFileSync(
      join(pilDirectory, "Image.py"),
      `
MAX_IMAGE_PIXELS = None
class Source:
    size = (64, 64)
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def load(self): return None
def open(path): return Source()
`,
    );
    const engineMarker = join(directory, "python-engine-loads");
    for (const moduleName of [
      "rapidocr_openvino.py",
      "rapidocr_onnxruntime.py",
    ]) {
      writeFileSync(
        join(fakeModules, moduleName),
        `
from pathlib import Path
__version__ = "memory-golden"
class RapidOCR:
    def __init__(self):
        with Path(${JSON.stringify(engineMarker)}).open("a") as marker:
            marker.write("loaded\\n")
    def __call__(self, path):
        return ([([[0, 0], [100, 0], [100, 12], [0, 12]], "匿名检查项目 5.0 mmol/L", 0.99)], {"elapsed": 1})
`,
      );
    }
    process.env.PYTHONPATH = previousPythonPath
      ? `${fakeModules}:${previousPythonPath}`
      : fakeModules;
    process.env.OCR_PYTHON_BIN = "/usr/bin/python3";
    process.env.OCR_WORKER_SCRIPT = resolve("packages/ocr-worker/worker.py");
    const pythonInput = join(directory, "python-input.png");
    writeFileSync(pythonInput, pngBytes());

    process.env.OCR_WORKER_MAX_RSS_BYTES = String(16 * 1024 * 1024 * 1024);
    process.env.OCR_WORKER_MAX_OCR_REQUESTS_PER_PROCESS = "2";
    stopWorker();
    const requestLimitResponses = [];
    for (let index = 0; index < fixture.expected.pythonRequestLimitResponseCount; index += 1) {
      requestLimitResponses.push(
        await requestWorker({ action: "ocr", imagePath: pythonInput }),
      );
    }
    assert.equal(
      requestLimitResponses[1]?.recycleReason,
      fixture.expected.pythonRequestLimitRecycleReason,
    );
    assert.equal(requestLimitResponses[1]?.recycleRecommended, true);
    assert.equal(requestLimitResponses[2]?.workerOcrRequestCount, 1);
    assert.equal(
      countLines(engineMarker),
      fixture.expected.pythonRequestLimitProcessCount,
    );

    stopWorker();
    writeFileSync(engineMarker, "");
    process.env.OCR_WORKER_MAX_RSS_BYTES = "1";
    process.env.OCR_WORKER_MAX_OCR_REQUESTS_PER_PROCESS = "100";
    const memoryResponses = [];
    for (let index = 0; index < fixture.expected.pythonMemoryResponseCount; index += 1) {
      memoryResponses.push(
        await requestWorker({ action: "ocr", imagePath: pythonInput }),
      );
    }
    assert.equal(
      memoryResponses.every(
        (response) =>
          response.recycleReason === fixture.expected.pythonMemoryRecycleReason &&
          response.recycleRecommended === true &&
          Number(response.workerRssBytes) > 0,
      ),
      true,
    );
    assert.equal(
      countLines(engineMarker),
      fixture.expected.pythonMemoryProcessCount,
    );

    const queuedScript = join(directory, "queued-worker.mjs");
    const queuedProcessCount = join(directory, "queued-process-count");
    const queuedRequestLog = join(directory, "queued-request-log.ndjson");
    writeLifecycleWorker(queuedScript, queuedProcessCount, queuedRequestLog);
    configureNodeWorker(queuedScript);
    const queuedResponses = await Promise.all(
      Array.from(
        { length: fixture.expected.queuedClientRequestCount },
        (_, index) =>
          requestWorker({
            action: "ocr",
            imagePath: `queued-page-${index + 1}`,
            recycleAfterResponse:
              index === fixture.expected.queuedClientRequestCount - 1,
          }),
      ),
    );
    assert.equal(queuedResponses.every((response) => response.ok), true);
    assert.equal(
      numberFromFile(queuedProcessCount),
      fixture.expected.queuedClientProcessCount,
    );
    const queuedLog = readFileSync(queuedRequestLog, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { recycleReason: string | null });
    assert.equal(
      queuedLog.filter((entry) => entry.recycleReason === "request_limit")
        .length,
      fixture.expected.queuedClientRequestLimitRecycleCount,
    );
    assert.equal(
      queuedLog.filter((entry) => entry.recycleReason === "report_boundary")
        .length,
      fixture.expected.queuedClientReportBoundaryRecycleCount,
    );

    const invalidScript = join(directory, "invalid-lifecycle-worker.mjs");
    const invalidProcessCount = join(
      directory,
      "invalid-lifecycle-process-count",
    );
    writeFileSync(
      invalidScript,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(invalidProcessCount)};
const processNumber = (existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0) + 1;
writeFileSync(countPath, String(processNumber));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({
    id: request.id,
    ok: true,
    engine: "memory-golden",
    modelVersion: "memory-v1",
    lines: [],
    recycleRecommended: processNumber === 1,
    recycleReason: null
  }));
});
`,
    );
    configureNodeWorker(invalidScript);
    await assert.rejects(
      () => requestWorker({ action: "ocr", imagePath: "invalid-lifecycle" }),
      (error: unknown) =>
        errorCode(error) === fixture.expected.invalidLifecycleProtocolCode,
    );
    assert.equal(
      (
        await requestWorker({
          action: "ocr",
          imagePath: "recovered-lifecycle",
        })
      ).ok,
      true,
    );
    assert.equal(
      numberFromFile(invalidProcessCount),
      fixture.expected.invalidLifecycleRecoveryProcessCount,
    );

    const jobScript = join(directory, "job-worker.mjs");
    const jobProcessCount = join(directory, "job-process-count");
    writeLifecycleWorker(jobScript, jobProcessCount);
    configureNodeWorker(jobScript);
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(
      `
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES (?, '匿名成员', 'self', ?)
    `,
    ).run(memberId, manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `,
    ).run(memberId, manager.id, manager.id);

    const largeUpload = createUpload(
      manager,
      memberId,
      Array.from({ length: 7 }, (_, index) => ({
        originalName: `连续大报告-${index + 1}.png`,
        data: pngBytes(0x31 + index),
      })),
    );
    db.prepare(
      "UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ? AND job_type = 'thumbnail'",
    ).run(largeUpload.reportId);
    for (let index = 0; index < 7; index += 1) {
      assert.equal(await processNextJob(), true);
    }

    const followingUpload = createUpload(
      manager,
      memberId,
      Array.from({ length: 2 }, (_, index) => ({
        originalName: `后续家庭报告-${index + 1}.png`,
        data: pngBytes(0x41 + index),
      })),
    );
    db.prepare(
      "UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ? AND job_type = 'thumbnail'",
    ).run(followingUpload.reportId);
    for (let index = 0; index < 2; index += 1) {
      assert.equal(await processNextJob(), true);
    }
    const uploads = [largeUpload, followingUpload];
    assert.equal(uploads.length, fixture.expected.jobReportCount);

    assert.equal(
      numberFromFile(jobProcessCount),
      fixture.expected.jobWorkerProcessCount,
    );
    const reportIds = uploads.map((upload) => upload.reportId);
    const placeholders = reportIds.map(() => "?").join(", ");
    const jobSummary = db
      .prepare(
        `
        SELECT
          SUM(job_type = 'ocr' AND status = 'completed') AS completedOcr,
          SUM(CASE WHEN job_type = 'ocr' THEN attempts ELSE 0 END) AS attemptTotal,
          SUM(status IN ('queued', 'processing')) AS activeCount
        FROM processing_jobs WHERE report_id IN (${placeholders})
      `,
      )
      .get(...reportIds) as {
      completedOcr: number;
      attemptTotal: number;
      activeCount: number;
    };
    assert.equal(
      Number(jobSummary.completedOcr),
      fixture.expected.jobCompletedOcrCount,
    );
    assert.equal(
      Number(jobSummary.attemptTotal),
      fixture.expected.jobAttemptTotal,
    );
    assert.equal(
      Number(jobSummary.activeCount),
      fixture.expected.jobActiveCount,
    );
    const ocrResultCount = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM ocr_results o
        JOIN report_pages p ON p.id = o.page_id
        WHERE p.report_id IN (${placeholders})
      `,
      )
      .get(...reportIds) as { count: number };
    assert.equal(
      ocrResultCount.count,
      fixture.expected.jobOcrResultCount,
    );
    const completedEvents = db
      .prepare(
        `
        SELECT detail_json AS detailJson
        FROM processing_job_events
        WHERE report_id IN (${placeholders}) AND event_type = 'completed'
      `,
      )
      .all(...reportIds) as Array<{ detailJson: string }>;
    const recycleReasons = completedEvents.map((event) => {
      const detail = JSON.parse(event.detailJson) as {
        workerRecycleReason?: string | null;
      };
      return detail.workerRecycleReason || null;
    });
    assert.equal(
      recycleReasons.filter((reason) => reason === "request_limit").length,
      fixture.expected.jobRequestLimitRecycleCount,
    );
    assert.equal(
      recycleReasons.filter((reason) => reason === "report_boundary").length,
      fixture.expected.jobReportBoundaryRecycleCount,
    );
  } finally {
    stopWorker();
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.LOG_DIR;
    delete process.env.OCR_WORKER_TIMEOUT_MS;
    delete process.env.OCR_WORKER_STARTUP_TIMEOUT_MS;
    if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previousPythonPath;
    if (previousPythonBin === undefined) delete process.env.OCR_PYTHON_BIN;
    else process.env.OCR_PYTHON_BIN = previousPythonBin;
    if (previousWorkerScript === undefined) delete process.env.OCR_WORKER_SCRIPT;
    else process.env.OCR_WORKER_SCRIPT = previousWorkerScript;
    if (previousMaxRss === undefined) delete process.env.OCR_WORKER_MAX_RSS_BYTES;
    else process.env.OCR_WORKER_MAX_RSS_BYTES = previousMaxRss;
    if (previousMaxRequests === undefined)
      delete process.env.OCR_WORKER_MAX_OCR_REQUESTS_PER_PROCESS;
    else
      process.env.OCR_WORKER_MAX_OCR_REQUESTS_PER_PROCESS = previousMaxRequests;
    rmSync(directory, { recursive: true, force: true });
  }
});
