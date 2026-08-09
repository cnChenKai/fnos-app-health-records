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
import {
  processNextJob,
} from "../services/job-runner.service.ts";
import {
  requestWorker,
  stopWorker,
} from "../services/ocr-worker-client.ts";
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/p3-ocr-worker-runtime-fault-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  expected: {
    startupProcessCount: number;
    protocolProcessCount: number;
    noiseSuccessfulResponses: number;
    jobRetryAttempts: number;
    jobWorkerRequestCount: number;
    ocrResultCount: number;
    activeJobsAfterRecovery: number;
    reportStatusAfterRecovery: string;
  };
};

const manager: RequestUser = {
  id: "p3-worker-runtime-manager",
  displayName: "Worker 运行时金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-worker-runtime-member";

function pngBytes() {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x31,
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

test("recovers OCR worker startup, protocol, noise, and in-flight crash faults deterministically", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "health-records-p3-worker-runtime-"),
  );
  process.env.STORAGE_DIR = directory;
  process.env.LOG_DIR = join(directory, "logs");
  process.env.OCR_WORKER_TIMEOUT_MS = "1000";
  process.env.OCR_WORKER_STARTUP_TIMEOUT_MS = "500";
  try {
    const startupCountPath = join(directory, "startup-count");
    const startupScript = join(directory, "startup-exit-worker.mjs");
    writeFileSync(
      startupScript,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(startupCountPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
if (count === 0) process.exit(17);
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, ok: true, width: 12, height: 34 }));
});
`,
    );
    useWorkerScript(startupScript);
    await assert.rejects(
      () =>
        requestWorker({ action: "thumbnail", imagePath: "/tmp/ignored" }),
      (error: unknown) =>
        (error as { code?: string })?.code === "OCR_WORKER_EXITED",
    );
    const startupRecovery = await requestWorker({
      action: "thumbnail",
      imagePath: "/tmp/ignored",
    });
    assert.equal(startupRecovery.ok, true);
    assert.equal(
      numericFile(startupCountPath),
      fixture.expected.startupProcessCount,
    );

    const protocolCountPath = join(directory, "protocol-count");
    const protocolScript = join(directory, "protocol-worker.mjs");
    writeFileSync(
      protocolScript,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(protocolCountPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (count === 0) {
    console.log(JSON.stringify({ id: request.id, ok: true }));
    return;
  }
  console.log(JSON.stringify({ id: request.id, ok: true, width: 24, height: 48 }));
});
`,
    );
    useWorkerScript(protocolScript);
    await assert.rejects(
      () =>
        requestWorker({ action: "thumbnail", imagePath: "/tmp/ignored" }),
      (error: unknown) =>
        (error as { code?: string })?.code === "OCR_WORKER_PROTOCOL_ERROR",
    );
    const protocolRecovery = await requestWorker({
      action: "thumbnail",
      imagePath: "/tmp/ignored",
    });
    assert.equal(protocolRecovery.ok, true);
    assert.equal(
      numericFile(protocolCountPath),
      fixture.expected.protocolProcessCount,
    );

    const noiseScript = join(directory, "noise-worker.mjs");
    writeFileSync(
      noiseScript,
      `
import { createInterface } from "node:readline";
console.log("diagnostic text before ready");
console.error("simulated harmless stderr diagnostic");
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  console.log("task progress is not protocol json");
  console.log("null");
  console.log(JSON.stringify({ id: request.id, ok: true, lines: [] }));
});
`,
    );
    useWorkerScript(noiseScript);
    const noiseResponse = await requestWorker({
      action: "ocr",
      imagePath: "/tmp/ignored",
    });
    assert.equal(
      Number(noiseResponse.ok),
      fixture.expected.noiseSuccessfulResponses,
    );

    const crashMarkerPath = join(directory, "request-crash-marker");
    const requestCountPath = join(directory, "request-count");
    const jobStartupCountPath = join(directory, "job-startup-count");
    const crashScript = join(directory, "request-crash-worker.mjs");
    writeFileSync(
      crashScript,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const crashMarker = ${JSON.stringify(crashMarkerPath)};
const requestCountPath = ${JSON.stringify(requestCountPath)};
const startupCountPath = ${JSON.stringify(jobStartupCountPath)};
const startupCount = existsSync(startupCountPath) ? Number(readFileSync(startupCountPath, "utf8")) : 0;
writeFileSync(startupCountPath, String(startupCount + 1));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const requestCount = existsSync(requestCountPath) ? Number(readFileSync(requestCountPath, "utf8")) : 0;
  writeFileSync(requestCountPath, String(requestCount + 1));
  if (!existsSync(crashMarker)) {
    writeFileSync(crashMarker, "1");
    process.exit(23);
  }
  console.log(JSON.stringify({
    id: request.id,
    ok: true,
    engine: "runtime-golden-ocr",
    modelVersion: "runtime-v1",
    lines: [{
      id: "runtime_line_1",
      text: "匿名检查项目 5.0 mmol/L",
      confidence: 0.99,
      box: [0, 0, 120, 12]
    }],
    elapsedMs: 4
  }));
});
`,
    );
    useWorkerScript(crashScript);

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
      { originalName: "运行时恢复.png", data: pngBytes() },
    ]);
    db.prepare(
      "UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ? AND job_type = 'thumbnail'",
    ).run(upload.reportId);

    await assert.rejects(
      () => processNextJob(),
      (error: unknown) =>
        (error as { code?: string })?.code === "OCR_WORKER_EXITED",
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
    assert.equal(job.errorCode, "OCR_WORKER_EXITED");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM ocr_results WHERE job_id = ?")
        .get(job.id) as { count: number }).count,
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
      numericFile(requestCountPath),
      fixture.expected.jobWorkerRequestCount,
    );
    assert.equal(numericFile(jobStartupCountPath), 2);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM ocr_results WHERE job_id = ?")
        .get(job.id) as { count: number }).count,
      fixture.expected.ocrResultCount,
    );
    const activeJobs = db
      .prepare(
        `
        SELECT COUNT(*) AS count FROM processing_jobs
        WHERE report_id = ? AND status IN ('queued', 'processing')
      `,
      )
      .get(upload.reportId) as { count: number };
    assert.equal(
      activeJobs.count,
      fixture.expected.activeJobsAfterRecovery,
    );
    const report = db
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string };
    assert.equal(
      report.status,
      fixture.expected.reportStatusAfterRecovery,
    );
    const retryEvent = db
      .prepare(
        `
        SELECT detail_json AS detailJson
        FROM processing_job_events
        WHERE job_id = ? AND event_type = 'retry_scheduled'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `,
      )
      .get(job.id) as { detailJson: string };
    assert.equal(
      JSON.parse(retryEvent.detailJson).code,
      "OCR_WORKER_EXITED",
    );
  } finally {
    stopWorker();
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.LOG_DIR;
    delete process.env.OCR_PYTHON_BIN;
    delete process.env.OCR_WORKER_SCRIPT;
    delete process.env.OCR_WORKER_TIMEOUT_MS;
    delete process.env.OCR_WORKER_STARTUP_TIMEOUT_MS;
    rmSync(directory, { recursive: true, force: true });
  }
});
