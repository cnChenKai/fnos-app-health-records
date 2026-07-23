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
  elapsedMs?: number;
};

type PendingRequest = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

let child: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
const pending = new Map<string, PendingRequest>();

function workerError(message: string, code = "OCR_WORKER_UNAVAILABLE") {
  return Object.assign(new Error(message), { code });
}

function rejectPending(error: Error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
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
      process.kill("SIGTERM");
      reject(workerError("OCR Worker 启动超时"));
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
        else reject(workerError(response.errorMessage || "OCR Worker 启动失败", response.errorCode));
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
      child = null;
      rejectPending(error);
      reject(error);
    });
    process.once("exit", (code) => {
      clearTimeout(startupTimer);
      child = null;
      rejectPending(workerError(`OCR Worker 已退出（${code ?? "unknown"}）`));
    });
  }).finally(() => { starting = null; });
  return starting;
}

export async function requestWorker(payload: WorkerRequest) {
  await startWorker();
  if (!child) throw workerError("OCR Worker 不可用");
  const id = createId("worker");
  return new Promise<WorkerResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(workerError("Worker 任务执行超时", "WORKER_TIMEOUT"));
    }, 10 * 60_000);
    pending.set(id, { resolve, reject, timer });
    child!.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
}

export function stopWorker() {
  child?.kill("SIGTERM");
  child = null;
}

process.once("exit", stopWorker);
