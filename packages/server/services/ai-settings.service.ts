import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import { writeLog } from "../utils/logger";
import { getAppConfig } from "../utils/runtime-config";
import { aiProviderCatalog, normalizeAiProvider, type AiProviderKey } from "./ai-provider";

const settingKey = "ai.provider";

export type AiSettings = {
  enabled: boolean;
  provider: AiProviderKey;
  visionEnabled: boolean;
  baseUrl: string;
  textModel: string;
  visionModel: string;
  apiKey: string;
};

type ProviderSettings = Omit<AiSettings, "enabled" | "provider">;
type StoredProviderSettings = Omit<ProviderSettings, "apiKey"> & {
  apiKey?: string;
  apiKeyEncrypted?: string;
};
type StoredAiSettings = Partial<StoredProviderSettings> & {
  enabled?: boolean;
  provider?: string;
  providers?: Partial<Record<AiProviderKey, StoredProviderSettings>>;
};
type ParsedAiSettings = {
  enabled: boolean;
  provider: AiProviderKey;
  providers: Partial<Record<AiProviderKey, ProviderSettings>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function keyPath() {
  return join(getAppConfig().storageDir, "secrets", "ai-settings.key");
}

function encryptionKey() {
  const path = keyPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32), { mode: 0o600 });
  }
  return readFileSync(path);
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
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

function providerDefaults(provider: AiProviderKey): ProviderSettings {
  const defaults = aiProviderCatalog[provider];
  return {
    visionEnabled: false,
    baseUrl: defaults.defaultBaseUrl,
    textModel: defaults.defaultTextModel,
    visionModel: defaults.defaultVisionModel,
    apiKey: ""
  };
}

function parseProviderSettings(value: StoredProviderSettings | undefined): Partial<ProviderSettings> | undefined {
  if (!value) return undefined;
  const parsed: Partial<ProviderSettings> = {};
  if (typeof value.visionEnabled === "boolean") parsed.visionEnabled = value.visionEnabled;
  if (typeof value.baseUrl === "string") parsed.baseUrl = value.baseUrl;
  if (typeof value.textModel === "string") parsed.textModel = value.textModel;
  if (typeof value.visionModel === "string") parsed.visionModel = value.visionModel;
  if (typeof value.apiKeyEncrypted === "string") parsed.apiKey = decrypt(value.apiKeyEncrypted);
  else if (typeof value.apiKey === "string") parsed.apiKey = value.apiKey;
  return parsed;
}

function parseStoredSettings(): ParsedAiSettings {
  const row = getDatabase().prepare("SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?")
    .get(settingKey) as { valueJson: string } | undefined;
  if (!row) return { enabled: false, provider: "deepseek", providers: {} };

  try {
    const stored = JSON.parse(row.valueJson) as StoredAiSettings;
    const provider = normalizeAiProvider(stored.provider);
    const providers: ParsedAiSettings["providers"] = {};
    if (isRecord(stored.providers)) {
      for (const key of Object.keys(aiProviderCatalog) as AiProviderKey[]) {
        const raw = stored.providers[key];
        if (isRecord(raw)) providers[key] = parseProviderSettings(raw as StoredProviderSettings) as ProviderSettings;
      }
    }

    // The original release stored one flat provider configuration. Merge it into
    // the selected provider so upgrading never discards its models or API key.
    const hasLegacySettings = Boolean(
      stored.baseUrl || stored.textModel || stored.visionModel || stored.apiKey || stored.apiKeyEncrypted
    );
    if (hasLegacySettings) {
      const legacy = parseProviderSettings(stored as StoredProviderSettings);
      providers[provider] = {
        ...legacy,
        ...providers[provider],
        apiKey: providers[provider]?.apiKey ?? legacy?.apiKey ?? ""
      } as ProviderSettings;
    }
    return { enabled: stored.enabled === true, provider, providers };
  } catch {
    return { enabled: false, provider: "deepseek", providers: {} };
  }
}

function resolveProvider(provider: AiProviderKey, parsed: ParsedAiSettings): ProviderSettings {
  return { ...providerDefaults(provider), ...parsed.providers[provider] };
}

function normalizeBaseUrl(value: unknown, fallback: string) {
  const baseUrl = String(value || fallback).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw createError({ statusCode: 400, statusMessage: "AI API 地址无效" });
  }
}

