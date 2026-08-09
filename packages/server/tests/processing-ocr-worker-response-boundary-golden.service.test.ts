import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { processNextJob } from "../services/job-runner.service.ts";
import { requestWorker, stopWorker } from "../services/ocr-worker-client.ts";
import { createUpload } from "../services/upload.service.ts";
import { writeLog } from "../utils/logger.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/p3-ocr-worker-response-boundary-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  expected: {
    oversizedOutputFailureCode: string;
    oversizedRecoveryProcessCount: number;
    invalidLineFailureCode: string;
    responseLimitFailureCode: string;
    noiseSuccessfulResponses: number;
    invalidOutputLoggedCount: number;
    invalidOutputSuppressedCount: number;
    stderrLoggedCount: number;
    stderrSuppressedCount: number;
    jobRetryAttempts: number;
    jobWorkerRequestCount: number;
    persistedOcrResultCount: number;
    persistedLineCount: number;
    activeJobsAfterRecovery: number;
    reportStatusAfterRecovery: string;
  };
};

const manager: RequestUser = {
  id: "p3-worker-boundary-manager",
  displayName: "Worker 边界金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-worker-boundary-member";

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x33,
  ]);
}

function useWorkerScript(scriptPath: string) {
  stopWorker();
  process.env.OCR_PYTHON_BIN = process.execPath;
  process.env.OCR_WORKER_SCRIPT = scriptPath;
}

function numericFile(path: string) {
  return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

function errorCode(error: unknown) {
  return (error as { code?: string })?.code;
}

test("protects OCR worker response boundaries and recovers without persisting partial data", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "health-records-p3-worker-boundary-"),
  );
  process.env.STORAGE_DIR = directory;
  process.env.LOG_DIR = join(directory, "logs");
  process.env.OCR_WORKER_TIMEOUT_MS = "1000";
  process.env.OCR_WORKER_STARTUP_TIMEOUT_MS = "500";
  process.env.OCR_WORKER_MAX_OUTPUT_LINE_BYTES = "512";
  process.env.OCR_WORKER_MAX_OCR_LINES = "3";
  process.env.OCR_WORKER_MAX_OCR_LINE_CHARACTERS = "32";
  process.env.OCR_WORKER_MAX_OCR_TOTAL_CHARACTERS = "64";
  try {
    const oversizedProcessCountPath = join(
      directory,
      "oversized-process-count",
    );
    const oversizedScript = join(directory, "oversized-worker.mjs");
    writeFileSync(
      oversizedScript,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(oversizedProcessCountPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (count === 0) {
    console.log(JSON.stringify({ id: request.id, ok: true, padding: "x".repeat(2048), lines: [] }));
    return;
  }
  console.log(JSON.stringify({
    id: request.id,
    ok: true,
    lines: [
      { id: "duplicate", text: "项目甲 1.0 mmol/L", confidence: 0.9, box: [0, 0, 10, 10], ignored: { nested: true } },
      { id: "duplicate", text: "项目乙 2.0 mmol/L" }
    ]
  }));
});
`,
    );
    useWorkerScript(oversizedScript);
    await assert.rejects(
      () => requestWorker({ action: "ocr", imagePath: "oversized" }),
      (error: unknown) =>
        errorCode(error) === fixture.expected.oversizedOutputFailureCode,
    );
    const recovered = await requestWorker({
      action: "ocr",
      imagePath: "recovered",
    });
    assert.equal(
      numericFile(oversizedProcessCountPath),
      fixture.expected.oversizedRecoveryProcessCount,
    );
    assert.deepEqual(recovered.lines, [
      {
        id: "duplicate",
        text: "项目甲 1.0 mmol/L",
        confidence: 0.9,
        box: [0, 0, 10, 10],
      },
      { id: "line_2", text: "项目乙 2.0 mmol/L" },
    ]);

    const boundaryScript = join(directory, "response-boundary-worker.mjs");
    writeFileSync(
      boundaryScript,
      `
import { createInterface } from "node:readline";
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const responses = {
    "invalid-line": [null],
    "invalid-confidence": [{ text: "项目", confidence: 2 }],
    "invalid-box": [{ text: "项目", box: [0, 0, "bad", 1] }],
    "too-many": [{ text: "甲" }, { text: "乙" }, { text: "丙" }, { text: "丁" }],
    "line-too-long": [{ text: "长".repeat(33) }],
    "total-too-large": [{ text: "甲".repeat(30) }, { text: "乙".repeat(30) }, { text: "丙".repeat(10) }]
  };
  console.log(JSON.stringify({ id: request.id, ok: true, lines: responses[request.imagePath] || [] }));
});
`,
    );
    for (const imagePath of [
      "invalid-line",
      "invalid-confidence",
      "invalid-box",
    ]) {
      useWorkerScript(boundaryScript);
      await assert.rejects(
        () => requestWorker({ action: "ocr", imagePath }),
        (error: unknown) =>
          errorCode(error) === fixture.expected.invalidLineFailureCode,
      );
    }
    for (const imagePath of ["too-many", "line-too-long", "total-too-large"]) {
      useWorkerScript(boundaryScript);
      await assert.rejects(
        () => requestWorker({ action: "ocr", imagePath }),
        (error: unknown) =>
          errorCode(error) === fixture.expected.responseLimitFailureCode,
      );
    }

    const noiseScript = join(directory, "noise-flood-worker.mjs");
    writeFileSync(
      noiseScript,
      `
