import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { getAppConfig } from "../utils/runtime-config";
import { getJobRunnerStatus } from "./job-runner.service";

let installing = false;

type OcrInstallState = "idle" | "installing" | "success" | "failed";

type OcrInstallStatus = {
  state: OcrInstallState;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  warning?: string;
  runtimeReady?: boolean;
  missing?: string[];
  logPath?: string;
  logTail?: string[];
};

type OcrRuntimeInfo = {
  createdAt?: string;
  python?: string;
  pythonVersion?: string;
  backend?: string;
  engine?: string;
  modelVersion?: string;
  rapidocrVersion?: string;
  pymupdfVersion?: string;
  pillowVersion?: string;
  pillowHeifVersion?: string;
  platform?: string;
  machine?: string;
};

function readyMarkerPath(pythonBin: string) {
  return join(dirname(dirname(pythonBin)), ".health-records-ocr-ready");
}

function hasVerifiedRuntime() {
  return runtimeReadiness().ready;
}

function runtimeReadiness() {
  const config = getAppConfig();
  const checks = [
    { key: "pythonBin", path: config.ocrPythonBin, ok: existsSync(config.ocrPythonBin) },
    { key: "workerScript", path: config.ocrWorkerScript, ok: existsSync(config.ocrWorkerScript) },
    { key: "readyMarker", path: readyMarkerPath(config.ocrPythonBin), ok: existsSync(readyMarkerPath(config.ocrPythonBin)) }
  ];
  return {
    ready: checks.every((item) => item.ok),
    checks,
    missing: checks.filter((item) => !item.ok).map((item) => `${item.key}: ${item.path}`)
  };
}

function installStatusPath(storageDir: string) {
  return join(storageDir, "config", "ocr-install-status.json");
}

function installLogPath(logDir: string) {
  return join(logDir, "ocr-install.log");
}

function readLogTail(path: string, maxLines = 80) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

function readInstallStatus(): OcrInstallStatus {
  const config = getAppConfig();
  const path = installStatusPath(config.storageDir);
  const logPath = installLogPath(config.logDir);
  let status: OcrInstallStatus = { state: "idle", logPath };
  if (existsSync(path)) {
    try {
      status = { ...status, ...(JSON.parse(readFileSync(path, "utf8")) as OcrInstallStatus) };
    } catch {
      status = { state: "failed", error: "OCR 安装状态文件读取失败", logPath };
    }
  }
  return { ...status, logPath, logTail: readLogTail(logPath) };
}

function readRuntimeInfo(readyMarker: string): OcrRuntimeInfo | null {
  if (!existsSync(readyMarker)) return null;
  try {
    return JSON.parse(readFileSync(readyMarker, "utf8")) as OcrRuntimeInfo;
  } catch {
    return null;
  }
}

function writeInstallStatus(status: OcrInstallStatus) {
  const config = getAppConfig();
  const path = installStatusPath(config.storageDir);
  const { logTail: _logTail, ...persisted } = status;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
}

function appendInstallLog(line: string) {
  const config = getAppConfig();
  const path = installLogPath(config.logDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, "utf8");
}

function appendChunk(stream: "stdout" | "stderr", chunk: Buffer | string) {
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    appendInstallLog(`${new Date().toISOString()} [${stream}] ${line}\n`);
  }
}

export function getOcrStatus() {
  const config = getAppConfig();
  let lastInstall = readInstallStatus();
  const readiness = runtimeReadiness();
  const readyMarker = readyMarkerPath(config.ocrPythonBin);
  const available = readiness.ready;
  const runtime = readRuntimeInfo(readyMarker);
  if (lastInstall.state === "failed" && lastInstall.exitCode === 0) {
    lastInstall = {
      ...lastInstall,
      state: "success",
      error: undefined,
      warning: available
        ? undefined
        : `安装脚本已成功退出，但服务端运行路径校验未完全通过：${readiness.missing.join("；")}`,
      runtimeReady: available,
      missing: readiness.missing
    };
    writeInstallStatus(lastInstall);
    appendInstallLog(`${new Date().toISOString()} [info] OCR runtime status repaired to success because setup process exited with code 0\n`);
  }
  return {
    available,
    installing,
    workerScript: config.ocrWorkerScript,
    pythonBin: config.ocrPythonBin,
    setupScript: config.ocrSetupScript,
    readyMarker,
    readiness,
    runtime,
    lastInstall,
    runner: getJobRunnerStatus()
  };
}

export function installOcrRuntime() {
  if (installing) return getOcrStatus();
  const config = getAppConfig();
  const startedAt = new Date().toISOString();
  const logPath = installLogPath(config.logDir);
  installing = true;
  writeInstallStatus({ state: "installing", startedAt, logPath });
  appendInstallLog(`${startedAt} [info] OCR runtime installation started\n`);
  const child = spawn("sh", [config.ocrSetupScript], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, STORAGE_DIR: config.storageDir }
  });

  child.stdout?.on("data", (chunk) => appendChunk("stdout", chunk));
  child.stderr?.on("data", (chunk) => appendChunk("stderr", chunk));
  let finalized = false;
  const finalize = (status: OcrInstallStatus, logLine: string) => {
    if (finalized) return;
    finalized = true;
    installing = false;
    writeInstallStatus(status);
    appendInstallLog(logLine);
  };

  child.once("close", (code, signal) => {
    const finishedAt = new Date().toISOString();
    const readiness = runtimeReadiness();
    const processSucceeded = code === 0;
    const warning =
      processSucceeded && !readiness.ready
        ? `安装脚本已成功退出，但服务端运行路径校验未完全通过：${readiness.missing.join("；")}`
        : undefined;
    const status: OcrInstallStatus = processSucceeded
      ? {
          state: "success",
          startedAt,
          finishedAt,
          exitCode: code,
          signal,
          warning,
          runtimeReady: readiness.ready,
          missing: readiness.missing,
          logPath
        }
      : {
          state: "failed",
          startedAt,
          finishedAt,
          exitCode: code,
          signal,
          runtimeReady: readiness.ready,
          missing: readiness.missing,
          error: `OCR 安装进程退出码 ${code ?? "unknown"}${signal ? `，信号 ${signal}` : ""}`,
          logPath
        };
    finalize(
      status,
      `${finishedAt} [info] OCR runtime installation ${processSucceeded ? "succeeded" : "failed"} with exit code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}\n`
    );
  });
  child.once("error", (error) => {
    const finishedAt = new Date().toISOString();
    finalize(
      { state: "failed", startedAt, finishedAt, exitCode: null, signal: null, error: error.message, logPath },
      `${finishedAt} [error] ${error.message}\n`
    );
  });
  return getOcrStatus();
}
