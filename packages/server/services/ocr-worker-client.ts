import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createId } from "../utils/identifier";
import { writeLog } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";

export type WorkerRequest = {
  action: "inspect_pdf" | "thumbnail" | "ocr";
  imagePath: string;
  outputPath?: string;
  pageNumber?: number | null;
  rotation?: number;
  maxSize?: number;
  quality?: number;
  renderScale?: number;
  recycleAfterResponse?: boolean;
};

export type WorkerResponse = {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  pageCount?: number;
  pages?: Array<{ pageNumber: number; width: number; height: number }>;
  width?: number;
  height?: number;
  engine?: string;
  modelVersion?: string;
  lines?: Array<Record<string, unknown>>;
  engineElapsed?: unknown;
  elapsedMs?: number;
};

type PendingRequest = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  process: ChildProcessWithoutNullStreams;
};

let child: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
const pending = new Map<string, PendingRequest>();

function workerError(message: string, code = "OCR_WORKER_UNAVAILABLE") {
  return Object.assign(new Error(message), { code });
}

function rejectPending(error: Error, targetProcess?: ChildProcessWithoutNullStreams) {
  for (const [id, request] of pending.entries()) {
    if (targetProcess && request.process !== targetProcess) continue;
    clearTimeout(request.timer);
    request.reject(error);
    pending.delete(id);
  }
}

function terminateWorkerProcess(process: ChildProcessWithoutNullStreams, error: Error) {
  if (child === process) child = null;
  rejectPending(error, process);
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");
  const forceKillTimer = setTimeout(() => {
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
  }, 5_000);
  forceKillTimer.unref();
  process.once("exit", () => clearTimeout(forceKillTimer));
}

function workerRequestTimeoutMs() {
  const value = Number(process.env.OCR_WORKER_TIMEOUT_MS);
  if (!Number.isFinite(value)) return 10 * 60_000;
  return Math.min(30 * 60_000, Math.max(1_000, Math.round(value)));
}

async function startWorker() {
  if (child) return;
  if (starting) return starting;
  starting = new Promise<void>((resolve, reject) => {
    const config = getAppConfig();
    if (!existsSync(config.ocrPythonBin) || !existsSync(config.ocrWorkerScript)) {
      reject(workerError("OCR 运行环境尚未安装"));
      return;
    }
    const process = spawn(config.ocrPythonBin, [config.ocrWorkerScript], { stdio: ["pipe", "pipe", "pipe"] });
    child = process;
    const startupTimer = setTimeout(() => {
      const error = workerError("OCR Worker 启动超时", "OCR_WORKER_STARTUP_TIMEOUT");
      terminateWorkerProcess(process, error);
      reject(error);
    }, 20_000);
    const output = createInterface({ input: process.stdout });
    output.on("line", (line) => {
      let response: WorkerResponse & { id?: string; type?: string };
      try {
        response = JSON.parse(line) as WorkerResponse & { id?: string; type?: string };
      } catch {
        void writeLog("warn", "ocr-worker-invalid-output");
        return;
      }
      if (response.type === "ready") {
        clearTimeout(startupTimer);
        if (response.ok) resolve();
        else {
          const error = workerError(response.errorMessage || "OCR Worker 启动失败", response.errorCode);
          terminateWorkerProcess(process, error);
          reject(error);
        }
        return;
      }
      if (!response.id) return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.ok) request.resolve(response);
      else request.reject(workerError(response.errorMessage || "Worker 任务失败", response.errorCode || "WORKER_TASK_FAILED"));
    });
    process.stderr.on("data", (chunk) => {
      void writeLog("warn", "ocr-worker-stderr", { message: String(chunk).slice(0, 1000) });
    });
    process.once("error", (error) => {
      clearTimeout(startupTimer);
      if (child === process) child = null;
      rejectPending(error, process);
      reject(error);
    });
    process.once("exit", (code) => {
      clearTimeout(startupTimer);
      if (child === process) child = null;
      rejectPending(workerError(`OCR Worker 已退出（${code ?? "unknown"}）`), process);
    });
  }).finally(() => { starting = null; });
  return starting;
}

export async function requestWorker(payload: WorkerRequest) {
  await startWorker();
  if (!child) throw workerError("OCR Worker 不可用");
  const process = child;
  const id = createId("worker");
  try {
    return await new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = workerError("Worker 任务执行超时，OCR 进程已重新启动", "WORKER_TIMEOUT");
        reject(error);
        terminateWorkerProcess(process, error);
      }, workerRequestTimeoutMs());
      pending.set(id, { resolve, reject, timer, process });
      process.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  } finally {
    if (payload.recycleAfterResponse && child === process) {
      child = null;
      process.stdin.end();
    }
  }
}

export function stopWorker() {
  if (!child) return;
  const process = child;
  terminateWorkerProcess(process, workerError("OCR Worker 已停止", "OCR_WORKER_STOPPED"));
}

process.once("exit", stopWorker);
