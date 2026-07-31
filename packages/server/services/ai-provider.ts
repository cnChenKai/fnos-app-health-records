export type AiProviderKey = "deepseek" | "kimi" | "glm" | "qwen" | "openai" | "doubao";

export type AiProviderOption = {
  label: string;
  defaultBaseUrl: string;
  defaultTextModel: string;
  defaultVisionModel: string;
  defaultMaxOutputTokens: number;
  modelHint?: string;
};

export const aiProviderCatalog: Record<AiProviderKey, AiProviderOption> = {
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultTextModel: "deepseek-v4-flash",
    defaultVisionModel: "",
    defaultMaxOutputTokens: 8_192
  },
  kimi: {
    label: "Kimi",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultTextModel: "kimi-k3",
    defaultVisionModel: "",
    defaultMaxOutputTokens: 65_536
  },
  glm: {
    label: "GLM",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    defaultTextModel: "glm-5.2",
    defaultVisionModel: "",
    defaultMaxOutputTokens: 384_000
  },
  qwen: {
    label: "Qwen",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultTextModel: "qwen-plus",
    defaultVisionModel: "",
    defaultMaxOutputTokens: 32_768
  },
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultTextModel: "gpt-4.1-mini",
    defaultVisionModel: "gpt-4.1-mini",
    defaultMaxOutputTokens: 32_768
  },
  doubao: {
    label: "豆包",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultTextModel: "doubao-seed-1-6-250615",
    defaultVisionModel: "doubao-seed-1-6-vision-250815",
    defaultMaxOutputTokens: 32_768,
    modelHint: "火山方舟如要求使用推理接入点，请填写控制台中的 ep-... 接入点 ID"
  }
};

export function normalizeAiProvider(value: unknown): AiProviderKey {
  return typeof value === "string" && value in aiProviderCatalog
    ? value as AiProviderKey
    : "deepseek";
}

export function resolveAiMaxOutputTokens(provider: AiProviderKey) {
  const configured = Number(process.env.AI_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1_024, Math.min(384_000, Math.floor(configured)));
  }
  return aiProviderCatalog[provider].defaultMaxOutputTokens;
}

export function resolveAiTemperature(
  provider: AiProviderKey,
  model: string,
  requestedTemperature = 0
) {
  // Kimi's OpenAI-compatible endpoint currently accepts temperature=1 only.
  if (provider === "kimi" || /^kimi-/i.test(model.trim())) return 1;
  return Number.isFinite(requestedTemperature) ? requestedTemperature : 0;
}