function maskApiKey(apiKey: string) {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "••••••••";
  return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`;
}

function serializeSettings(parsed: ParsedAiSettings) {
  const providers: Partial<Record<AiProviderKey, StoredProviderSettings>> = {};
  for (const key of Object.keys(aiProviderCatalog) as AiProviderKey[]) {
    const value = parsed.providers[key];
    if (!value) continue;
    providers[key] = {
      visionEnabled: value.visionEnabled === true,
      baseUrl: value.baseUrl,
      textModel: value.textModel,
      visionModel: value.visionModel,
      apiKeyEncrypted: encrypt(value.apiKey)
    };
  }
  return { enabled: parsed.enabled, provider: parsed.provider, providers };
}

function publicSettings(parsed: ParsedAiSettings) {
  const active = resolveProvider(parsed.provider, parsed);
  const providerSettings = Object.fromEntries(
    (Object.keys(aiProviderCatalog) as AiProviderKey[]).map((key) => {
      const value = resolveProvider(key, parsed);
      return [key, {
        visionEnabled: value.visionEnabled,
        baseUrl: value.baseUrl,
        textModel: value.textModel,
        visionModel: value.visionModel,
        apiKeyConfigured: Boolean(value.apiKey),
        apiKeyMasked: maskApiKey(value.apiKey)
      }];
    })
  );
  return {
    enabled: parsed.enabled,
    provider: parsed.provider,
    visionEnabled: active.visionEnabled,
    baseUrl: active.baseUrl,
    textModel: active.textModel,
    visionModel: active.visionModel,
    apiKey: "",
    apiKeyConfigured: Boolean(active.apiKey),
    apiKeyMasked: maskApiKey(active.apiKey),
    providerSettings,
    providers: Object.entries(aiProviderCatalog).map(([key, value]) => ({ key, ...value }))
  };
}

export function getAiSettings(includeSecret = false) {
  const parsed = parseStoredSettings();
  const active = resolveProvider(parsed.provider, parsed);
  return {
    ...publicSettings(parsed),
    apiKey: includeSecret ? active.apiKey : ""
  };
}

export function saveAiSettings(input: Partial<AiSettings> & { clearApiKey?: boolean }) {
  const parsed = parseStoredSettings();
  const provider = normalizeAiProvider(input.provider || parsed.provider);
  const current = resolveProvider(provider, parsed);
  const submittedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = input.clearApiKey === true ? "" : submittedKey || current.apiKey;
  const next: ParsedAiSettings = {
    enabled: input.enabled === undefined ? parsed.enabled : input.enabled === true,
    provider,
    providers: {
      ...parsed.providers,
      [provider]: {
        visionEnabled: input.visionEnabled === undefined ? current.visionEnabled : input.visionEnabled === true,
        baseUrl: normalizeBaseUrl(input.baseUrl, current.baseUrl),
        textModel: String(input.textModel || current.textModel).trim(),
        visionModel: String(input.visionModel ?? current.visionModel).trim(),
        apiKey
      }
    }
  };
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json) VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(settingKey, JSON.stringify(serializeSettings(next)));
  return publicSettings(next);
}

export async function testAiConnection(input: Partial<AiSettings> = {}) {
  const parsed = parseStoredSettings();
  const provider = normalizeAiProvider(input.provider || parsed.provider);
  const current = resolveProvider(provider, parsed);
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : current.apiKey;
  const textModel = String(input.textModel || current.textModel).trim();
  if (!apiKey || !textModel) {
    throw createError({
      statusCode: 400,
      statusMessage: `请先配置 ${aiProviderCatalog[provider].label} API Key 和文本模型`
    });
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl, current.baseUrl);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: textModel, messages: [{ role: "user", content: "reply ok" }], max_tokens: 4 }),
      signal: AbortSignal.timeout(15000)
    });
  } catch (cause) {
    const error = cause as Error & { code?: string; cause?: { code?: string; message?: string } };
    const code = error.code || error.cause?.code || "";
    const detail = [code, error.message, error.cause?.message].filter(Boolean).join(" · ");
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError"
      || /TIMEOUT|TIMEDOUT/i.test(`${code} ${detail}`);
    const dnsFailed = /ENOTFOUND|EAI_AGAIN/i.test(`${code} ${detail}`);
    const tlsFailed = /CERT|TLS|SSL|SELF_SIGNED/i.test(`${code} ${detail}`);
    await writeLog("warn", "ai-connection-test-failed", {
      provider,
      host: new URL(baseUrl).host,
      model: textModel,
      errorCode: code,
      detail: detail.slice(0, 600)
    });
    const statusMessage = timedOut
      ? "连接 AI 服务超时，请检查 NAS 外网连接、代理或服务地址"
      : dnsFailed
        ? "NAS 无法解析 AI 服务域名，请检查 DNS 和外网连接"
        : tlsFailed
          ? "AI 服务 TLS 证书校验失败，请检查 NAS 时间、证书或代理设置"
          : "NAS 无法连接 AI 服务，请检查外网连接、代理、DNS 和 API 地址";
    throw createError({ statusCode: timedOut ? 504 : 502, statusMessage });
  }
  if (!response.ok) {
    let upstreamDetail = "";
    try {
      const text = (await response.text()).trim();
      if (text) {
        try {
          const payload = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
          upstreamDetail = String(
            typeof payload.error === "object" ? payload.error?.message || "" : payload.error || payload.message || ""
          ).trim();
        } catch {
          upstreamDetail = text;
        }
      }
    } catch {
      // The upstream status is still enough to provide an actionable error.
    }
    await writeLog("warn", "ai-connection-test-rejected", {
      provider,
      host: new URL(baseUrl).host,
      model: textModel,
      upstreamStatus: response.status,
      detail: upstreamDetail.slice(0, 600)
    });
    const summary = response.status === 401 || response.status === 403
      ? "AI 服务认证失败，请检查 API Key 和账号权限"
      : response.status === 404
        ? "AI API 地址或文本模型不存在"
        : response.status === 429
          ? "AI 服务请求受限，请检查调用频率、额度或余额"
          : response.status >= 500
            ? "AI 服务暂时不可用"
            : "AI 服务拒绝了测试请求，请检查模型名称和接口兼容性";
    const suffix = upstreamDetail ? `：${upstreamDetail.slice(0, 240)}` : "";
    throw createError({
      statusCode: 502,
      statusMessage: `${summary}（上游 ${response.status}）${suffix}`
    });
  }
  return { ok: true, provider, model: textModel, elapsedMs: Date.now() - started };
}
