<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { LoaderCircle, RefreshCw } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import PullIndicator from "../../components/PullIndicator.vue";
import { request } from "../../utils/api";
import { formatDatabaseTime } from "../../utils/time";
import type { CursorPage, UserOperationAuditLog } from "../../types/api";
import { usePullRefresh } from "../../composables/usePullRefresh";
import { useToast } from "../../composables/useToast";

const PAGE_SIZE = 30;
const root = ref<HTMLElement | null>(null);
const sentinel = ref<HTMLElement | null>(null);
const logs = ref<UserOperationAuditLog[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
let observer: IntersectionObserver | null = null;
let seq = 0;
const toast = useToast();

function shortId(value: string | null) {
  if (!value) return "—";
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function targetText(item: UserOperationAuditLog) {
  if (!item.targetName && !item.targetId) return "";
  return `${item.targetLabel} ${item.targetName || shortId(item.targetId)}`;
}

function summaryText(item: UserOperationAuditLog) {
  return item.description && item.description !== item.title ? item.description : "";
}

function metaText(item: UserOperationAuditLog) {
  const parts = [`操作人：${item.actorName || "系统"}`];
  const target = targetText(item);
  if (target) parts.push(`对象：${target}`);
  return parts.join(" · ");
}

async function load(reset = true) {
  let current = seq;
  if (reset) {
    current = ++seq;
    loading.value = true;
    nextCursor.value = null;
  } else {
    if (loadingMore.value || !hasMore.value || !nextCursor.value) return;
    current = seq;
    loadingMore.value = true;
  }
  error.value = "";
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (!reset && nextCursor.value) params.set("cursor", nextCursor.value);
    const page = await request<CursorPage<UserOperationAuditLog>>(`audit/user?${params.toString()}`);
    if (current !== seq) return;
    logs.value = reset ? page.items : [...logs.value, ...page.items.filter((item) => !logs.value.some((log) => log.id === item.id))];
    nextCursor.value = page.nextCursor;
    hasMore.value = page.hasMore;
  } catch (cause) {
    if (current === seq) error.value = cause instanceof Error ? cause.message : "日志加载失败";
  } finally {
    if (current === seq) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

const { pullDistance, refreshing, refresh } = usePullRefresh(root, async () => {
  await load(true);
  toast.show("日志已刷新");
});

function attachObserver(element: HTMLElement | null) {
  observer?.disconnect();
  observer = null;
  if (!element) return;
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void load(false);
  }, { rootMargin: "260px 0px", threshold: 0.01 });
  observer.observe(element);
}

onMounted(async () => {
  await load(true);
  attachObserver(sentinel.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section ref="root" class="settings-page audit-page">
    <SubPageHeader title="用户操作日志" description="按时间倒序记录报告、成员、提醒、备份和维护操作">
      <button class="icon-button" type="button" title="刷新" :disabled="loading || refreshing" @click="refresh">
        <RefreshCw :size="17" :class="{ 'spin-icon': loading || refreshing }" />
      </button>
    </SubPageHeader>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />

    <section class="settings-band dense-audit-card">
      <p v-if="error" class="inline-panel-error">{{ error }}</p>
      <div v-if="loading && !logs.length" class="loading-list audit-loading"><span v-for="index in 6" :key="index"></span></div>
      <div v-else-if="!logs.length" class="preview-hint">暂无用户操作日志。</div>
      <div v-else class="audit-dense-list">
        <article v-for="item in logs" :key="item.id">
          <div>
            <header><strong>{{ item.title }}</strong><time>{{ formatDatabaseTime(item.createdAt) }}</time></header>
            <span v-if="summaryText(item)">{{ summaryText(item) }}</span>
            <small>{{ metaText(item) }}</small>
          </div>
        </article>
      </div>
      <div ref="sentinel" class="load-more-indicator" aria-live="polite">
        <template v-if="loadingMore"><LoaderCircle :size="18" class="spin-icon" /><span>正在加载更多…</span></template>
        <template v-else-if="hasMore"><span>继续下滑加载更多</span></template>
        <template v-else-if="logs.length"><span>已加载全部日志</span></template>
      </div>
    </section>
  </section>
</template>
