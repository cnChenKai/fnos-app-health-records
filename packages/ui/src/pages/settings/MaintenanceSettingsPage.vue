<script setup lang="ts">
import { ref } from "vue";
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

const toast = useToast();
const previewRunning = ref(false);
const previewResult = ref<PdfPreviewMaintenanceResult | null>(null);
const previewError = ref("");
const normalizationRunning = ref(false);
const normalizationResult = ref<IndicatorNormalizationResult | null>(null);
const normalizationError = ref("");

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
      normalizationRunning.value = true;
      normalizationError.value = "";
      try {
        normalizationResult.value = await request<IndicatorNormalizationResult>("maintenance/indicator-normalization", { method: "POST" });
        toast.show(normalizationResult.value.ai?.applied
          ? `已归一化 ${normalizationResult.value.normalized} 项，AI 兜底 ${normalizationResult.value.ai.applied} 项`
          : `已归一化 ${normalizationResult.value.normalized} 项指标`);
      } catch (cause) {
        normalizationError.value = cause instanceof Error ? cause.message : "指标归一化失败";
      } finally {
        normalizationRunning.value = false;
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
        <button class="primary-button compact-primary" type="button" :disabled="normalizationRunning" @click="normalizeIndicators">
          <RefreshCw :size="16" :class="{ 'spin-icon': normalizationRunning }" />{{ normalizationRunning ? "整理中" : "开始整理" }}
        </button>
      </header>
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
