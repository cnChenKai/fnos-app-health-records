<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronRight, FileText, RefreshCw, Sparkles } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { request } from "../../utils/api";
import { useConfirm } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";

const confirmDialog = useConfirm();

type PdfPreviewMaintenanceResult = {
  scanned: number;
  regenerated: number;
  failed: number;
  removedLegacy: number;
  failures: Array<{ pageId: string; reportId: string; message: string }>;
};

type IndicatorNormalizationResult = {
  scanned: number;
  normalized: number;
  high: number;
  medium: number;
  low: number;
  excluded: number;
  unknown: number;
  ai?: {
    reports: number;
    suggested: number;
    applied: number;
    skipped: number;
    failed: number;
  };
};

type IndicatorNormalizationTask = {
  id: string;
  mode: "incremental" | "full";
  status: "queued" | "running" | "completed" | "failed";
  totalReports: number;
  processedReports: number;
  progressPercent: number;
  attempts: number;
  result: IndicatorNormalizationResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  reused?: boolean;
};

const toast = useToast();
const previewRunning = ref(false);
const previewResult = ref<PdfPreviewMaintenanceResult | null>(null);
const previewError = ref("");
const normalizationTask = ref<IndicatorNormalizationTask | null>(null);
const normalizationTaskActive = computed(() =>
  normalizationTask.value?.status === "queued" || normalizationTask.value?.status === "running"
);
const normalizationRunning = computed(() =>
  normalizationTaskActive.value && normalizationTask.value?.mode === "incremental"
);
const fullNormalizationRunning = computed(() =>
  normalizationTaskActive.value && normalizationTask.value?.mode === "full"
);
const normalizationResult = ref<IndicatorNormalizationResult | null>(null);
const normalizationError = ref("");
let normalizationPollTimer: ReturnType<typeof setTimeout> | null = null;

function clearNormalizationPoll() {
  if (normalizationPollTimer) clearTimeout(normalizationPollTimer);
  normalizationPollTimer = null;
}

function normalizationStatusLabel(task: IndicatorNormalizationTask) {
  if (task.status === "queued") return "等待执行";
  if (task.status === "running") return "后台处理中";
  if (task.status === "completed") return "已完成";
  return "执行失败";
}

function applyNormalizationTask(task: IndicatorNormalizationTask | null, notify = false) {
  const previous = normalizationTask.value;
  normalizationTask.value = task;
  if (task?.result) normalizationResult.value = task.result;
  else if (previous?.id !== task?.id) normalizationResult.value = null;
  if (task?.status === "failed") {
    normalizationError.value = task.errorMessage || "指标归一化任务执行失败";
  } else if (previous?.id !== task?.id) {
    normalizationError.value = "";
  }
  if (
    notify
    && previous
    && task
    && previous.id === task.id
    && (previous.status === "queued" || previous.status === "running")
    && task.status === "completed"
  ) {
    toast.show(task.result?.ai?.applied
      ? `已归一化 ${task.result.normalized} 项，AI 兜底 ${task.result.ai.applied} 项`
      : `已归一化 ${task.result?.normalized || 0} 项指标`);
  } else if (
    notify
    && previous
    && task
    && previous.id === task.id
    && (previous.status === "queued" || previous.status === "running")
    && task.status === "failed"
  ) {
    toast.show("指标归一化任务执行失败");
  }
}

function scheduleNormalizationPoll() {
  clearNormalizationPoll();
  if (!normalizationTaskActive.value) return;
  normalizationPollTimer = setTimeout(() => {
    void refreshNormalizationTask(true);
  }, 2_000);
}

async function refreshNormalizationTask(notify = false) {
  try {
    const task = await request<IndicatorNormalizationTask | null>("maintenance/indicator-normalization");
    applyNormalizationTask(task, notify);
  } catch (cause) {
    normalizationError.value = cause instanceof Error ? cause.message : "无法获取指标归一化任务状态";
  } finally {
    scheduleNormalizationPoll();
  }
}

onMounted(() => {
  void refreshNormalizationTask();
});

