<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  Activity,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  FileText,
  Pin,
  Search,
  X
} from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import FormSelect from "../components/FormSelect.vue";
import ImageViewer, { type ImageViewerPage } from "../components/ImageViewer.vue";
import PullIndicator from "../components/PullIndicator.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { apiUrl, request } from "../utils/api";
import { matchTrendSearch } from "../utils/trends";
import { useAppContext } from "../composables/useAppContext";
import { usePullRefresh } from "../composables/usePullRefresh";
import { useRefreshOnActivate } from "../composables/useRefreshOnActivate";
import { useToast } from "../composables/useToast";
import type { TrendExcludedPoint, TrendPoint, TrendSeries } from "../types/api";

const app = useAppContext();
const route = useRoute();
const loading = ref(true);
const loadError = ref("");
const series = ref<TrendSeries[]>([]);
const query = ref("");
const groupFilter = ref("all");
const attentionFilter = ref<"all" | "attention" | "abnormal" | "near_boundary" | "unflagged">("all");
const collapsedGroups = ref(new Set<string>());
const detailPopoverStyle = ref<Record<string, string>>({});
const detailPopoverPlacement = ref<"above" | "below">("below");
const previewReportId = ref<string | null>(null);
const activeDetailKey = ref<string | null>(null);
const pinPendingKeys = ref(new Set<string>());
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

const groupOptions = computed(() => [
  { value: "all", label: "全部分组" },
  ...Array.from(new Map(
    [...series.value]
      .sort(compareTrendSeries)
      .map((item) => [item.groupKey, { value: item.groupKey, label: item.groupName }])
  ).values())
]);
const groupLabels = computed(() => Object.fromEntries(groupOptions.value.map((item) => [item.value, item.label])));
const attentionOptions = [
  { value: "all", label: "全部状态" },
  { value: "attention", label: "需要关注" },
  { value: "abnormal", label: "报告已标异常" },
  { value: "near_boundary", label: "接近参考边界" },
  { value: "unflagged", label: "未列入关注" }
];

function matchingAlias(item: TrendSeries) {
  return matchTrendSearch(item, query.value).alias;
}

const filteredSeries = computed(() => {
  return series.value.filter((item) => {
    if (groupFilter.value !== "all" && item.groupKey !== groupFilter.value) return false;
    if (attentionFilter.value === "attention" && !item.attentionLevel) return false;
    if (attentionFilter.value === "unflagged" && item.attentionLevel) return false;
    if (
      attentionFilter.value !== "all"
      && attentionFilter.value !== "attention"
      && attentionFilter.value !== "unflagged"
      && item.attentionLevel !== attentionFilter.value
    ) return false;
    return matchTrendSearch(item, query.value).matches;
  });
});

type TrendSection = {
  key: string;
  name: string;
  order: number;
  pinned: boolean;
  items: TrendSeries[];
  abnormalCount: number;
  subgroups: Array<{ key: string; name: string; order: number; items: TrendSeries[] }>;
};

const trendSections = computed<TrendSection[]>(() => {
  const result: TrendSection[] = [];
  const pinned = filteredSeries.value.filter((item) => item.pinned).sort(compareTrendSeries);
  if (pinned.length) {
    result.push({
      key: "pinned",
      name: "我的关注",
      order: 0,
      pinned: true,
      items: pinned,
      abnormalCount: pinned.filter((item) => item.attentionLevel === "abnormal").length,
      subgroups: []
    });
  }
  const standardItems = filteredSeries.value.filter((item) => !item.pinned);
  const grouped = new Map<string, TrendSection>();
  for (const item of standardItems) {
    if (!grouped.has(item.groupKey)) {
      grouped.set(item.groupKey, {
        key: item.groupKey,
        name: item.groupName,
        order: item.groupOrder,
        pinned: false,
        items: [],
        abnormalCount: 0,
        subgroups: []
      });
    }
    const section = grouped.get(item.groupKey)!;
    section.items.push(item);
    if (item.attentionLevel === "abnormal") section.abnormalCount += 1;
  }
  for (const section of grouped.values()) {
    section.items.sort(compareTrendSeries);
    if (section.key === "laboratory") {
      const subgroups = new Map<string, { key: string; name: string; order: number; items: TrendSeries[] }>();
      for (const item of section.items) {
        const key = item.subgroupKey || "laboratory_other";
        if (!subgroups.has(key)) {
          subgroups.set(key, {
            key,
            name: item.subgroupName || "其他检验",
            order: item.subgroupOrder,
            items: []
          });
        }
        subgroups.get(key)!.items.push(item);
      }
      section.subgroups = [...subgroups.values()].sort((left, right) => left.order - right.order);
    }
    result.push(section);
  }
  return result.sort((left, right) => left.order - right.order);
});

