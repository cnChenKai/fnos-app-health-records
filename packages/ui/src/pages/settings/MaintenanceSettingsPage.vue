<script setup lang="ts">
import { ref } from "vue";
import { FileText, RefreshCw } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { request } from "../../utils/api";
import { useToast } from "../../composables/useToast";

type PdfPreviewMaintenanceResult = {
  scanned: number;
  regenerated: number;
  failed: number;
  removedLegacy: number;
  failures: Array<{ pageId: string; reportId: string; message: string }>;
};

const toast = useToast();
const previewRunning = ref(false);
const previewResult = ref<PdfPreviewMaintenanceResult | null>(null);
const previewError = ref("");

async function regeneratePdfPreviews() {
  if (!window.confirm("确认重新生成历史 PDF 单页预览图？会用高清单页图直接替换旧预览图，原 PDF 和缩略图不受影响。")) return;
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
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="维护工具" description="重新生成历史 PDF 报告的高清单页图" />

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
