<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import {
  ArrowDown, ArrowUp, Camera, CheckCircle2, CircleAlert, FileImage, FileText,
  ImagePlus, LoaderCircle, RefreshCw, RotateCw, UploadCloud, X
} from "@lucide/vue";
import { useAppContext } from "../composables/useAppContext";
import { request } from "../utils/api";

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
  status: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  errorMessage: string | null;
};

const app = useAppContext();
const items = ref<QueueItem[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const cameraInput = ref<HTMLInputElement | null>(null);
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
const finishedJobs = computed(() => completedJobs.value + failedJobs.value.length);
const progressPercent = computed(() => jobs.value.length ? Math.round(finishedJobs.value / jobs.value.length * 100) : 0);
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
  for (const file of files) {
    const duplicate = items.value.some((item) =>
      item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified
    );
    if (duplicate) continue;
    items.value.push({
      id: crypto.randomUUID(),
      file,
      previewUrl: canPreview(file) ? URL.createObjectURL(file) : "",
      rotation: 0
    });
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

function jobLabel(jobType: ProcessingJob["jobType"]) {
  return { pdf_extract: "PDF 拆页", thumbnail: "生成缩略图", ocr: "文字识别", ai_extract: "AI 整理" }[jobType];
}

async function refreshJobs() {
  if (!result.value) return;
  try {
    const [nextJobs, ocr] = await Promise.all([
      request<ProcessingJob[]>(`jobs?reportId=${encodeURIComponent(result.value.reportId)}`),
      app.session.value?.isGatewayAdmin ? request<{ available: boolean }>("ocr/status") : Promise.resolve(null)
    ]);
    jobs.value = nextJobs;
    if (ocr) runtimeAvailable.value = ocr.available;
    if (nextJobs.length && nextJobs.every((job) => ["completed", "failed"].includes(job.status))) stopPolling();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法获取任务状态";
    stopPolling();
  }
}

function startPolling() {
  stopPolling();
  void refreshJobs();
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
  if (!app.selectedMemberId.value || !items.value.length) return;
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
        <button class="primary-button file-button" type="button" @click="fileInput?.click()"><UploadCloud :size="18" />选择文件</button>
        <button class="camera-button" type="button" @click="cameraInput?.click()"><Camera :size="18" />拍照</button>
      </div>
    </div>
    <input ref="fileInput" class="visually-hidden" type="file" :accept="accept" multiple @change="pick" />
    <input ref="cameraInput" class="visually-hidden" type="file" accept="image/*" capture="environment" multiple @change="pick" />

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
