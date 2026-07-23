import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { getAppConfig } from "../utils/runtime-config";
import { getJobRunnerStatus } from "./job-runner.service";

let installing = false;

export function getOcrStatus() {
  const config = getAppConfig();
  return {
    available: existsSync(config.ocrPythonBin) && existsSync(config.ocrWorkerScript),
    installing,
    workerScript: config.ocrWorkerScript,
    runner: getJobRunnerStatus()
  };
}

export function installOcrRuntime() {
  if (installing) return getOcrStatus();
  const config = getAppConfig();
  installing = true;
  const child = spawn("sh", [config.ocrSetupScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, STORAGE_DIR: config.storageDir }
  });
  child.once("exit", () => { installing = false; });
  child.once("error", () => { installing = false; });
  child.unref();
  return getOcrStatus();
}
