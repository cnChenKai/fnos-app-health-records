<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";
import { CheckCircle2, Cloud, Cpu, Database, Download, KeyRound, LoaderCircle, Save, ShieldAlert } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { request } from "../../utils/api";
import { useAppContext } from "../../composables/useAppContext";
import type { OcrRecognitionSettings } from "../../types/api";

type OcrStatus = {
  available: boolean;
  installing: boolean;
  runtime?: {
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
  } | null;
  lastInstall?: {
    state: "idle" | "installing" | "success" | "failed";
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number | null;
    error?: string;
    warning?: string;
    runtimeReady?: boolean;
    missing?: string[];
    logPath?: string;
    logTail?: string[];
  };
  runner: { started: boolean; busy: boolean; queued: number; processing: number; failed: number };
};
type DatabaseStatus = {
  driver: string;
  path: string;
  integrity: string;
  schemaVersion: number;
  appliedSchemaVersion: number;
  journalMode: string;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  usedPageCount: number;
  databaseSizeBytes: number;
  walSizeBytes: number;
  shmSizeBytes: number;
  totalSizeBytes: number;
  rowCounts: Record<string, number>;
};
type SystemSummary = {
  servicePort: number;
  database: DatabaseStatus;
  storage: {
    storageDir: string;
    databaseBytes: number;
    reportsBytes: number;
    thumbnailsBytes: number;
    backupsBytes: number;
    logsBytes: number;
    modelsBytes: number;
    totalKnownBytes: number;
  };
};
type PipMirrorKey = "official" | "tsinghua" | "aliyun" | "tencent" | "huaweicloud" | "custom";
type OcrInstallSettings = {
  pipMirror: PipMirrorKey;
  customPipIndexUrl: string;
  resolvedPipIndexUrl: string;
  mirrors: Array<{ key: PipMirrorKey; label: string; indexUrl: string; description: string }>;
};

const app = useAppContext();
const system = ref<SystemSummary | null>(null);
const ocr = ref<OcrStatus | null>(null);
const ocrSettings = ref<OcrInstallSettings>({
  pipMirror: "tsinghua",
  customPipIndexUrl: "",
  resolvedPipIndexUrl: "",
  mirrors: []
});
const recognitionSettings = ref<OcrRecognitionSettings>({
  mode: "local",
  label: "本地 OCR",
  description: "报告页面仅在当前设备内识别，不会发送给外部服务。",
  externalProcessing: false,
  requiresApiToken: false,
  requiresRemoteProcessingAcceptance: false,
  limits: { maxFileBytes: null, maxFileMegabytes: null, maxPages: null },
  apiTokenConfigured: false,
  apiTokenMasked: "",
  modes: []
});
const recognitionToken = ref("");
const clearRecognitionToken = ref(false);
const runtimeMessage = ref("");
const savingOcrSettings = ref(false);
const savingRecognitionSettings = ref(false);
let statusTimer: ReturnType<typeof setInterval> | null = null;
const databaseSummaryRows = computed(() => [
  { label: "报告", value: system.value?.database?.rowCounts?.reports || 0 },
  { label: "页面", value: system.value?.database?.rowCounts?.report_pages || 0 },
  { label: "任务", value: system.value?.database?.rowCounts?.processing_jobs || 0 },
  { label: "日志", value: system.value?.database?.rowCounts?.processing_job_events || 0 }
]);
const ocrRuntimeRows = computed(() => {
  const runtime = ocr.value?.runtime;
  const rows = [
    { label: "Python", value: runtime?.pythonVersion || "—" },
    { label: "识别后端", value: runtime?.engine || runtime?.backend || (ocr.value?.available ? "已安装" : "—") },
    { label: "识别模型", value: runtime?.modelVersion || "—" },
    { label: "RapidOCR", value: runtime?.rapidocrVersion && runtime.rapidocrVersion !== "unknown" ? runtime.rapidocrVersion : "已安装" },
    { label: "PyMuPDF", value: runtime?.pymupdfVersion || "—" },
    { label: "Pillow", value: runtime?.pillowVersion || "—" },
    { label: "HEIF", value: runtime?.pillowHeifVersion || "—" },
    { label: "平台", value: runtime?.machine ? `${runtime.platform || "—"} · ${runtime.machine}` : runtime?.platform || "—" }
  ];
  return rows.filter((row) => row.value !== "—" || !ocr.value?.available);
});
const selectedPipIndexUrl = computed(() => {
  if (ocrSettings.value.pipMirror === "custom") return ocrSettings.value.customPipIndexUrl.trim();
  return ocrSettings.value.mirrors.find((mirror) => mirror.key === ocrSettings.value.pipMirror)?.indexUrl || "";
});
const selectedRecognitionMode = computed(() =>
  recognitionSettings.value.modes.find((item) => item.mode === recognitionSettings.value.mode)
  || recognitionSettings.value
);