onBeforeUnmount(clearNormalizationPoll);

async function regeneratePdfPreviews() {
  confirmDialog.ask({
    title: "重新生成 PDF 单页图",
    message: "确认重新生成历史 PDF 单页预览图？会用高清单页图直接替换旧预览图，原 PDF 和缩略图不受影响。",
    confirmText: "开始生成",
    run: async () => {
      previewRunning.value = true;
      previewError.value = "";
      try {
        previewResult.value = await request<PdfPreviewMaintenanceResult>("maintenance/pdf-previews", { method: "POST" });
        toast.show(previewResult.value.failed
          ? `已生成 ${previewResult.value.regenerated} 页，失败 ${previewResult.value.failed} 页`
          : `已生成 ${previewResult.value.regenerated} 页高清图`);
      } catch (cause) {
        previewError.value = cause instanceof Error ? cause.message : "PDF 单页图维护失败";
      } finally {
        previewRunning.value = false;
      }
    }
  });
}

async function normalizeIndicators() {
  confirmDialog.ask({
    title: "整理未归类指标",
    message: "确认整理历史未归类指标？不会重新 OCR，也不会覆盖已经归一化完成的指标；会先用内置字典补齐，若 AI 已启用，会对仍未命中的非预设指标调用文本模型兜底，可能产生模型调用费用。",
    confirmText: "开始整理",
    run: async () => {
      normalizationError.value = "";
      try {
        const task = await request<IndicatorNormalizationTask>("maintenance/indicator-normalization", { method: "POST" });
        applyNormalizationTask(task);
        toast.show(task.reused
          ? `已有${task.mode === "full" ? "全量" : "增量"}任务正在执行`
          : "已提交后台整理任务，可离开当前页面");
        scheduleNormalizationPoll();
      } catch (cause) {
        normalizationError.value = cause instanceof Error ? cause.message : "指标归一化失败";
      }
    }
  });
}

