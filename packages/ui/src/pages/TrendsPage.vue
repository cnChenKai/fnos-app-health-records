<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Activity, ChartNoAxesCombined, ChevronRight, FileText } from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import ImageViewer, { type ImageViewerPage } from "../components/ImageViewer.vue";
import PullIndicator from "../components/PullIndicator.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { apiUrl, request } from "../utils/api";
import { useAppContext } from "../composables/useAppContext";
import { usePullRefresh } from "../composables/usePullRefresh";
import { useToast } from "../composables/useToast";
import type { TrendPoint, TrendSeries } from "../types/api";

const app = useAppContext();
const loading = ref(true);
const series = ref<TrendSeries[]>([]);
const previewReportId = ref<string | null>(null);
const sourcePreview = ref<{
  point: TrendPoint;
  seriesName: string;
  unit: string | null;
} | null>(null);

const sourcePreviewUrl = computed(() => {
  const value = sourcePreview.value;
  if (!value?.point.sourcePage) return "";
  return apiUrl(`reports/${value.point.reportId}/pages/${value.point.sourcePage.id}/preview`);
});
const sourceViewerPages = computed<ImageViewerPage[]>(() => {
  const value = sourcePreview.value;
  if (!value || !sourcePreviewUrl.value) return [];
  return [{
    key: value.point.sourcePage?.id || "source",
    fullUrl: sourcePreviewUrl.value,
    label: `${value.seriesName} · 第 ${value.point.sourcePage?.pageNumber || 1} 页`,
    downloadUrl: sourcePreviewUrl.value
  }];
});

async function load(memberId: string, silent = false) {
  if (!silent) loading.value = true;
  try { series.value = await request(`trends?memberId=${encodeURIComponent(memberId)}`); }
  finally { if (!silent) loading.value = false; }
}

function reloadTrends() {
  const memberId = app.selectedMemberId.value;
  if (memberId) void load(memberId, true);
}

function formatNumber(value: number | null) {
  if (value === null) return "—";
  if (Math.abs(value) >= 100) return value.toFixed(1).replace(/\.0$/, "");
  if (Math.abs(value) >= 10) return value.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatDate(value: string | null) {
  if (!value) return "日期待确认";
  return value.slice(0, 10);
}

function pointValue(point: TrendPoint, unit: string | null) {
  return [formatNumber(point.numericValue), unit].filter(Boolean).join(" ");
}

function abnormalLabel(value: TrendPoint["abnormalFlag"]) {
  if (!value) return "未标记";
  return { high: "偏高", low: "偏低", abnormal: "异常", normal: "正常" }[value] || "未标记";
}

function flagClass(value: TrendPoint["abnormalFlag"]) {
  if (value === "high") return "up";
  if (value === "low") return "down";
  if (value === "abnormal") return "warn";
  if (value === "normal") return "ok";
  return "plain";
}

function deltaText(item: TrendSeries) {
  if (item.delta === null) return "基线";
  if (item.delta === 0) return "持平";
  return `${item.delta > 0 ? "+" : ""}${formatNumber(item.delta)}`;
}

function deltaClass(item: TrendSeries) {
  if (item.delta === null || item.delta === 0) return "neutral";
  return item.delta > 0 ? "up" : "down";
}

function sparklinePoints(item: TrendSeries) {
  const values = item.points.map((point) => point.numericValue);
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 42 - ((value - min) / span) * 34;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function recentPoints(item: TrendSeries) {
  return [...item.points].reverse().slice(0, 6);
}

function openReport(reportId: string) {
  previewReportId.value = reportId;
}

function openSourcePage(point: TrendPoint, item: TrendSeries) {
  if (!point.sourcePage) {
    openReport(point.reportId);
    return;
  }
  sourcePreview.value = { point, seriesName: item.name, unit: item.unit };
}

function closeSourcePage() {
  sourcePreview.value = null;
}

function openSourceReport() {
  const reportId = sourcePreview.value?.point.reportId;
  if (!reportId) return;
  closeSourcePage();
  openReport(reportId);
}

const root = ref<HTMLElement | null>(null);
const toast = useToast();
const { pullDistance, refreshing } = usePullRefresh(root, async () => {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  try {
    await load(memberId, true);
    toast.show("已是最新数据");
  } catch {
    toast.show("刷新失败，请稍后重试");
  }
});

watch(() => app.selectedMemberId.value, (memberId) => {
  if (!memberId) return;
  load(memberId).catch(() => toast.show("加载失败，请稍后重试"));
}, { immediate: true });
</script>

<template>
  <section ref="root" class="plain-page">
    <div class="page-intro"><div><h2>指标趋势</h2><p>仅比较相同指标和兼容单位</p></div><span class="page-intro-badge"><ChartNoAxesCombined :size="22" /></span></div>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />
    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <EmptyState v-else-if="!series.length" title="暂无可比较指标" description="AI 整理出结构化数值后，这里会展示单次基线值和多次趋势。" />
    <div v-else class="trend-list">
      <article v-for="item in series" :key="`${item.name}-${item.unit}`" class="trend-card">
        <header class="trend-card-header">
          <span class="item-icon"><Activity :size="19" /></span>
          <div>
            <strong>{{ item.name }}</strong>
            <span>{{ item.sectionName || "未分组" }} · {{ item.pointCount }} 个数据点 · {{ item.unit || "无单位" }}</span>
          </div>
          <em class="trend-delta" :class="deltaClass(item)">{{ deltaText(item) }}</em>
        </header>
        <div class="trend-main">
          <div class="trend-latest">
            <span>最新值</span>
            <strong>{{ formatNumber(item.latestValue) }}<small v-if="item.unit">{{ item.unit }}</small></strong>
            <p>{{ formatDate(item.lastDate) }}<template v-if="item.pointCount === 1"> · 目前只有一次记录</template></p>
          </div>
          <svg class="trend-sparkline" viewBox="0 0 100 48" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="42" x2="100" y2="42" />
            <polyline :points="sparklinePoints(item)" />
          </svg>
        </div>
        <div class="trend-range">
          <span>范围 {{ formatNumber(item.minValue) }} - {{ formatNumber(item.maxValue) }}{{ item.unit || "" }}</span>
          <span>{{ formatDate(item.firstDate) }} 至 {{ formatDate(item.lastDate) }}</span>
        </div>
        <div class="trend-points">
          <article v-for="point in recentPoints(item)" :key="`${item.name}-${point.reportId}-${point.observationId}`">
            <div>
              <strong>{{ pointValue(point, item.unit) }}<em class="trend-flag" :class="flagClass(point.abnormalFlag)">{{ abnormalLabel(point.abnormalFlag) }}</em></strong>
              <span>{{ formatDate(point.reportIssuedAt) }} · {{ point.hospitalName || "医院待整理" }}</span>
              <small v-if="point.referenceText">参考 {{ point.referenceText }}</small>
            </div>
            <button v-if="point.sourcePage" class="trend-source-button" type="button" title="查看指标所在页高清图" @click="openSourcePage(point, item)">原图</button>
            <button type="button" title="打开来源报告" @click="openReport(point.reportId)">
              <ChevronRight :size="18" />
            </button>
          </article>
        </div>
      </article>
    </div>
    <ReportDetailModal :open="Boolean(previewReportId)" :report-id="previewReportId" @close="previewReportId = null" @updated="reloadTrends" />
    <ImageViewer v-if="sourcePreview" :pages="sourceViewerPages" @close="closeSourcePage">
      <template #actions>
        <button type="button" title="打开来源报告详情" @click="openSourceReport"><FileText :size="18" /></button>
      </template>
    </ImageViewer>
  </section>
</template>
