<script setup lang="ts">
import { ref } from "vue";
import { ChevronRight, Database, FileText, RefreshCw, ScanSearch } from "@lucide/vue";
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

type MorphologyTrackingResult = {
  scanned: number;
  linked: number;
  groups: number;
  untracked: number;
  ambiguous: number;
  members: number;
};

const toast = useToast();
const previewRunning = ref(false);
const previewResult = ref<PdfPreviewMaintenanceResult | null>(null);
const previewError = ref("");
const morphologyRunning = ref(false);
const morphologyResult = ref<MorphologyTrackingResult | null>(null);
const morphologyError = ref("");

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

async function rebuildMorphologyTracking() {
  confirmDialog.ask({
    title: "重新关联历史形态发现",
    message: "确认按部位、左右侧和发现类型重新关联历史形态记录？该操作只在本地整理关联关系，不调用 AI，也不会修改原报告内容。",
    confirmText: "开始关联",
    run: async () => {
      morphologyRunning.value = true;
      morphologyError.value = "";
      try {
        morphologyResult.value = await request<MorphologyTrackingResult>(
          "maintenance/morphology-tracking",
          { method: "POST" }
        );
        toast.show(`已建立 ${morphologyResult.value.groups} 组形态变化记录`);
      } catch (cause) {
        morphologyError.value = cause instanceof Error ? cause.message : "历史形态关联失败";
      } finally {
        morphologyRunning.value = false;
      }
    }
  });
}
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="维护工具" description="管理指标、形态关联和 PDF 高清分页图" />

    <section class="settings-band">
      <header>
        <div>
          <Database :size="20" />
          <div>
            <h3>指标管理</h3>
            <p>集中管理指标字典、历史字典匹配和未命中问题池。</p>
          </div>
        </div>
        <RouterLink class="soft-action-button compact-soft" to="/me/maintenance/indicators">
          进入<ChevronRight :size="16" />
        </RouterLink>
      </header>
    </section>

    <section class="settings-band">
      <header>
        <div>
          <ScanSearch :size="20" />
          <div>
            <h3>重新关联历史形态发现</h3>
            <p>按成员、器官、左右侧、区域和发现类型重建形态变化线；歧义记录保留为待确认。</p>
          </div>
        </div>
        <button class="primary-button compact-primary" type="button" :disabled="morphologyRunning" @click="rebuildMorphologyTracking">
          <RefreshCw :size="16" :class="{ 'spin-icon': morphologyRunning }" />{{ morphologyRunning ? "关联中" : "重新关联" }}
        </button>
      </header>
      <p v-if="morphologyError" class="inline-panel-error">{{ morphologyError }}</p>
      <div v-if="morphologyResult" class="maintenance-result">
        <div>
          <span>扫描发现</span>
          <strong>{{ morphologyResult.scanned }}</strong>
        </div>
        <div>
          <span>成功关联</span>
          <strong>{{ morphologyResult.linked }}</strong>
        </div>
        <div>
          <span>变化分组</span>
          <strong>{{ morphologyResult.groups }}</strong>
        </div>
        <div>
          <span>待确认/歧义</span>
          <strong>{{ morphologyResult.untracked }}/{{ morphologyResult.ambiguous }}</strong>
        </div>
      </div>
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
