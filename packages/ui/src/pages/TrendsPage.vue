<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Activity, ChartNoAxesCombined, ChevronRight, FileText, Search } from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import FormSelect from "../components/FormSelect.vue";
import ImageViewer, { type ImageViewerPage } from "../components/ImageViewer.vue";
import PullIndicator from "../components/PullIndicator.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { apiUrl, request } from "../utils/api";
import { useAppContext } from "../composables/useAppContext";
import { usePullRefresh } from "../composables/usePullRefresh";
import { useRefreshOnActivate } from "../composables/useRefreshOnActivate";
import { useToast } from "../composables/useToast";
import type { TrendExcludedPoint, TrendPoint, TrendSeries } from "../types/api";

const app = useAppContext();
const loading = ref(true);
const loadError = ref("");
const series = ref<TrendSeries[]>([]);
const query = ref("");
const groupFilter = ref("all");
const previewReportId = ref<string | null>(null);
const activeDetailKey = ref<string | null>(null);
const sourcePreview = ref<{
  point: TrendPoint | TrendExcludedPoint;
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

const groupOptions = [
  { value: "all", label: "全部分组" },
  { value: "blood", label: "血常规" },
  { value: "liver", label: "肝功能" },
  { value: "renal", label: "肾功能" },
  { value: "lipid", label: "血脂" },
  { value: "glucose", label: "血糖" },
  { value: "urine", label: "尿常规" },
  { value: "thyroid", label: "甲状腺" },
  { value: "ultrasound", label: "超声/影像" },
  { value: "infectious", label: "感染筛查" },
  { value: "other", label: "其他" }
];

const groupLabels = Object.fromEntries(groupOptions.map((item) => [item.value, item.label]));
const filteredSeries = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  return series.value.filter((item) => {
    const group = trendGroup(item);
    if (groupFilter.value !== "all" && group !== groupFilter.value) return false;
    if (!keyword) return true;
    return [item.name, item.sectionName, item.unit, ...item.sourceNames]
      .some((value) => value?.toLocaleLowerCase().includes(keyword));
  });
});
const filterSummary = computed(() => {
  if (!series.value.length) return "";
  const group = groupFilter.value === "all" ? "" : ` · ${groupLabels[groupFilter.value] || "当前分组"}`;
  const keyword = query.value.trim() ? ` · “${query.value.trim()}”` : "";
  return `显示 ${filteredSeries.value.length} / ${series.value.length} 项${group}${keyword}`;
});

async function load(memberId: string, silent = false) {
  if (!silent) loading.value = true;
  loadError.value = "";
  activeDetailKey.value = null;
  try { series.value = await request(`trends?memberId=${encodeURIComponent(memberId)}`); }
  catch (cause) {
    if (!silent) loadError.value = cause instanceof Error ? cause.message : "指标趋势加载失败";
    throw cause;
  }
  finally { if (!silent) loading.value = false; }
}

function retryLoad() {
  const memberId = app.selectedMemberId.value;
  if (memberId) load(memberId).catch(() => {});
}

function reloadTrends() {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  load(memberId, true).catch((cause) => console.warn("[health-records] 指标趋势后台刷新失败", cause));
}

useRefreshOnActivate(reloadTrends);

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

