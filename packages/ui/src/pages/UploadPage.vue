<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref } from "vue";
import {
  ArrowDown, ArrowUp, Camera, CheckCircle2, CircleAlert, FileImage, FileText,
  ImagePlus, LoaderCircle, RefreshCw, RotateCw, UploadCloud, X
} from "@lucide/vue";
import { useAppContext } from "../composables/useAppContext";
import { request } from "../utils/api";
import { describeTechnical } from "../utils/error";

type QueueItem = {
  id: string;
  file: File;
  previewUrl: string;
  rotation: number;
};

type UploadResult = {
  reportId: string;
  title: string;
  status: "queued";
  pageCount: number;
  jobCount: number;
};

type ProcessingJob = {
  id: string;
  jobType: "pdf_extract" | "thumbnail" | "ocr" | "ai_extract";
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  attempts: number;
  errorMessage: string | null;
  ocrTextLength?: number | null;
};

const app = useAppContext();
const items = ref<QueueItem[]>([]);
const dragging = ref(false);
const uploading = ref(false);
const error = ref("");
const result = ref<UploadResult | null>(null);
const jobs = ref<ProcessingJob[]>([]);
const runtimeAvailable = ref(true);
let pollTimer: ReturnType<typeof setInterval> | null = null;
const totalBytes = computed(() => items.value.reduce((total, item) => total + item.file.size, 0));
const completedJobs = computed(() => jobs.value.filter((job) => job.status === "completed").length);
const failedJobs = computed(() => jobs.value.filter((job) => job.status === "failed"));
const cancelledJobs = computed(() => jobs.value.filter((job) => job.status === "cancelled").length);
const finishedJobs = computed(() => completedJobs.value + failedJobs.value.length + cancelledJobs.value);
const progressPercent = computed(() => jobs.value.length ? Math.round(finishedJobs.value / jobs.value.length * 100) : 0);
const jobsSettled = computed(() => jobs.value.length > 0 && jobs.value.every((job) => ["completed", "failed", "cancelled"].includes(job.status)));
const uploadFinishedSuccessfully = computed(() => jobs.value.length > 0 && jobs.value.every((job) => job.status === "completed"));
/* 全部任务结束且 OCR 全为空：原件大概率不是有效报告，需要明确告知用户而不是只发一条通知 */
const ocrEmptyWarning = computed(() => {
  if (!jobsSettled.value || failedJobs.value.length) return false;
  const ocrJobs = jobs.value.filter((job) => job.jobType === "ocr" && job.status === "completed");
  return ocrJobs.length > 0 && ocrJobs.every((job) => !job.ocrTextLength);
});
const accept = ".heic,.heif,.jpg,.jpeg,.png,.webp,.pdf,image/heic,image/heif,image/jpeg,image/png,image/webp,application/pdf";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function supported(file: File) {
  return /\.(heic|heif|jpe?g|png|webp|pdf)$/i.test(file.name)
    || ["image/heic", "image/heif", "image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type);
}

function canPreview(file: File) {
  return ["image/jpeg", "image/png", "image/webp"].includes(file.type)
    || /\.(jpe?g|png|webp)$/i.test(file.name);
}

/* crypto.randomUUID 仅在安全上下文（HTTPS/localhost）可用，HTTP 内网访问或旧浏览器会抛 TypeError，退回 getRandomValues */
function createItemId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function addFiles(files: File[]) {
  error.value = "";
  result.value = null;
  stopPolling();
  jobs.value = [];
  const unsupported = files.find((file) => !supported(file));
  if (unsupported) {
    error.value = `不支持文件“${unsupported.name}”的格式`;
    return;
  }
  if (items.value.length + files.length > 24) {
    error.value = "一次最多上传 24 个文件";
    return;
  }
  if (files.some((file) => file.size > 40 * 1024 * 1024)) {
    error.value = "单个文件不能超过 40 MB";
    return;
  }
  if (totalBytes.value + files.reduce((sum, file) => sum + file.size, 0) > 200 * 1024 * 1024) {
    error.value = "单次上传不能超过 200 MB";
    return;
  }
  /* 入队过程的同步异常（如旧浏览器缺失 API）必须浮现给用户，避免“选完文件毫无反应” */
  try {
    for (const file of files) {
      const duplicate = items.value.some((item) =>
        item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified
      );
      if (duplicate) continue;
      items.value.push({
        id: createItemId(),
        file,
        previewUrl: canPreview(file) ? URL.createObjectURL(file) : "",
        rotation: 0
      });
    }
  } catch (cause) {
    error.value = `添加文件失败，请重试或更换浏览器（${describeTechnical(cause)}）`;
  }
}

function pick(event: Event) {
  const input = event.target as HTMLInputElement;
  addFiles(Array.from(input.files || []));
  input.value = "";
}

function drop(event: DragEvent) {
  dragging.value = false;
  addFiles(Array.from(event.dataTransfer?.files || []));
}

function remove(index: number) {
  const [removed] = items.value.splice(index, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
}

function move(index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= items.value.length) return;
  const [item] = items.value.splice(index, 1);
  items.value.splice(target, 0, item);
}

function rotate(item: QueueItem) {
  item.rotation = (item.rotation + 90) % 360;
}

function clearQueue() {
  for (const item of items.value) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  items.value = [];
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function clearFinishedUpload() {
  stopPolling();
  result.value = null;
  jobs.value = [];
  error.value = "";
}

function jobLabel(jobType: ProcessingJob["jobType"]) {
  return { pdf_extract: "PDF 拆页", thumbnail: "生成缩略图", ocr: "文字识别", ai_extract: "AI 整理" }[jobType];
}

async function refreshJobs(includeRuntime = false) {
  if (!result.value) return;
  const reportId = result.value.reportId;
  try {
    /* OCR 运行状态仅在提交后首次刷新时查询，轮询周期内不再重复请求 */
    const [nextJobs, ocr] = await Promise.all([
      request<ProcessingJob[]>(`jobs?reportId=${encodeURIComponent(reportId)}`),
      includeRuntime && app.session.value?.isGatewayAdmin ? request<{ available: boolean }>("ocr/status") : Promise.resolve(null)
    ]);
    if (result.value?.reportId !== reportId) return;
    jobs.value = nextJobs;
    if (ocr) runtimeAvailable.value = ocr.available;
    if (nextJobs.some((job) => job.status === "cancelled")) {
      app.notifyDataChanged();
      clearFinishedUpload();
      return;
    }
    if (nextJobs.length && nextJobs.every((job) => ["completed", "failed", "cancelled"].includes(job.status))) {
      stopPolling();
      app.notifyDataChanged();
    }
  } catch (cause) {
    if (result.value?.reportId !== reportId) return;
    const message = cause instanceof Error ? cause.message : "无法获取任务状态";
    /* 已永久删除的历史上传不再是待处理任务，清掉缓存面板即可。 */
    if (message.includes("报告不存在") && message.includes("HTTP 404")) {
      clearFinishedUpload();
      return;
    }
    error.value = message;
    stopPolling();
  }
}

function startPolling() {
  stopPolling();
  void refreshJobs(true);
  pollTimer = setInterval(() => { void refreshJobs(); }, 2500);
}

async function retryJob(job: ProcessingJob) {
  try {
    await request(`jobs/${job.id}/retry`, { method: "POST" });
    await refreshJobs();
    startPolling();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "任务重试失败";
  }
}

async function submit() {
  if (!items.value.length) return;
  if (!app.selectedMemberId.value) {
    error.value = "请先选择报告所属成员";
    return;
  }
  uploading.value = true;
  error.value = "";
  result.value = null;
  try {
    const body = new FormData();
    body.append("memberId", app.selectedMemberId.value);
    body.append("manifest", JSON.stringify({ pages: items.value.map((item) => ({ rotation: item.rotation })) }));
    for (const item of items.value) body.append("files", item.file, item.file.name);
    result.value = await request<UploadResult>("uploads", { method: "POST", body });
    clearQueue();
    startPolling();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "上传失败";
  } finally {
    uploading.value = false;
  }
}

onBeforeUnmount(() => {
  clearQueue();
  stopPolling();
});
/* 已完成的上传只在当前停留期间保留结果；离开后回到干净的上传工作台。失败任务继续保留以便重试。 */
onDeactivated(() => {
  if (uploadFinishedSuccessfully.value || cancelledJobs.value) clearFinishedUpload();
});
/* 任务未跑完时后台（KeepAlive 失活）也保持轮询，完成后广播数据变更；回到页面时补一次刷新 */
onActivated(() => {
  if (!result.value) return;
  if (uploadFinishedSuccessfully.value || cancelledJobs.value) {
    clearFinishedUpload();
    return;
  }
  startPolling();
});
</script>

<template>
  <section class="plain-page upload-page">
    <div class="page-intro">
      <div><h2>上传健康报告</h2><p>保存到 {{ app.selectedMember.value?.displayName || "当前成员" }} 的档案，多张图片会合并为同一份报告</p></div>
      <span v-if="items.length" class="count-label">{{ items.length }} 个文件 · {{ formatBytes(totalBytes) }}</span>
    </div>

    <div
      class="drop-zone"
      :class="{ dragging }"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="drop"
    >
      <span class="drop-icon"><ImagePlus :size="30" /></span>
      <strong>拖放报告到这里</strong>
      <span class="drop-hint">HEIC、JPEG、PNG、WebP 或多页 PDF，按下方顺序识别为一份报告</span>
      <div class="drop-actions">
        <label class="primary-button file-button upload-picker">
          <UploadCloud :size="18" /><span>选择文件</span>
          <input type="file" :accept="accept" multiple aria-label="选择报告文件" @change="pick" />
        </label>
        <label class="camera-button upload-picker">
          <Camera :size="18" /><span>拍照</span>
          <input type="file" accept="image/*" capture="environment" multiple aria-label="拍摄报告照片" @change="pick" />
        </label>
      </div>
    </div>

    <p v-if="error" class="upload-error">{{ error }}</p>
    <div v-if="result" class="upload-success">
      <CheckCircle2 :size="22" />
      <div><strong>报告已进入处理队列</strong><span>{{ result.pageCount }} 个原件，{{ result.jobCount }} 个初始任务，AI 整理后自动命名</span></div>
      <RouterLink to="/records">查看档案</RouterLink>
    </div>

    <section v-if="result" class="job-progress" aria-live="polite">
      <div class="job-progress-summary">
        <div>
          <strong>后台处理</strong>
          <span v-if="jobs.length">已完成 {{ finishedJobs }} / {{ jobs.length }}</span>
          <span v-else>正在读取任务状态</span>
        </div>
        <span v-if="jobs.length">{{ progressPercent }}%</span>
      </div>
      <div class="job-progress-bar" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
        <span :style="{ width: `${progressPercent}%` }"></span>
      </div>
      <div v-if="!runtimeAvailable" class="runtime-warning">
        <CircleAlert :size="18" />
        <div><strong>等待安装本地 OCR 环境</strong><span>{{ app.session.value?.isGatewayAdmin ? "原件已安全保存，安装后任务会自动继续。" : "原件已安全保存，请联系 fnOS 管理员安装 OCR 环境。" }}</span></div>
        <RouterLink v-if="app.session.value?.isGatewayAdmin" to="/me/runtime">前往运行与识别</RouterLink>
      </div>
      <div v-if="ocrEmptyWarning" class="runtime-warning">
        <CircleAlert :size="18" />
        <div><strong>没有识别到任何文字</strong><span>上传的原件上没有可识别的文字内容，可能不是有效的体检报告。请确认照片清晰、完整包含报告文字后重新上传，或在档案详情中手动录入。</span></div>
        <RouterLink to="/records">查看档案</RouterLink>
      </div>
      <div v-if="failedJobs.length" class="failed-job-list">
        <article v-for="job in failedJobs" :key="job.id">
          <CircleAlert :size="18" />
          <div><strong>{{ jobLabel(job.jobType) }}失败</strong><span>{{ job.errorMessage || "任务执行失败" }}</span></div>
          <button type="button" title="重试任务" @click="retryJob(job)"><RefreshCw :size="17" />重试</button>
        </article>
      </div>
    </section>

    <div v-if="items.length" class="upload-pages">
      <article v-for="(item, index) in items" :key="item.id" class="upload-page-item">
        <div class="page-thumbnail">
          <img v-if="item.previewUrl" :src="item.previewUrl" alt="" :style="{ transform: `rotate(${item.rotation}deg)` }" />
          <FileText v-else-if="item.file.type === 'application/pdf' || /\.pdf$/i.test(item.file.name)" :size="28" />
          <FileImage v-else :size="28" />
          <span>{{ index + 1 }}</span>
        </div>
        <div class="upload-page-info"><strong>{{ item.file.name }}</strong><span>{{ formatBytes(item.file.size) }}<template v-if="item.rotation"> · 旋转 {{ item.rotation }}°</template></span></div>
        <div class="upload-page-actions">
          <button type="button" title="向上移动" :disabled="index === 0" @click="move(index, -1)"><ArrowUp :size="17" /></button>
          <button type="button" title="向下移动" :disabled="index === items.length - 1" @click="move(index, 1)"><ArrowDown :size="17" /></button>
          <button type="button" title="顺时针旋转" @click="rotate(item)"><RotateCw :size="17" /></button>
          <button class="danger-action" type="button" title="移除" @click="remove(index)"><X :size="18" /></button>
        </div>
      </article>
      <div class="upload-submit">
        <span>{{ items.length }} 个文件 · {{ formatBytes(totalBytes) }}，提交后离开页面仍会继续处理</span>
        <button class="primary-button" type="button" :disabled="uploading" @click="submit">
          <LoaderCircle v-if="uploading" class="spin-icon" :size="18" />
          <UploadCloud v-else :size="18" />
          {{ uploading ? "正在保存" : "保存并开始识别" }}
        </button>
      </div>
    </div>
  </section>
</template>