import { createInterface } from "node:readline";
for (let index = 0; index < 100; index += 1) console.log("invalid stdout " + index);
process.stderr.write(Array.from({ length: 100 }, (_, index) => "stderr diagnostic " + index).join("\\n") + "\\n");
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, ok: true, lines: [] }));
});
`,
    );
    useWorkerScript(noiseScript);
    const noiseResponse = await requestWorker({
      action: "ocr",
      imagePath: "noise",
    });
    assert.equal(
      Number(noiseResponse.ok),
      fixture.expected.noiseSuccessfulResponses,
    );
    await writeLog("info", "p3-worker-boundary-log-flush");
    const logs = readFileSync(join(directory, "logs", "app.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message: string });
    const countLog = (message: string) =>
      logs.filter((entry) => entry.message === message).length;
    assert.equal(
      countLog("ocr-worker-invalid-output"),
      fixture.expected.invalidOutputLoggedCount,
    );
    assert.equal(
      countLog("ocr-worker-invalid-output-suppressed"),
      fixture.expected.invalidOutputSuppressedCount,
    );
    assert.equal(
      countLog("ocr-worker-stderr"),
      fixture.expected.stderrLoggedCount,
    );
    assert.equal(
      countLog("ocr-worker-stderr-suppressed"),
      fixture.expected.stderrSuppressedCount,
    );

    const jobRequestCountPath = join(directory, "job-request-count");
    const jobScript = join(directory, "job-boundary-worker.mjs");
    writeFileSync(
      jobScript,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const requestCountPath = ${JSON.stringify(jobRequestCountPath)};
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const count = existsSync(requestCountPath) ? Number(readFileSync(requestCountPath, "utf8")) : 0;
  writeFileSync(requestCountPath, String(count + 1));
  if (count === 0) {
    console.log(JSON.stringify({ id: request.id, ok: true, lines: [
      { text: "甲" }, { text: "乙" }, { text: "丙" }, { text: "丁" }
    ] }));
    return;
  }
  console.log(JSON.stringify({
    id: request.id,
    ok: true,
    engine: "boundary-golden",
    modelVersion: "boundary-v1",
    lines: [{
      id: "boundary-line-1",
      text: "匿名检查项目 5.0 mmol/L",
      confidence: 0.99,
      box: [0, 0, 120, 12],
      ignored: "must-not-persist"
    }],
    elapsedMs: 4
  }));
});
`,
    );
    useWorkerScript(jobScript);

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
    const upload = createUpload(manager, memberId, [
      { originalName: "响应边界恢复.png", data: pngBytes() },
    ]);
    db.prepare(
      "UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ? AND job_type = 'thumbnail'",
    ).run(upload.reportId);

    await assert.rejects(
      () => processNextJob(),
      (error: unknown) =>
        errorCode(error) === fixture.expected.responseLimitFailureCode,
    );
    let job = db
      .prepare(
        `
        SELECT id, status, attempts, error_code AS errorCode
        FROM processing_jobs WHERE report_id = ? AND job_type = 'ocr'
      `,
      )
      .get(upload.reportId) as {
      id: string;
      status: string;
      attempts: number;
      errorCode: string | null;
    };
    assert.equal(job.status, "queued");
    assert.equal(job.errorCode, fixture.expected.responseLimitFailureCode);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM ocr_results WHERE job_id = ?")
          .get(job.id) as { count: number }
      ).count,
      0,
    );

    db.prepare(
      "UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(job.id);
    assert.equal(await processNextJob(), true);
    job = db
      .prepare(
        `
        SELECT id, status, attempts, error_code AS errorCode
        FROM processing_jobs WHERE id = ?
      `,
      )
      .get(job.id) as typeof job;
    assert.equal(job.status, "completed");
    assert.equal(job.errorCode, null);
    assert.equal(job.attempts, fixture.expected.jobRetryAttempts);
    assert.equal(
      numericFile(jobRequestCountPath),
      fixture.expected.jobWorkerRequestCount,
    );
    const ocrRows = db
      .prepare(
        "SELECT lines_json AS linesJson FROM ocr_results WHERE job_id = ?",
      )
      .all(job.id) as Array<{ linesJson: string }>;
    assert.equal(ocrRows.length, fixture.expected.persistedOcrResultCount);
    const persistedLines = JSON.parse(ocrRows[0].linesJson) as Array<
      Record<string, unknown>
    >;
    assert.equal(persistedLines.length, fixture.expected.persistedLineCount);
    assert.deepEqual(persistedLines[0], {
      id: "boundary-line-1",
      text: "匿名检查项目 5.0 mmol/L",
      confidence: 0.99,
      box: [0, 0, 120, 12],
    });
    const activeJobs = db
      .prepare(
        `
        SELECT COUNT(*) AS count FROM processing_jobs
        WHERE report_id = ? AND status IN ('queued', 'processing')
      `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(activeJobs.count, fixture.expected.activeJobsAfterRecovery);
    const report = db
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(report.status, fixture.expected.reportStatusAfterRecovery);
  } finally {
    stopWorker();
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.LOG_DIR;
    delete process.env.OCR_PYTHON_BIN;
    delete process.env.OCR_WORKER_SCRIPT;
    delete process.env.OCR_WORKER_TIMEOUT_MS;
    delete process.env.OCR_WORKER_STARTUP_TIMEOUT_MS;
    delete process.env.OCR_WORKER_MAX_OUTPUT_LINE_BYTES;
    delete process.env.OCR_WORKER_MAX_OCR_LINES;
    delete process.env.OCR_WORKER_MAX_OCR_LINE_CHARACTERS;
    delete process.env.OCR_WORKER_MAX_OCR_TOTAL_CHARACTERS;
    rmSync(directory, { recursive: true, force: true });
  }
});