/* 部分报告的 resultText 已包含单位，避免 “89 mmHg mmHg” 重复展示 */
function excludedPointText(point: TrendExcludedPoint) {
  const result = (point.resultText || "").trim();
  const unit = (point.unit || "").trim();
  if (!result) return unit;
  if (!unit) return result;
  return result.toLowerCase().endsWith(unit.toLowerCase()) ? result : `${result} ${unit}`;
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

function qualityLabel(value: TrendSeries["quality"]) {
  return {
    high: "高可信",
    medium: "中可信",
    low: "低可信",
    excluded: "未纳入",
    raw: "原始展示"
  }[value] || "原始展示";
}

function trendGroup(item: TrendSeries) {
  const text = [item.sectionName, item.name, ...item.sourceNames].filter(Boolean).join(" ").toLocaleLowerCase();
  if (/血常规|血液常规|全血|白细胞|红细胞|血红蛋白|血小板|中性粒|淋巴|单核|嗜酸|嗜碱|cbc/.test(text)) return "blood";
  if (/肝功能|谷丙|谷草|转氨酶|胆红素|白蛋白|球蛋白|总蛋白|碱性磷酸酶|谷氨酰|肝/.test(text)) return "liver";
  if (/肾功能|肌酐|尿素|尿酸|胱抑素|肾小球|肾/.test(text)) return "renal";
  if (/血脂|胆固醇|甘油三酯|低密度|高密度|载脂蛋白|脂蛋白/.test(text)) return "lipid";
  if (/血糖|葡萄糖|糖化血红蛋白|胰岛素|c肽|glu|hba1c/.test(text)) return "glucose";
  if (/尿常规|尿液|尿蛋白|尿糖|尿酮|尿胆|尿潜血|尿比重|尿ph|白细胞酯酶/.test(text)) return "urine";
  if (/甲状腺|tsh|游离三碘|游离甲状腺素|甲状腺素|促甲状腺|甲功/.test(text)) return "thyroid";
  if (/超声|影像|彩超|ct|磁共振|mri|dr|x线|结节|斑块|脂肪肝|钙化灶|内膜|卵巢|子宫/.test(text)) return "ultrasound";
  if (/乙肝|丙肝|梅毒|艾滋|hiv|hbsag|抗体|抗原|病毒|dna|rna|感染/.test(text)) return "infectious";
  return "other";
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

function seriesKey(item: TrendSeries) {
  return `${item.name}\u0000${item.unit || ""}`;
}

function detailsOpen(item: TrendSeries) {
  return activeDetailKey.value === seriesKey(item);
}

function toggleDetails(item: TrendSeries) {
  const key = seriesKey(item);
  activeDetailKey.value = activeDetailKey.value === key ? null : key;
}

function openReport(reportId: string) {
  activeDetailKey.value = null;
  previewReportId.value = reportId;
}

function openSourcePage(point: TrendPoint | TrendExcludedPoint, item: TrendSeries) {
  activeDetailKey.value = null;
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
  load(memberId).catch(() => {});
}, { immediate: true });

watch([query, groupFilter], () => {
  activeDetailKey.value = null;
});
</script>

<template>
  <section ref="root" class="plain-page">
    <div class="page-intro"><div><h2>指标趋势</h2><p>仅比较相同指标和兼容单位</p></div><span class="page-intro-badge"><ChartNoAxesCombined :size="22" /></span></div>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />
    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <p v-else-if="loadError" class="inline-panel-error">
      {{ loadError }}<button class="error-retry" type="button" @click="retryLoad">重试</button>
    </p>
    <EmptyState v-else-if="!series.length" title="暂无可比较指标" description="AI 整理出结构化数值后，这里会展示单次基线值和多次趋势。" />
    <template v-else>
      <div class="trend-filter-row">
        <label class="search-field trend-search-field">
          <Search :size="18" />
          <input v-model="query" placeholder="搜索指标名" />
        </label>
        <FormSelect v-model="groupFilter" class="trend-group-select records-filter-select" :options="groupOptions" aria-label="类型分组" />
      </div>
      <p class="trend-filter-summary">{{ filterSummary }}</p>
      <EmptyState
        v-if="!filteredSeries.length"
        title="没有符合条件的指标"
        description="换个指标名或类型分组试试，也可以等待更多报告完成整理。"
      />
      <div v-else class="trend-list">
        <article v-for="item in filteredSeries" :key="`${item.name}-${item.unit}`" class="trend-card">
          <header class="trend-card-header">
            <span class="item-icon"><Activity :size="19" /></span>
            <div>
              <div class="trend-title-row">
                <strong>{{ item.name }}</strong>
                <em class="trend-delta" :class="deltaClass(item)">{{ deltaText(item) }}</em>
              </div>
              <span>{{ item.sectionName || "未分组" }} · {{ item.pointCount }} 个数据点 · {{ item.unit || "无单位" }} · {{ qualityLabel(item.quality) }}</span>
            </div>
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
            <div class="trend-range-copy">
              <span>范围 {{ formatNumber(item.minValue) }} - {{ formatNumber(item.maxValue) }}{{ item.unit || "" }}</span>
              <span>{{ formatDate(item.firstDate) }} 至 {{ formatDate(item.lastDate) }}</span>
            </div>
            <div class="trend-detail-popover-wrap">
              <button
                class="trend-detail-toggle"
                type="button"
                :aria-expanded="detailsOpen(item)"
                @click="toggleDetails(item)"
              >
                整理详情
                <template v-if="item.excludedPoints.length"> · {{ item.excludedPoints.length }}</template>
              </button>
              <section v-if="detailsOpen(item)" class="trend-normalization-popover">
                <div v-if="item.explanation">
                  <span>指标说明</span>
                  <p>{{ item.explanation }}</p>
                </div>
                <div>
                  <span>整理依据</span>
                  <p v-if="item.matchReasons.length">{{ item.matchReasons.join("；") }}</p>
                  <p v-else>按原始名称和单位展示。</p>
                </div>
                <div>
                  <span>已纳入名称</span>
                  <p>{{ item.sourceNames.length ? item.sourceNames.join("、") : "暂无" }}</p>
                </div>
                <div v-if="item.excludedPoints.length">
                  <span>相似但未纳入</span>
                  <article v-for="point in item.excludedPoints" :key="point.observationId" class="trend-excluded-point">
                    <div>
                      <strong>{{ point.itemName }} · {{ excludedPointText(point) }}</strong>
                      <small>{{ formatDate(point.reportIssuedAt) }} · {{ point.hospitalName || "医院待整理" }} · {{ point.reason }}</small>
                    </div>
                    <button v-if="point.sourcePage" type="button" @click="openSourcePage(point, item)">原图</button>
                    <button type="button" @click="openReport(point.reportId)">报告</button>
                  </article>
                </div>
                <p v-else class="preview-hint">暂无被系统保守排除的相似指标。</p>
              </section>
            </div>
          </div>
          <div class="trend-points">
            <article v-for="point in recentPoints(item)" :key="`${item.name}-${point.reportId}-${point.observationId}`">
              <div>
                <strong>{{ pointValue(point, item.unit) }}<em v-if="point.abnormalFlag" class="trend-flag" :class="flagClass(point.abnormalFlag)">{{ abnormalLabel(point.abnormalFlag) }}</em></strong>
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
    </template>
    <ReportDetailModal :open="Boolean(previewReportId)" :report-id="previewReportId" @close="previewReportId = null" @updated="reloadTrends" />
    <ImageViewer v-if="sourcePreview" :pages="sourceViewerPages" @close="closeSourcePage">
      <template #actions>
        <button type="button" title="打开来源报告详情" @click="openSourceReport"><FileText :size="18" /></button>
      </template>
    </ImageViewer>
  </section>
</template>
