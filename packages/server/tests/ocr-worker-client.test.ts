import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestWorker, stopWorker } from "../services/ocr-worker-client.ts";

test("restarts the OCR worker after a request timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "health-records-worker-timeout-"));
  const workerScript = join(directory, "fake-worker.mjs");
  const firstRequestMarker = join(directory, "first-request-seen");
  writeFileSync(workerScript, `
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = ${JSON.stringify(firstRequestMarker)};
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (!existsSync(marker)) {
    writeFileSync(marker, "1");
    return;
  }
  console.log(JSON.stringify({ id: request.id, ok: true, width: 12, height: 34 }));
});
`);
  process.env.OCR_PYTHON_BIN = process.execPath;
  process.env.OCR_WORKER_SCRIPT = workerScript;
  process.env.OCR_WORKER_TIMEOUT_MS = "1000";
  try {
    await assert.rejects(
      () => requestWorker({ action: "thumbnail", imagePath: "/tmp/ignored" }),
      (error: unknown) => (error as { code?: string }).code === "WORKER_TIMEOUT"
    );
    assert.equal(existsSync(firstRequestMarker), true);
    const response = await requestWorker({ action: "thumbnail", imagePath: "/tmp/ignored" });
    assert.deepEqual({ ok: response.ok, width: response.width, height: response.height }, { ok: true, width: 12, height: 34 });
  } finally {
    stopWorker();
    delete process.env.OCR_PYTHON_BIN;
    delete process.env.OCR_WORKER_SCRIPT;
    delete process.env.OCR_WORKER_TIMEOUT_MS;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recycles the OCR worker after the report's final OCR response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "health-records-worker-recycle-"));
  const workerScript = join(directory, "fake-worker.mjs");
  const startupCountPath = join(directory, "startup-count");
  writeFileSync(workerScript, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(startupCountPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, ok: true, lines: [] }));
});
`);
  process.env.OCR_PYTHON_BIN = process.execPath;
  process.env.OCR_WORKER_SCRIPT = workerScript;
  try {
    const first = await requestWorker({ action: "ocr", imagePath: "/tmp/ignored" });
    const second = await requestWorker({
      action: "ocr",
      imagePath: "/tmp/ignored",
      recycleAfterResponse: true
    });
    assert.equal(Number(readFileSync(startupCountPath, "utf8")), 1);
    const nextReport = await requestWorker({
      action: "ocr",
      imagePath: "/tmp/ignored",
      recycleAfterResponse: true
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(nextReport.ok, true);
    assert.equal(Number(readFileSync(startupCountPath, "utf8")), 2);
  } finally {
    stopWorker();
    delete process.env.OCR_PYTHON_BIN;
    delete process.env.OCR_WORKER_SCRIPT;
    rmSync(directory, { recursive: true, force: true });
  }
});
