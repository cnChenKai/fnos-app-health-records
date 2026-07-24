<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Cpu, Database, Download, LoaderCircle } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { request } from "../../utils/api";
import { useAppContext } from "../../composables/useAppContext";

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

const app = useAppContext();
const system = ref<SystemSummary | null>(null);
const ocr = ref<OcrStatus | null>(null);
const runtimeMessage = ref("");
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

async function refreshOcr() {
  try {
    ocr.value = await request<OcrStatus>("ocr/status");
    syncStatusPolling();
  } catch (error) {
    runtimeMessage.value = error instanceof Error ? error.message : "无法获取 OCR 状态";
    stopStatusPolling();
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
onMounted(async () => {
  [system.value, ocr.value] = await Promise.all([request<SystemSummary>("system"), request<OcrStatus>("ocr/status")]);
  syncStatusPolling();
});
onBeforeUnmount(stopStatusPolling);
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="运行与识别" description="报告先在设备内完成 OCR，再由 AI 整理结构化字段" />
    <section class="settings-band">
      <header>
        <Cpu :size="21" />
        <div><h3>运行状态</h3><p>设备本地识别环境与任务队列</p></div>
        <button
          v-if="app.session.value?.isGatewayAdmin"
          class="header-action"
          type="button"
          :disabled="ocr?.available || ocr?.installing"
          @click="installOcr"
        >
          <LoaderCircle v-if="ocr?.installing" class="spin-icon" :size="17" />
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
