<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Database, Download, FileClock, LoaderCircle, RefreshCw, Trash2 } from "@lucide/vue";
import BackToTop from "../../components/BackToTop.vue";
import PullIndicator from "../../components/PullIndicator.vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { useConfirm } from "../../composables/useConfirm";
import { usePullRefresh } from "../../composables/usePullRefresh";
import { useToast } from "../../composables/useToast";
import type { SystemLogItem, SystemLogPage } from "../../types/api";
import { request } from "../../utils/api";
import { downloadFile } from "../../utils/download";
import { formatDatabaseTime } from "../../utils/time";

const PAGE_SIZE = 30;
const root = ref<HTMLElement | null>(null);
const sentinel = ref<HTMLElement | null>(null);
const logs = ref<SystemLogItem[]>([]);
const stats = ref<SystemLogPage["stats"] | null>(null);
const filter = ref<"important" | "all">("important");
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
const exportingDiagnostics = ref(false);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
let observer: IntersectionObserver | null = null;
let seq = 0;
const toast = useToast();
const confirmDialog = useConfirm();

const hasLogs = computed(() => logs.value.length > 0);

function byteText(value: number | null | undefined) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function levelText(level: SystemLogItem["level"]) {
  return level === "error" ? "错误" : level === "warn" ? "警告" : "信息";
}

async function load(reset = true) {
  let current = seq;
  if (reset) {
    current = ++seq;
    loading.value = true;
    nextCursor.value = null;
  } else {
    if (loading.value || loadingMore.value || !hasMore.value || !nextCursor.value) return true;
    current = seq;
    loadingMore.value = true;
  }
  error.value = "";
  try {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      filter: filter.value
    });
    if (!reset && nextCursor.value) params.set("cursor", nextCursor.value);
    const page = await request<SystemLogPage>(`audit/system?${params.toString()}`);
    if (current !== seq) return true;
    logs.value = reset
      ? page.items
      : [...logs.value, ...page.items.filter((item) => !logs.value.some((log) => log.id === item.id))];
    stats.value = page.stats;
    nextCursor.value = page.nextCursor;
    hasMore.value = page.hasMore;
    return true;
  } catch (cause) {
    if (current === seq) error.value = cause instanceof Error ? cause.message : "系统日志加载失败";
    return false;
  } finally {
    if (current === seq) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

const { pullDistance, refreshing, refresh } = usePullRefresh(root, async () => {
  const succeeded = await load(true);
  toast.show(succeeded ? "系统日志已刷新" : "刷新失败，请稍后重试");
});

function clearLogs() {
  if (!stats.value?.fileCount) return;
  confirmDialog.ask({
    title: "清理系统日志",
    message: `将删除当前运行日志和 ${stats.value.archiveCount} 个归档文件，释放约 ${byteText(stats.value.totalBytes)}。OCR 安装诊断日志不会被删除。`,
    confirmText: "清理日志",
    danger: true,
    run: async () => {
      const result = await request<{ deletedFiles: number; freedBytes: number }>("audit/system", { method: "DELETE" });
      await load(true);
      toast.show(`已清理 ${result.deletedFiles} 个日志文件，释放 ${byteText(result.freedBytes)}`);
    }
  });
}

async function exportDiagnostics() {
  if (exportingDiagnostics.value) return;
  exportingDiagnostics.value = true;
  try {
    await downloadFile("audit/system/diagnostics", "fnos-app-health-records-diagnostics.tar.gz");
    toast.show("诊断包已导出");
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "诊断包导出失败", 3600);
  } finally {
    exportingDiagnostics.value = false;
  }
}

function attachObserver(element: HTMLElement | null) {
  observer?.disconnect();
  observer = null;
  if (!element) return;
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void load(false);
  }, { rootMargin: "260px 0px", threshold: 0.01 });
  observer.observe(element);
}

watch(filter, () => {
  void load(true);
});
watch(sentinel, (element) => attachObserver(element));

onMounted(async () => {
  await load(true);
  attachObserver(sentinel.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section ref="root" class="settings-page system-logs-page">
    <SubPageHeader title="系统日志" description="应用运行异常、接口失败与日志占用">
      <button class="icon-button" type="button" title="刷新" :disabled="loading || refreshing" @click="refresh">
        <RefreshCw :size="17" :class="{ 'spin-icon': loading || refreshing }" />
      </button>
    </SubPageHeader>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />

    <section class="settings-band system-log-summary">
      <header>
        <Database :size="20" />
        <div><h3>运行日志占用</h3><p>达到单文件上限后自动轮转，超出保留数量的旧归档自动删除</p></div>
        <div class="maintenance-actions system-log-actions">
          <button class="header-action" type="button" :disabled="exportingDiagnostics" @click="exportDiagnostics">
            <LoaderCircle v-if="exportingDiagnostics" :size="15" class="spin-icon" />
            <Download v-else :size="15" />
            {{ exportingDiagnostics ? "正在导出" : "导出诊断包" }}
          </button>
          <button
            class="header-action system-log-clear"
            type="button"
            :disabled="loading || !stats?.fileCount"
            @click="clearLogs"
          >
            <Trash2 :size="15" />清理
          </button>
        </div>
      </header>
      <div class="system-log-stats">
        <div><span>当前占用</span><strong>{{ byteText(stats?.totalBytes) }}</strong></div>
        <div><span>单文件上限</span><strong>{{ byteText(stats?.maxFileBytes) }}</strong></div>
        <div><span>归档文件</span><strong>{{ stats?.archiveCount || 0 }} / {{ stats?.maxArchiveFiles || 0 }}</strong></div>
        <div><span>保留上限</span><strong>{{ byteText(stats?.maxTotalBytes) }}</strong></div>
      </div>
    </section>

    <section class="settings-band dense-audit-card system-log-list-card">
      <header class="system-log-toolbar">
        <FileClock :size="20" />
        <div><h3>日志明细</h3><p>按时间倒序展示，诊断内容已脱敏</p></div>
        <div class="system-log-filter" role="group" aria-label="日志范围">
          <button type="button" :class="{ active: filter === 'important' }" @click="filter = 'important'">异常</button>
          <button type="button" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部</button>
        </div>
      </header>
      <p v-if="error" class="inline-panel-error">{{ error }}</p>
      <div v-if="loading && !hasLogs" class="loading-list audit-loading"><span v-for="index in 6" :key="index"></span></div>
      <div v-else-if="!hasLogs" class="preview-hint">
        {{ filter === "important" ? "暂无异常运行日志。" : "暂无运行日志。" }}
      </div>
      <div v-else class="system-log-list">
        <article v-for="item in logs" :key="item.id" :class="`system-log-item--${item.level}`">
          <div class="system-log-main">
            <header>
              <span class="system-log-level">{{ levelText(item.level) }}</span>
              <strong>{{ item.title }}</strong>
              <time>{{ formatDatabaseTime(item.timestamp) }}</time>
            </header>
            <p v-if="item.detail">{{ item.detail }}</p>
            <small>
              <span>{{ item.category }}</span>
              <span v-for="meta in item.metadata" :key="meta">{{ meta }}</span>
            </small>
          </div>
        </article>
      </div>
      <div ref="sentinel" class="load-more-indicator" aria-live="polite">
        <template v-if="loadingMore"><LoaderCircle :size="18" class="spin-icon" /><span>正在加载更多…</span></template>
        <template v-else-if="hasMore"><span>继续下滑加载更多</span></template>
        <template v-else-if="hasLogs"><span>已加载全部日志</span></template>
      </div>
    </section>
    <BackToTop />
  </section>
</template>