function logLineClass(line: string) {
  const lower = line.toLowerCase();
  if (/error|failed|失败|错误/.test(lower)) return "log-line log-line--error";
  if (/warn|警告|注意/.test(lower)) return "log-line log-line--warn";
  return "log-line";
}

function formatBytes(value?: number | null) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function integrityLabel(value?: string | null) {
  if (!value) return "检查中";
  return value === "ok" ? "正常" : value;
}
function stopStatusPolling() {
  if (!statusTimer) return;
  clearInterval(statusTimer);
  statusTimer = null;
}
function startStatusPolling() {
  if (statusTimer) return;
  statusTimer = setInterval(() => { void refreshOcr(); }, 3000);
}
function syncStatusPolling() {
  if (ocr.value?.installing) startStatusPolling();
  else stopStatusPolling();
}

let statusPollFailures = 0;
async function refreshOcr() {
  try {
    ocr.value = await request<OcrStatus>("ocr/status");
    statusPollFailures = 0;
    syncStatusPolling();
  } catch (error) {
    statusPollFailures += 1;
    /* 安装长达数分钟，允许偶发轮询失败；连续多次失败才停轮询并提示，避免界面卡在“正在安装” */
    if (statusPollFailures >= 5) {
      runtimeMessage.value = `OCR 状态刷新中断：${error instanceof Error ? error.message : "无法获取 OCR 状态"}。请刷新页面查看最新状态`;
      stopStatusPolling();
    }
  }
}
async function installOcr() {
  runtimeMessage.value = "";
  try {
    ocr.value = await request<OcrStatus>("ocr/install", { method: "POST" });
    runtimeMessage.value = "OCR 环境正在后台安装，完成后队列会自动开始处理";
    syncStatusPolling();
  } catch (error) {
    runtimeMessage.value = error instanceof Error ? error.message : "OCR 环境安装启动失败";
    stopStatusPolling();
  }
}
async function saveOcrSettings() {
  savingOcrSettings.value = true;
  runtimeMessage.value = "";
  try {
    ocrSettings.value = await request<OcrInstallSettings>("ocr/settings", {
      method: "PUT",
      body: JSON.stringify({
        pipMirror: ocrSettings.value.pipMirror,
        customPipIndexUrl: ocrSettings.value.customPipIndexUrl
      })
    });
    runtimeMessage.value = "Python 依赖镜像源已保存，下次安装或重装 OCR 环境时生效";
  } catch (error) {
    runtimeMessage.value = error instanceof Error ? error.message : "保存镜像源失败";
  } finally {
    savingOcrSettings.value = false;
  }
}
async function saveRecognitionSettings() {
  savingRecognitionSettings.value = true;
  runtimeMessage.value = "";
  try {
    recognitionSettings.value = await request<OcrRecognitionSettings>("ocr/recognition-settings", {
      method: "PUT",
      body: JSON.stringify({
        mode: recognitionSettings.value.mode,
        apiToken: recognitionToken.value,
        clearApiToken: clearRecognitionToken.value
      })
    });
    recognitionToken.value = "";
    clearRecognitionToken.value = false;
    runtimeMessage.value = "OCR 识别方式已保存，只影响之后新建的处理批次";
  } catch (error) {
    runtimeMessage.value = error instanceof Error ? error.message : "保存 OCR 识别方式失败";
  } finally {
    savingRecognitionSettings.value = false;
  }
}
onMounted(async () => {
  const [systemResult, ocrResult, ocrSettingsResult, recognitionResult] = await Promise.allSettled([
    request<SystemSummary>("system"),
    request<OcrStatus>("ocr/status"),
    request<OcrInstallSettings>("ocr/settings"),
    request<OcrRecognitionSettings>("ocr/recognition-settings")
  ]);
  if (systemResult.status === "fulfilled") system.value = systemResult.value;
  if (ocrResult.status === "fulfilled") ocr.value = ocrResult.value;
  if (ocrSettingsResult.status === "fulfilled") ocrSettings.value = ocrSettingsResult.value;
  if (recognitionResult.status === "fulfilled") recognitionSettings.value = recognitionResult.value;
  const failedParts = [
    systemResult.status === "rejected" ? "系统信息" : "",
    ocrResult.status === "rejected" ? "OCR 状态" : "",
    ocrSettingsResult.status === "rejected" ? "镜像源设置" : "",
    recognitionResult.status === "rejected" ? "识别方式设置" : ""
  ].filter(Boolean);
  if (failedParts.length) {
    runtimeMessage.value = `${failedParts.join("、")}加载失败，请稍后刷新页面重试`;
  }
  syncStatusPolling();
});
onBeforeUnmount(stopStatusPolling);
/* KeepAlive 缓存期间暂停 OCR 安装状态轮询，回到页面时若仍在安装则恢复 */
onDeactivated(stopStatusPolling);
onActivated(syncStatusPolling);
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="运行与识别" description="选择新批次的文字识别方式，并管理本地页面预处理环境" />
    <section class="settings-band">
      <header>
        <Cloud :size="21" />
        <div><h3>文字识别方式</h3><p>设置只影响保存后新建的上传、导入和重新识别批次</p></div>
      </header>
      <section class="runtime-detail">
        <div class="settings-form">
          <label>
            <span>新批次默认方式</span>
            <select v-model="recognitionSettings.mode">
              <option v-for="mode in recognitionSettings.modes" :key="mode.mode" :value="mode.mode">
                {{ mode.label }}
              </option>
            </select>
          </label>
          <div v-if="selectedRecognitionMode.externalProcessing" class="runtime-warning compact">
            <ShieldAlert :size="18" />
            <div>
              <strong>会向 MinerU 外发健康报告页面</strong>
              <span>每个新批次都需要用户再次确认。原始 PDF/图片内容会发送至 MinerU；原始文件名和本地路径不会发送。</span>
            </div>
          </div>
          <p class="preview-hint">{{ selectedRecognitionMode.description }}</p>
          <p v-if="selectedRecognitionMode.limits.maxFileMegabytes" class="preview-hint">
            官方单源文件限额：{{ selectedRecognitionMode.limits.maxFileMegabytes }} MB / {{ selectedRecognitionMode.limits.maxPages }} 页；超限时该源文件改用本地 OCR。
          </p>
          <p v-if="selectedRecognitionMode.externalProcessing" class="preview-hint">
            远程模式直接上传原始 PDF/图片；本地 OCR 环境只在官方限额降级或使用本地识别时需要。无本地环境时，远程批次仍可正常提交和轮询。
          </p>
          <label v-if="recognitionSettings.mode === 'mineru_precise'">
            <span><KeyRound :size="15" /> MinerU API Token</span>
            <input
              v-model.trim="recognitionToken"
              type="password"
              autocomplete="new-password"
              :placeholder="recognitionSettings.apiTokenConfigured ? `已配置 ${recognitionSettings.apiTokenMasked}` : '输入 MinerU API Token'"
            />
          </label>
          <label v-if="recognitionSettings.apiTokenConfigured" class="checkbox-row">
            <input v-model="clearRecognitionToken" type="checkbox" />
            <span>清除已保存的精准解析 Token</span>
          </label>
          <p class="preview-hint">Token 使用 AES-256-GCM 加密保存，界面和普通用户接口不会返回明文；保存设置时不会调用 MinerU 消耗额度。</p>
          <div class="form-actions">
            <button type="button" :disabled="savingRecognitionSettings" @click="saveRecognitionSettings">
              <LoaderCircle v-if="savingRecognitionSettings" class="spin-icon" :size="17" />
              <Save v-else :size="17" />
              {{ savingRecognitionSettings ? "正在保存" : "保存识别方式" }}
            </button>
          </div>
        </div>
      </section>
      <header>
        <Cpu :size="21" />
        <div><h3>运行状态</h3><p>设备本地识别环境与任务队列</p></div>
        <button
          v-if="app.session.value?.isAdmin"
          class="header-action"
          type="button"
          :disabled="ocr?.available || ocr?.installing"
          @click="installOcr"
        >
          <LoaderCircle v-if="ocr?.installing" class="spin-icon" :size="17" />
          <CheckCircle2 v-else-if="ocr?.available" :size="17" />
          <Download v-else :size="17" />
          {{ ocr?.available ? "OCR 已安装" : ocr?.installing ? "正在安装" : "安装 OCR 环境" }}
        </button>
      </header>
      <div class="status-grid">
        <div class="status-card status-card--wide">
          <span>数据库</span>
          <strong><Database :size="16" />{{ integrityLabel(system?.database?.integrity) }} · {{ formatBytes(system?.database?.totalSizeBytes) }}</strong>
          <small>Schema v{{ system?.database?.appliedSchemaVersion || system?.database?.schemaVersion || "—" }} · {{ system?.database?.journalMode?.toUpperCase() || "—" }} · WAL {{ formatBytes(system?.database?.walSizeBytes) }}</small>
          <div class="compact-counts">
            <span v-for="row in databaseSummaryRows" :key="row.label">{{ row.label }} {{ row.value }}</span>
          </div>
        </div>
        <div><span>服务端口</span><strong>{{ system?.servicePort || "检查中" }}</strong></div>
        <div><span>OCR 运行环境</span><strong>{{ ocr?.available ? "可用" : ocr?.installing ? "安装中" : "未安装" }}</strong></div>
        <div><span>处理队列</span><strong>待处理 {{ ocr?.runner?.queued || 0 }} · 运行中 {{ ocr?.runner?.processing || 0 }} · 失败 {{ ocr?.runner?.failed || 0 }}</strong></div>
      </div>
      <section class="runtime-detail">
        <header><h4>数据目录占用</h4><p>{{ system?.storage?.storageDir || "正在读取数据目录" }}</p></header>
        <div class="usage-grid usage-grid--compact">
          <div><span>数据库目录</span><strong>{{ formatBytes(system?.storage?.databaseBytes) }}</strong></div>
          <div><span>报告原件</span><strong>{{ formatBytes(system?.storage?.reportsBytes) }}</strong></div>
          <div><span>缩略图</span><strong>{{ formatBytes(system?.storage?.thumbnailsBytes) }}</strong></div>
          <div><span>备份</span><strong>{{ formatBytes(system?.storage?.backupsBytes) }}</strong></div>
          <div><span>日志</span><strong>{{ formatBytes(system?.storage?.logsBytes) }}</strong></div>
          <div><span>OCR 模型</span><strong>{{ formatBytes(system?.storage?.modelsBytes) }}</strong></div>
          <div><span>已统计合计</span><strong>{{ formatBytes(system?.storage?.totalKnownBytes) }}</strong></div>
        </div>
      </section>
      <section class="runtime-detail">
        <header>
          <h4>Python 依赖镜像源</h4>
          <p>国内网络建议选择清华、阿里云、腾讯云或华为云；保存后下次安装 OCR 环境时生效。</p>
        </header>
        <div class="settings-form runtime-pip-form">
          <label>
            <span>镜像源</span>
            <select v-model="ocrSettings.pipMirror">
              <option v-for="mirror in ocrSettings.mirrors" :key="mirror.key" :value="mirror.key">
                {{ mirror.label }}
              </option>
            </select>
          </label>
          <label v-if="ocrSettings.pipMirror === 'custom'">
            <span>自定义地址</span>
            <input v-model.trim="ocrSettings.customPipIndexUrl" placeholder="https://example.com/simple" />
          </label>
          <p class="preview-hint">当前将使用：{{ selectedPipIndexUrl || "pip 默认源" }}</p>
          <div class="form-actions">
            <button type="button" :disabled="savingOcrSettings || ocr?.installing" @click="saveOcrSettings">
              <LoaderCircle v-if="savingOcrSettings" class="spin-icon" :size="17" />
              <Save v-else :size="17" />
              {{ savingOcrSettings ? "正在保存" : "保存镜像源" }}
            </button>
          </div>
        </div>
      </section>
      <section v-if="!ocr?.available || ocr?.lastInstall?.state" class="runtime-detail">
        <header>
          <h4>OCR 安装诊断</h4>
          <p>安装完成后会执行一次真实 OCR 测试，通过后记录当前可用的运行环境版本。</p>
        </header>
        <div class="usage-grid usage-grid--compact">
          <div v-for="row in ocrRuntimeRows" :key="row.label"><span>{{ row.label }}</span><strong>{{ row.value }}</strong></div>
        </div>
        <p v-if="ocr?.lastInstall?.error" class="inline-panel-error">{{ ocr.lastInstall.error }}</p>
        <p v-if="ocr?.lastInstall?.warning" class="preview-hint">{{ ocr.lastInstall.warning }}</p>
        <p v-if="ocr?.lastInstall?.missing?.length" class="preview-hint">缺失路径：{{ ocr.lastInstall.missing.join("；") }}</p>
        <p v-if="ocr?.lastInstall?.logPath" class="preview-hint">安装日志：{{ ocr.lastInstall.logPath }}</p>
        <pre v-if="ocr?.lastInstall?.logTail?.length" class="runtime-install-log"><span v-for="(line, index) in ocr.lastInstall.logTail" :key="index" :class="logLineClass(line)">{{ line }}
</span></pre>
      </section>
      <p v-if="runtimeMessage" class="runtime-message">{{ runtimeMessage }}</p>
    </section>
  </section>
</template>
