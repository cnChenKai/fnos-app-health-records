import templateConfig from "../../../template.config.json" with { type: "json" };
import packageJson from "../../../package.json" with { type: "json" };
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type AppRuntimeConfig = {
  appName: string;
  appTitle: string;
  appVersion: string;
  accessMode: "gateway" | "port";
  gatewayPrefix: string;
  appPort: number | null;
  logLevel: string;
  logDir: string;
  storageDir: string;
  servicePort: number;
  ocrPythonBin: string;
  ocrWorkerScript: string;
  ocrSetupScript: string;
};

type PersistedRuntimeConfig = {
  servicePort?: number;
  directPort?: number;
};

function persistedConfig(storageDir: string): PersistedRuntimeConfig {
  const path = join(storageDir, "config", "runtime.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PersistedRuntimeConfig;
  } catch {
    return {};
  }
}

export function getAppConfig(): AppRuntimeConfig {
  const appName = process.env.APP_NAME || templateConfig.appName;
  const isDevelopment = process.env.NODE_ENV === "development" || Boolean(process.env.VITE_DEV_SERVER_URL);
  const developmentDataDir = resolve(process.cwd(), ".data");
  const productionDataDir = process.env.TRIM_PKGVAR
    ? resolve(process.env.TRIM_PKGVAR, "data")
    : `/var/apps/${appName}/var/data`;
  const storageDir = process.env.STORAGE_DIR || (isDevelopment ? developmentDataDir : productionDataDir);
  const stored = persistedConfig(storageDir);
  const applicationDir = process.env.TRIM_APPDEST || process.cwd();
  const ocrRoot = isDevelopment ? resolve(process.cwd(), "packages", "ocr-worker") : resolve(applicationDir, "ocr-worker");

  return {
    appName,
    appTitle: process.env.APP_TITLE || templateConfig.appTitle,
    appVersion: process.env.APP_VERSION || packageJson.version,
    accessMode: process.env.FNOS_SOCKET_PATH ? "gateway" : "port",
    gatewayPrefix: process.env.GATEWAY_PREFIX || templateConfig.gatewayPrefix,
    appPort: process.env.FNOS_SOCKET_PATH
      ? null
      : Number(process.env.NITRO_PORT || process.env.PORT || templateConfig.localDevPort),
    logLevel: process.env.LOG_LEVEL || templateConfig.logLevel,
    logDir: process.env.LOG_DIR || (isDevelopment ? join(developmentDataDir, "logs") : `/var/apps/${appName}/var/log`),
    storageDir,
    servicePort: Number(process.env.SERVICE_PORT || stored.servicePort || stored.directPort || templateConfig.localDevPort),
    ocrPythonBin: process.env.OCR_PYTHON_BIN || join(storageDir, "ocr-venv", "bin", "python"),
    ocrWorkerScript: process.env.OCR_WORKER_SCRIPT || join(ocrRoot, "worker.py"),
    ocrSetupScript: process.env.OCR_SETUP_SCRIPT || join(ocrRoot, "setup-runtime.sh")
  };
}