const hasActiveFilters = computed(() =>
  Boolean(query.value.trim()) || groupFilter.value !== "all" || attentionFilter.value !== "all"
);

const trendCountSubtitle = computed(() => {
  if (!series.value.length) return "";
  const pointCount = series.value.reduce((sum, item) => sum + item.pointCount, 0);
  return `共 ${series.value.length} 项指标${pointCount ? ` · ${pointCount} 个数据点` : ""}`;
});

const filterSummary = computed(() => {
  if (!series.value.length) return "";
  const group = groupFilter.value === "all" ? "" : ` · ${groupLabels.value[groupFilter.value] || "当前分组"}`;
  const keyword = query.value.trim() ? ` · “${query.value.trim()}”` : "";
  const attention = attentionFilter.value === "abnormal"
    ? " · 报告已标异常"
    : attentionFilter.value === "near_boundary"
      ? " · 接近参考边界"
      : attentionFilter.value === "attention"
        ? " · 需要关注"
        : attentionFilter.value === "unflagged" ? " · 未列入关注" : "";
  return `显示 ${filteredSeries.value.length} / ${series.value.length} 项${group}${attention}${keyword}`;
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

function compareTrendSeries(left: TrendSeries, right: TrendSeries) {
  return Number(right.pinned) - Number(left.pinned)
    || left.groupOrder - right.groupOrder
    || left.subgroupOrder - right.subgroupOrder
    || left.itemOrder - right.itemOrder
    || left.name.localeCompare(right.name, "zh-CN")
    || String(left.unit || "").localeCompare(String(right.unit || ""), "zh-CN");
}

function trendPinRequestKey(memberId: string, item: TrendSeries) {
  return `${memberId}\u0000${item.indicatorKey}\u0000${item.unit || ""}`;
}

function pinPending(item: TrendSeries) {
  const memberId = app.selectedMemberId.value;
  return Boolean(memberId && pinPendingKeys.value.has(trendPinRequestKey(memberId, item)));
}

function setPinPending(key: string, pending: boolean) {
  const next = new Set(pinPendingKeys.value);
  if (pending) next.add(key);
  else next.delete(key);
  pinPendingKeys.value = next;
}

async function toggleTrendPin(item: TrendSeries) {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  const requestKey = trendPinRequestKey(memberId, item);
  if (pinPendingKeys.value.has(requestKey)) return;
  setPinPending(requestKey, true);
  try {
    const result = await request<{ pinned: boolean }>("trends/pins", {
      method: item.pinned ? "DELETE" : "POST",
      body: JSON.stringify({
        memberId,
        indicatorKey: item.indicatorKey,
        unit: item.unit
      })
    });
    if (app.selectedMemberId.value !== memberId) return;
    const current = series.value.find((candidate) =>
      candidate.indicatorKey === item.indicatorKey && (candidate.unit || "") === (item.unit || "")
    );
    if (current) current.pinned = result.pinned;
    series.value = [...series.value].sort(compareTrendSeries);
    toast.show(result.pinned ? `已置顶“${item.name}”` : `已取消置顶“${item.name}”`);
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "指标置顶操作失败");
  } finally {
    setPinPending(requestKey, false);
  }
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

function latestPoint(item: TrendSeries) {
  return item.points[item.points.length - 1] || null;
}

function referenceSummary(point: TrendPoint | null) {
  if (!point) return "参考范围待整理";
  if (point.referenceText) return `参考 ${point.referenceText}`;
  if (point.referenceLow !== null && point.referenceHigh !== null) {
    return `参考 ${formatNumber(point.referenceLow)} - ${formatNumber(point.referenceHigh)}`;
  }
  if (point.referenceHigh !== null) return `参考 ≤ ${formatNumber(point.referenceHigh)}`;
  if (point.referenceLow !== null) return `参考 ≥ ${formatNumber(point.referenceLow)}`;
  return "参考范围待整理";
}

function trendValueRange(item: TrendSeries) {
  if (item.pointCount < 2 || item.minValue === null || item.maxValue === null) return null;
  if (item.minValue === item.maxValue) return null;
  return `${formatNumber(item.minValue)} - ${formatNumber(item.maxValue)}${item.unit || ""}`;
}

function trendDateRange(item: TrendSeries) {
  if (item.pointCount < 2 || !item.firstDate || !item.lastDate) return null;
  const first = formatDate(item.firstDate);
  const last = formatDate(item.lastDate);
  return first !== last ? `${first} 至 ${last}` : null;
}

function cardDomId(item: TrendSeries) {
  const value = seriesKey(item);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `trend-card-${(hash >>> 0).toString(36)}`;
}

function sectionClusters(section: TrendSection) {
  return section.subgroups.length
    ? section.subgroups
    : [{ key: `${section.key}-all`, name: "", order: 0, items: section.items }];
}

function groupExpanded(section: TrendSection) {
  return Boolean(query.value.trim() || attentionFilter.value !== "all")
    || !collapsedGroups.value.has(section.key);
}

function toggleGroup(section: TrendSection) {
  const next = new Set(collapsedGroups.value);
  if (next.has(section.key)) next.delete(section.key);
  else next.add(section.key);
  collapsedGroups.value = next;
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

function trendChartPoints(item: TrendSeries) {
  const values = item.points.map((point) => point.numericValue);
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return item.points.map((point, index) => ({
    point,
    x: values.length === 1 ? 50 : 12 + (index / (values.length - 1)) * 76,
    y: values.length === 1 ? 46 : 62 - ((point.numericValue - min) / span) * 34
  }));
}

function trendChartPolyline(item: TrendSeries) {
  return trendChartPoints(item)
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
}

function trendChartMinWidth(item: TrendSeries) {
  return `${Math.max(320, item.points.length * 88)}px`;
}

function trendNodeLabel(point: TrendPoint, item: TrendSeries) {
  return `${item.name} ${pointValue(point, item.unit)}，${formatDate(point.reportIssuedAt)}，点击查看来源`;
}

function recentPoints(item: TrendSeries) {
  return [...item.points].reverse().slice(0, 6);
}

function seriesKey(item: TrendSeries) {
  return `${item.indicatorKey}\u0000${item.unit || ""}`;
}

function detailsOpen(item: TrendSeries) {
  return activeDetailKey.value === seriesKey(item);
}

function closeDetails() {
  activeDetailKey.value = null;
  detailPopoverStyle.value = {};
}

function toggleDetails(item: TrendSeries, event: MouseEvent) {
  const key = seriesKey(item);
  if (activeDetailKey.value === key) {
    closeDetails();
    return;
  }

  const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  const horizontalMargin = mobile ? 12 : 16;
  const topInset = mobile ? 70 : 12;
  const bottomInset = mobile ? 82 : 12;
  const gap = 8;
  const width = Math.min(360, window.innerWidth - horizontalMargin * 2);
  const preferredHeight = Math.min(mobile ? 560 : 420, window.innerHeight * (mobile ? 0.66 : 0.62));
  const availableBelow = window.innerHeight - bottomInset - anchor.bottom - gap;
  const availableAbove = anchor.top - topInset - gap;
  const placement = availableBelow >= Math.min(preferredHeight, 260) || availableBelow >= availableAbove
    ? "below"
    : "above";
  const availableHeight = placement === "below" ? availableBelow : availableAbove;
  const maxHeight = Math.max(96, Math.min(preferredHeight, availableHeight));
  const left = Math.max(
    horizontalMargin,
    Math.min(anchor.right - width, window.innerWidth - horizontalMargin - width)
  );

  detailPopoverPlacement.value = placement;
  detailPopoverStyle.value = {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
    ...(placement === "below"
      ? { top: `${anchor.bottom + gap}px`, bottom: "auto" }
      : { top: "auto", bottom: `${window.innerHeight - anchor.top + gap}px` })
  };
  activeDetailKey.value = key;
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

watch([query, groupFilter, attentionFilter], () => {
  closeDetails();
});

watch(trendCountSubtitle, (subtitle) => app.setTopbarSubtitle("trends", subtitle), { immediate: true });

function activateTopbarSearch() {
  app.setTopbarSearch({
    key: "trends",
    model: query,
    placeholder: "搜索指标",
    expandedPlaceholder: "搜索指标名称"
  });
}

function nextRouteUsesTopbarSearch() {
  return route.path === "/records" || route.path === "/trends" || route.path.startsWith("/trends/");
}

onMounted(() => {
  window.addEventListener("resize", closeDetails, { passive: true });
  activateTopbarSearch();
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", closeDetails);
  app.clearTopbarSubtitle("trends");
  app.clearTopbarSearch("trends");
});
onActivated(() => {
  app.setTopbarSubtitle("trends", trendCountSubtitle.value);
  activateTopbarSearch();
});
onDeactivated(() => {
  if (!nextRouteUsesTopbarSearch()) app.clearTopbarSearch("trends");
});
</script>

<template>
  <section ref="root" class="plain-page">
    <div class="page-intro"><div><h2>指标趋势</h2><p>仅比较相同指标和兼容单位</p></div><span class="page-intro-badge"><ChartNoAxesCombined :size="22" /></span></div>
    <nav class="trend-view-switch" aria-label="趋势视图">
      <RouterLink to="/trends" aria-current="page">指标趋势</RouterLink>
      <RouterLink to="/trends/morphology">形态变化</RouterLink>
    </nav>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />
    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <p v-else-if="loadError" class="inline-panel-error">
      {{ loadError }}<button class="error-retry" type="button" @click="retryLoad">重试</button>
    </p>
    <EmptyState v-else-if="!series.length" title="暂无可比较指标" description="AI 整理出结构化数值后，这里会展示单次基线值和多次趋势。" />
    <template v-else>
      <div class="trend-filter-row">
        <label class="search-field trend-search-field page-search-field">
          <Search :size="18" />
          <input v-model="query" placeholder="搜索指标名" />
        </label>
        <FormSelect v-model="groupFilter" class="trend-group-select records-filter-select" :options="groupOptions" aria-label="体检分组" />
        <FormSelect v-model="attentionFilter" class="trend-status-select records-filter-select" :options="attentionOptions" aria-label="指标状态" />
      </div>
      <p v-if="hasActiveFilters" class="trend-filter-summary">{{ filterSummary }}</p>
      <EmptyState
        v-if="!filteredSeries.length"
        title="没有符合条件的指标"
        description="换个指标名、体检分组或指标状态试试，也可以等待更多报告完成整理。"
      />
      <div v-else class="trend-sections">
        <section v-for="section in trendSections" :key="section.key" class="trend-section">
          <button
            class="trend-section-header"
            type="button"
            :aria-expanded="groupExpanded(section)"
            @click="toggleGroup(section)"
          >
            <span>
              <Pin v-if="section.pinned" :size="18" fill="currentColor" />
              <strong>{{ section.name }}</strong>
              <small>{{ section.items.length }} 项</small>
              <em v-if="section.abnormalCount">{{ section.abnormalCount }} 项异常</em>
            </span>
            <ChevronDown :size="19" :class="{ collapsed: !groupExpanded(section) }" />
          </button>
          <div v-if="groupExpanded(section)" class="trend-section-body">
            <section v-for="cluster in sectionClusters(section)" :key="cluster.key" class="trend-subsection">
              <h3 v-if="cluster.name">{{ cluster.name }}<small>{{ cluster.items.length }} 项</small></h3>
              <div class="trend-list">
                <article
                  v-for="item in cluster.items"
                  :id="cardDomId(item)"
                  :key="`${item.indicatorKey}-${item.unit}`"
                  class="trend-card"
                  :class="item.attentionLevel ? ['attention', item.attentionLevel] : []"
                >
          <header class="trend-card-header">
            <span class="item-icon"><Activity :size="19" /></span>
            <div>
              <div class="trend-title-row">
                <strong>{{ item.name }}</strong>
                <em class="trend-delta" :class="deltaClass(item)">{{ deltaText(item) }}</em>
              </div>
              <span>{{ item.pointCount }} 个数据点 · {{ item.unit || "无单位" }} · {{ qualityLabel(item.quality) }}</span>
              <small v-if="matchingAlias(item)" class="trend-match-alias">匹配名称：{{ matchingAlias(item) }}</small>
            </div>
            <button
              class="trend-pin-button"
              :class="{ active: item.pinned }"
              type="button"
              :disabled="pinPending(item)"
              :title="item.pinned ? '取消置顶' : '置顶指标'"
              :aria-label="`${item.pinned ? '取消置顶' : '置顶'}${item.name}`"
              :aria-pressed="item.pinned"
              @click="toggleTrendPin(item)"
            >
              <Pin :size="17" :fill="item.pinned ? 'currentColor' : 'none'" />
            </button>
          </header>
          <div class="trend-main">
            <div class="trend-latest">
              <span>最新值</span>
              <strong>{{ formatNumber(item.latestValue) }}<small v-if="item.unit">{{ item.unit }}</small></strong>
              <p>{{ formatDate(item.lastDate) }}<template v-if="item.pointCount === 1"> · 目前只有一次记录</template></p>
            </div>
            <div class="trend-chart-scroll">
              <div class="trend-chart-canvas" :style="{ minWidth: trendChartMinWidth(item) }">
                <svg class="trend-sparkline" viewBox="0 0 100 96" preserveAspectRatio="none" aria-hidden="true">
                  <line x1="4" y1="64" x2="96" y2="64" />
                  <polyline :points="trendChartPolyline(item)" />
                </svg>
                <button
                  v-for="chartPoint in trendChartPoints(item)"
                  :key="chartPoint.point.observationId"
                  class="trend-chart-node"
                  :class="{ latest: chartPoint.point === item.points[item.points.length - 1] }"
                  type="button"
                  :style="{ left: `${chartPoint.x}%`, '--point-y': `${chartPoint.y}%` }"
                  :aria-label="trendNodeLabel(chartPoint.point, item)"
                  @click="openSourcePage(chartPoint.point, item)"
                >
                  <span class="trend-chart-value">{{ formatNumber(chartPoint.point.numericValue) }}</span>
                  <i :class="flagClass(chartPoint.point.abnormalFlag)"></i>
                  <time>{{ formatDate(chartPoint.point.reportIssuedAt) }}</time>
                </button>
              </div>
            </div>
          </div>
          <div class="trend-range">
            <div v-if="trendValueRange(item) || trendDateRange(item)" class="trend-range-copy">
              <span v-if="trendValueRange(item)">变化区间 {{ trendValueRange(item) }}</span>
              <span v-if="trendDateRange(item)">{{ trendDateRange(item) }}</span>
            </div>
            <div class="trend-detail-popover-wrap">
              <button
                class="trend-detail-toggle"
                type="button"
                :aria-expanded="detailsOpen(item)"
                @click="toggleDetails(item, $event)"
              >
                整理详情
                <template v-if="item.excludedPoints.length"> · {{ item.excludedPoints.length }}</template>
              </button>
              <Teleport to="body">
                <div v-if="detailsOpen(item)" class="trend-detail-popover-backdrop" @click="closeDetails"></div>
                <section
                  v-if="detailsOpen(item)"
                  class="trend-normalization-popover"
                  :class="`placement-${detailPopoverPlacement}`"
                  :style="detailPopoverStyle"
                  role="dialog"
                  aria-label="指标整理详情"
                  @click.stop
                >
                  <header class="trend-normalization-popover-header">
                    <strong>整理详情</strong>
                    <button type="button" title="关闭" aria-label="关闭整理详情" @click="closeDetails">
                      <X :size="17" />
                    </button>
                  </header>
                  <div>
                    <span>指标说明</span>
                    <p>{{ item.explanation || "暂未形成可靠说明，可查看原报告或等待指标字典更新。" }}</p>
                  </div>
                  <div>
                    <span>本次结果</span>
                    <p>
                      {{ formatNumber(item.latestValue) }}{{ item.unit || "" }}
                      · {{ referenceSummary(latestPoint(item)) }}
                      <template v-if="item.attentionReason"> · {{ item.attentionReason }}</template>
                    </p>
                  </div>
                  <p class="trend-detail-part-title">系统整理信息</p>
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
                </section>
              </Teleport>
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
            </section>
          </div>
        </section>
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
