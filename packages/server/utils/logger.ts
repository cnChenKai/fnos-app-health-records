import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAppConfig } from "./runtime-config";

export type LogLevel = "info" | "warn" | "error";

export type LogRotationPolicy = {
  filePath: string;
  maxFileBytes: number;
  maxArchiveFiles: number;
  maxTotalBytes: number;
};

let fileOperationQueue = Promise.resolve();

const secretFieldNames = new Set([
  "apikey",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "cookie",
  "setcookie"
]);

const privateContentFieldNames = new Set([
  "ocrtext",
  "fulltext",
  "reporttext",
  "reporttitle",
  "filename",
  "originalname",
  "patientname",
  "membername",
  "displayname",
  "idcard",
  "identitycard",
  "phone",
  "mobile",
  "telephone",
  "address",
  "homeaddress",
  "diagnosis",
  "conclusion",
  "prompt",
  "messages",
  "requestbody",
  "responsebody",
  "imagebase64",
  "filebuffer",
  "binary",
  "rawcontent"
]);

function normalizedFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function redactLogText(value: unknown) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [已隐藏]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[密钥已隐藏]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie)\s*[:=]\s*)(["']?)[^"',;\s}]+/gi, "$1$2[已隐藏]")
    .replace(/\b1\d{10}\b/g, "[手机号已隐藏]")
    .replace(/\b\d{17}[\dXx]\b/g, "[证件号已隐藏]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[邮箱已隐藏]")
    .replace(/(?:\/Users|\/home|\/var|\/volume\d*)\/[^\s:]+/g, "[路径]");
}

export function redactLogValue(value: unknown, fieldName = "", depth = 0, seen = new WeakSet<object>()): unknown {
  const normalizedName = normalizedFieldName(fieldName);
  if (secretFieldNames.has(normalizedName)) return "[已隐藏]";
  if (privateContentFieldNames.has(normalizedName)) return "[内容已省略]";
  if (typeof value === "string") return redactLogText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") {
    return value;
  }
  if (depth >= 8) return "[内容过深，已省略]";
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, fieldName, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[循环引用，已省略]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactLogValue(item, key, depth + 1, seen);
    }
    seen.delete(value);
    return result;
  }
  return redactLogText(value);
}

function enqueueFileOperation<T>(operation: () => Promise<T>) {
  const result = fileOperationQueue.then(operation, operation);
  fileOperationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function getLogRotationPolicy(): LogRotationPolicy {
  const config = getAppConfig();
  return {
    filePath: join(config.logDir, "app.log"),
    maxFileBytes: config.logMaxBytes,
    maxArchiveFiles: config.logMaxFiles,
    maxTotalBytes: config.logMaxBytes * (config.logMaxFiles + 1)
  };
}

async function rotateIfNeeded(policy: LogRotationPolicy, incomingBytes: number) {
  let currentBytes = 0;
  try {
    currentBytes = (await stat(policy.filePath)).size;
  } catch {
    return;
  }
  if (currentBytes + incomingBytes <= policy.maxFileBytes) return;

  await rm(`${policy.filePath}.${policy.maxArchiveFiles}`, { force: true });
  for (let index = policy.maxArchiveFiles - 1; index >= 1; index -= 1) {
    try {
      await rename(`${policy.filePath}.${index}`, `${policy.filePath}.${index + 1}`);
    } catch {
      // Missing archive slots are expected.
    }
  }
  try {
    await rename(policy.filePath, `${policy.filePath}.1`);
  } catch {
    // Another process may have already moved an empty current file.
  }

  const entries = await readdir(dirname(policy.filePath), { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^app\.log\.\d+$/.test(entry.name))
    .filter((entry) => Number(entry.name.slice("app.log.".length)) > policy.maxArchiveFiles)
    .map((entry) => rm(join(dirname(policy.filePath), entry.name), { force: true })));
}

export async function writeLog(level: LogLevel, message: string, extra?: Record<string, unknown>) {
  const record = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    level,
    message: redactLogText(message),
    extra: redactLogValue(extra || {}) as Record<string, unknown>
  };

  await enqueueFileOperation(async () => {
    try {
      const policy = getLogRotationPolicy();
      let line = JSON.stringify(record);
      const originalBytes = Buffer.byteLength(line, "utf8") + 1;
      if (originalBytes > policy.maxFileBytes) {
        line = JSON.stringify({
          ...record,
          extra: { truncated: true, originalBytes }
        });
      }
      await mkdir(dirname(policy.filePath), { recursive: true });
      await rotateIfNeeded(policy, Buffer.byteLength(line, "utf8") + 1);
      await appendFile(policy.filePath, `${line}\n`, "utf8");
    } catch {
      // Logging failures must not take down the application request path.
    }
  });
}

export async function clearSystemLogFiles() {
  return enqueueFileOperation(async () => {
    const policy = getLogRotationPolicy();
    await mkdir(dirname(policy.filePath), { recursive: true });
    const entries = await readdir(dirname(policy.filePath), { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && (entry.name === "app.log" || /^app\.log\.\d+$/.test(entry.name)))
      .map((entry) => join(dirname(policy.filePath), entry.name));
    const sizes = await Promise.all(files.map(async (filePath) => {
      try {
        return (await stat(filePath)).size;
      } catch {
        return 0;
      }
    }));
    await Promise.all(files.map((filePath) => rm(filePath, { force: true })));
    return {
      deletedFiles: files.length,
      freedBytes: sizes.reduce((sum, value) => sum + value, 0)
    };
  });
}
