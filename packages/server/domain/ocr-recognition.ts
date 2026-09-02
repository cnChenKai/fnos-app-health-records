export const ocrRecognitionModes = ["local", "mineru_agent", "mineru_precise"] as const;

export type OcrRecognitionMode = typeof ocrRecognitionModes[number];

export type OcrRecognitionModeDefinition = {
  mode: OcrRecognitionMode;
  label: string;
  description: string;
  externalProcessing: boolean;
  requiresApiToken: boolean;
  requiresRemoteProcessingAcceptance: boolean;
  limits: {
    maxFileBytes: number | null;
    maxFileMegabytes: number | null;
    maxPages: number | null;
  };
};

export const ocrRecognitionModeCatalog: Record<OcrRecognitionMode, OcrRecognitionModeDefinition> = {
  local: {
    mode: "local",
    label: "本地 OCR",
    description: "报告页面仅在当前设备内识别，不会发送给外部服务。",
    externalProcessing: false,
    requiresApiToken: false,
    requiresRemoteProcessingAcceptance: false,
    limits: { maxFileBytes: null, maxFileMegabytes: null, maxPages: null }
  },
  mineru_agent: {
    mode: "mineru_agent",
    label: "MinerU Agent 轻量解析",
    description: "无需密钥，受 MinerU 的 IP 频率和单文件限额约束。",
    externalProcessing: true,
    requiresApiToken: false,
    requiresRemoteProcessingAcceptance: true,
    limits: { maxFileBytes: 10 * 1024 * 1024, maxFileMegabytes: 10, maxPages: 20 }
  },
  mineru_precise: {
    mode: "mineru_precise",
    label: "MinerU 精准解析",
    description: "使用管理员配置的 MinerU API Token 和固定 VLM 模型。",
    externalProcessing: true,
    requiresApiToken: true,
    requiresRemoteProcessingAcceptance: true,
    limits: { maxFileBytes: 200 * 1024 * 1024, maxFileMegabytes: 200, maxPages: 200 }
  }
};

export function isOcrRecognitionMode(value: unknown): value is OcrRecognitionMode {
  return typeof value === "string" && (ocrRecognitionModes as readonly string[]).includes(value);
}

export function normalizeOcrRecognitionMode(value: unknown): OcrRecognitionMode {
  return isOcrRecognitionMode(value) ? value : "local";
}
