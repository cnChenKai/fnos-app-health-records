export type AiProviderKey = "deepseek" | "kimi" | "glm" | "qwen";

export type AiProviderOption = {
  label: string;
  defaultBaseUrl: string;
  defaultTextModel: string;
  defaultVisionModel: string;
};

export const aiProviderCatalog: Record<AiProviderKey, AiProviderOption> = {
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultTextModel: "deepseek-chat",
    defaultVisionModel: ""
  },
  kimi: {
    label: "Kimi",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultTextModel: "kimi-k3",
    defaultVisionModel: ""
  },
  glm: {
    label: "GLM",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    defaultTextModel: "glm-5.2",
    defaultVisionModel: ""
  },
  qwen: {
    label: "Qwen",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultTextModel: "qwen-plus",
    defaultVisionModel: ""
  }
};

export function normalizeAiProvider(value: unknown): AiProviderKey {
  return typeof value === "string" && value in aiProviderCatalog
    ? value as AiProviderKey
    : "deepseek";
}