async function normalizeAllIndicators() {
  confirmDialog.ask({
    title: "全量重新归一化",
    message: "确认清空所有已归一化结果并重新整理全部指标？用于修复历史误并的指标系列；不会重新 OCR 或修改原始指标，但 AI 兜底会对所有未命中字典的指标重新调用，指标较多时可能产生较高模型调用费用。",
    confirmText: "清空并重跑",
    danger: true,
    run: async () => {
      normalizationError.value = "";
      try {
        const task = await request<IndicatorNormalizationTask>("maintenance/indicator-normalization", {
          method: "POST",
          body: JSON.stringify({ full: true })
        });
        applyNormalizationTask(task);
        toast.show(task.reused
          ? `已有${task.mode === "full" ? "全量" : "增量"}任务正在执行`
          : "已提交全量后台任务，可离开当前页面");
        scheduleNormalizationPoll();
      } catch (cause) {
        normalizationError.value = cause instanceof Error ? cause.message : "全量归一化失败";
      }
    }
  });
}
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="维护工具" description="处理历史数据的高清分页图和指标趋势归一化" />

    <section class="settings-band">
      <header>
        <div>
          <Sparkles :size="20" />
          <div>
            <h3>整理未归类指标</h3>
            <p>只处理尚未归类的历史指标；非预设指标会在 AI 已启用时调用文本模型兜底，不修改原始指标。</p>
          </div>
        </div>
        <div class="maintenance-actions">
          <button class="soft-action-button danger-action-button" type="button" :disabled="normalizationTaskActive" @click="normalizeAllIndicators">
            <RefreshCw :size="15" :class="{ 'spin-icon': fullNormalizationRunning }" />{{ fullNormalizationRunning ? "重跑中" : "全量重跑" }}
          </button>
          <button class="primary-button" type="button" :disabled="normalizationTaskActive" @click="normalizeIndicators">
            <RefreshCw :size="15" :class="{ 'spin-icon': normalizationRunning }" />{{ normalizationRunning ? "整理中" : "增量整理" }}
          </button>
        </div>
      </header>
      <p class="preview-hint">“增量整理”只处理未归类指标；“全量重跑”会清空已有归一化结果全部重建，用于修复误并的指标系列。</p>
      <div v-if="normalizationTaskActive && normalizationTask" class="maintenance-task-progress">
        <div class="maintenance-task-progress-head">
          <span>{{ normalizationTask.mode === "full" ? "全量重跑" : "增量整理" }}</span>
          <strong>{{ normalizationStatusLabel(normalizationTask) }}</strong>
        </div>
        <div class="maintenance-task-progress-track" aria-hidden="true">
          <i :style="{ width: `${normalizationTask.progressPercent}%` }"></i>
        </div>
        <p v-if="normalizationTask.totalReports">
          已处理 {{ normalizationTask.processedReports }} / {{ normalizationTask.totalReports }} 份报告（{{ normalizationTask.progressPercent }}%）
        </p>
        <p v-else>正在扫描需要整理的报告，可离开当前页面继续执行。</p>
      </div>
      <p v-if="normalizationError" class="inline-panel-error">{{ normalizationError }}</p>
      <div v-if="normalizationResult" class="maintenance-result">
        <div>
          <span>处理指标</span>
          <strong>{{ normalizationResult.scanned }}</strong>
        </div>
        <div>
          <span>入趋势</span>
          <strong>{{ normalizationResult.normalized }}</strong>
        </div>
        <div>
          <span>高/中可信</span>
          <strong>{{ normalizationResult.high }}/{{ normalizationResult.medium }}</strong>
        </div>
        <div>
          <span>保守排除</span>
          <strong>{{ normalizationResult.excluded + normalizationResult.unknown }}</strong>
        </div>
        <div v-if="normalizationResult.ai">
          <span>AI 兜底</span>
          <strong>{{ normalizationResult.ai.applied }}/{{ normalizationResult.ai.suggested }}</strong>
        </div>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <div>
          <Sparkles :size="20" />
          <div>
            <h3>指标理解问题池</h3>
            <p>聚合未命中字典、低可信和被排除的指标，后续用于完善内置字典、AI 兜底和机构规则。</p>
          </div>
        </div>
        <RouterLink class="soft-action-button compact-soft" to="/me/maintenance/indicator-issues">
          查看<ChevronRight :size="16" />
        </RouterLink>
      </header>
    </section>

    <section class="settings-band">
      <header>
        <div>
          <FileText :size="20" />
          <div>
            <h3>重新生成 PDF 单页图</h3>
            <p>为历史 PDF 报告重新生成高清单页预览图，并直接替换旧预览图；缩略图和原 PDF 不会变化。</p>
          </div>
        </div>
        <button class="primary-button compact-primary" type="button" :disabled="previewRunning" @click="regeneratePdfPreviews">
          <RefreshCw :size="16" :class="{ 'spin-icon': previewRunning }" />{{ previewRunning ? "生成中" : "重新生成" }}
        </button>
      </header>
      <p v-if="previewError" class="inline-panel-error">{{ previewError }}</p>
      <div v-if="previewResult" class="maintenance-result">
        <div>
          <span>扫描 PDF 页</span>
          <strong>{{ previewResult.scanned }}</strong>
        </div>
        <div>
          <span>生成高清图</span>
          <strong>{{ previewResult.regenerated }}</strong>
        </div>
        <div>
          <span>替换旧图</span>
          <strong>{{ previewResult.removedLegacy }}</strong>
        </div>
        <div>
          <span>失败页数</span>
          <strong>{{ previewResult.failed }}</strong>
        </div>
      </div>
    </section>

    <section v-if="previewResult?.failures.length" class="settings-band maintenance-change-list">
      <header>
        <div><FileText :size="20" /><div><h3>生成失败样例</h3><p>最多显示前 {{ previewResult.failures.length }} 条。</p></div></div>
      </header>
      <article v-for="failure in previewResult.failures" :key="failure.pageId">
        <span>{{ failure.reportId }} / {{ failure.pageId }}</span>
        <strong>{{ failure.message }}</strong>
      </article>
    </section>
  </section>
</template>
