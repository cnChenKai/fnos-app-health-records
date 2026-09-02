import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import {
  isOcrRecognitionMode,
  normalizeOcrRecognitionMode,
  ocrRecognitionModeCatalog,
  ocrRecognitionModes,
  type OcrRecognitionMode
} from "../domain/ocr-recognition";
import { getAppConfig } from "../utils/runtime-config";

const settingKey = "ocr.recognition";

type StoredOcrRecognitionSettings = {
  mode?: unknown;
  apiTokenEncrypted?: unknown;
};

export type OcrRecognitionSettingsInput = {
  mode?: unknown;
  apiToken?: unknown;
  clearApiToken?: unknown;
};

export type OcrBatchSelectionInput = {
  ocrMode?: unknown;
  remoteProcessingAccepted?: unknown;
};

function keyPath() {
  return join(getAppConfig().storageDir, "secrets", "ocr-recognition.key");
}

function encryptionKey() {
  const path = keyPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  const key = readFileSync(path);
  if (key.byteLength !== 32) throw new Error("OCR recognition encryption key is invalid");
  return key;
}

function encrypt(value: string) {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decrypt(value: string) {
  if (!value) return "";
  const data = Buffer.from(value, "base64");
  if (data.byteLength < 29) throw new Error("OCR recognition encrypted token is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

function maskToken(token: string) {
  if (!token) return "";
  if (token.length <= 8) return "••••••••";
  return `${token.slice(0, 3)}••••${token.slice(-4)}`;
}

function readStoredSettings(): { mode: OcrRecognitionMode; apiToken: string } {
  const row = getDatabase().prepare(
    "SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?"
  ).get(settingKey) as { valueJson: string } | undefined;
  if (!row) return { mode: "local", apiToken: "" };
  try {
    const stored = JSON.parse(row.valueJson) as StoredOcrRecognitionSettings;
    const encrypted = typeof stored.apiTokenEncrypted === "string" ? stored.apiTokenEncrypted : "";
    return {
      mode: normalizeOcrRecognitionMode(stored.mode),
      apiToken: encrypted ? decrypt(encrypted) : ""
    };
  } catch {
    // A damaged setting must never expose a credential or silently enable remote processing.
    return { mode: "local", apiToken: "" };
  }
}

function modeSummary(mode: OcrRecognitionMode) {
  const definition = ocrRecognitionModeCatalog[mode];
  return {
    mode,
    label: definition.label,
    description: definition.description,
    externalProcessing: definition.externalProcessing,
    requiresApiToken: definition.requiresApiToken,
    requiresRemoteProcessingAcceptance: definition.requiresRemoteProcessingAcceptance,
    limits: { ...definition.limits }
  };
}

export function getOcrRecognitionModeSummary() {
  return modeSummary(readStoredSettings().mode);
}

type PublicOcrRecognitionSettings = ReturnType<typeof modeSummary> & {
  apiTokenConfigured: boolean;
  apiTokenMasked: string;
  modes: Array<ReturnType<typeof modeSummary>>;
};

type SecretOcrRecognitionSettings = PublicOcrRecognitionSettings & { apiToken: string };

export function getOcrRecognitionSettings(includeSecret: true): SecretOcrRecognitionSettings;
export function getOcrRecognitionSettings(includeSecret?: false): PublicOcrRecognitionSettings;
export function getOcrRecognitionSettings(includeSecret = false): PublicOcrRecognitionSettings | SecretOcrRecognitionSettings {
  const stored = readStoredSettings();
  const publicSettings = {
    ...modeSummary(stored.mode),
    apiTokenConfigured: Boolean(stored.apiToken),
    apiTokenMasked: maskToken(stored.apiToken),
    modes: ocrRecognitionModes.map((mode) => modeSummary(mode))
  };
  return includeSecret ? { ...publicSettings, apiToken: stored.apiToken } : publicSettings;
}

export function saveOcrRecognitionSettings(input: OcrRecognitionSettingsInput) {
  if (!isOcrRecognitionMode(input.mode)) {
    throw createError({ statusCode: 400, statusMessage: "OCR 识别方式无效" });
  }
  const current = readStoredSettings();
  if (input.apiToken !== undefined && typeof input.apiToken !== "string") {
    throw createError({ statusCode: 400, statusMessage: "MinerU API Token 格式无效" });
  }
  const submittedToken = typeof input.apiToken === "string" ? input.apiToken.trim() : "";
  if (submittedToken.length > 4096 || /[\r\n\0]/.test(submittedToken)) {
    throw createError({ statusCode: 400, statusMessage: "MinerU API Token 格式无效" });
  }
  const apiToken = input.clearApiToken === true ? "" : submittedToken || current.apiToken;
  if (input.mode === "mineru_precise" && !apiToken) {
    throw createError({ statusCode: 400, statusMessage: "精准解析需要先配置 MinerU API Token" });
  }
  const stored = {
    mode: input.mode,
    ...(apiToken ? { apiTokenEncrypted: encrypt(apiToken) } : {})
  };
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json) VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(settingKey, JSON.stringify(stored));
  return getOcrRecognitionSettings(false);
}

function parseAccepted(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function validateOcrBatchSelection(input: OcrBatchSelectionInput = {}) {
  const current = readStoredSettings();
  const observedMode = input.ocrMode === undefined || input.ocrMode === null || input.ocrMode === ""
    ? "local"
    : input.ocrMode;
  if (!isOcrRecognitionMode(observedMode)) {
    throw createError({ statusCode: 400, statusMessage: "OCR 识别方式无效，请刷新页面后重试" });
  }
  if (observedMode !== current.mode) {
    throw createError({
      statusCode: 409,
      statusMessage: "管理员已更新 OCR 识别方式，请刷新页面并重新确认数据处理方式"
    });
  }
  const remoteProcessingAccepted = parseAccepted(input.remoteProcessingAccepted);
  if (ocrRecognitionModeCatalog[current.mode].externalProcessing && !remoteProcessingAccepted) {
    throw createError({
      statusCode: 400,
      statusMessage: "使用 MinerU 前需要确认完整页面副本将发送至外部服务"
    });
  }
  if (current.mode === "mineru_precise" && !current.apiToken) {
    throw createError({ statusCode: 409, statusMessage: "MinerU 精准解析 Token 尚未配置" });
  }
  return { ocrMode: current.mode, remoteProcessingAccepted };
}
