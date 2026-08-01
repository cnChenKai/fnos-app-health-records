<script setup lang="ts">
import { ref, watch } from "vue";
import { LoaderCircle, RotateCcw, Trash2 } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import { request } from "../../utils/api";
import type { CursorPage, ReportSummary } from "../../types/api";
import { useAppContext } from "../../composables/useAppContext";
import { useConfirm } from "../../composables/useConfirm";
import { useRefreshOnActivate } from "../../composables/useRefreshOnActivate";
import { useToast } from "../../composables/useToast";

const PAGE_SIZE = 30;
const app = useAppContext();
const toast = useToast();
const confirmDialog = useConfirm();
const loading = ref(true);
const loadingMore = ref(false);
const reports = ref<ReportSummary[]>([]);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const error = ref("");
const restoringId = ref("");

function trashUrl(memberId: string, cursor?: string | null) {
  const params = new URLSearchParams({ trash: "1", memberId, limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  return `reports?${params.toString()}`;
}

async function load(memberId: string) {
  loading.value = true;
  error.value = "";
  try {
    const page = await request<CursorPage<ReportSummary>>(trashUrl(memberId));
    reports.value = page.items;
    nextCursor.value = page.nextCursor;
    hasMore.value = page.hasMore;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "回收站加载失败";
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  const memberId = app.selectedMemberId.value;
  if (!memberId || loadingMore.value || !hasMore.value || !nextCursor.value) return;
  loadingMore.value = true;
  error.value = "";
  try {
    const page = await request<CursorPage<ReportSummary>>(trashUrl(memberId, nextCursor.value));
    const seen = new Set(reports.value.map((report) => report.id));
    reports.value = [...reports.value, ...page.items.filter((report) => !seen.has(report.id))];
    nextCursor.value = page.nextCursor;
    hasMore.value = page.hasMore;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载更多失败";
  } finally {
    loadingMore.value = false;
  }
}

async function restore(report: ReportSummary) {
  if (restoringId.value) return;
  restoringId.value = report.id;
  try {
    await request(`reports/${encodeURIComponent(report.id)}/restore`, { method: "POST" });
    const memberId = app.selectedMemberId.value;
    if (memberId) await load(memberId);
    toast.show("报告已恢复");
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "恢复失败，请稍后重试");
  } finally {
    restoringId.value = "";
  }
}

async function purge(report: ReportSummary) {
  confirmDialog.ask({
    title: "永久删除报告",
    message: `永久删除「${report.title}」？此操作不可恢复。`,
    confirmText: "永久删除",
    danger: true,
    run: async () => {
      try {
        await request(`reports/${encodeURIComponent(report.id)}?permanent=1`, { method: "DELETE" });
        const memberId = app.selectedMemberId.value;
        if (memberId) await load(memberId);
        toast.show("报告已永久删除");
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : "删除失败，请稍后重试");
      }
    }
  });
}

watch(() => app.selectedMemberId.value, (memberId) => { if (memberId) void load(memberId); }, { immediate: true });
useRefreshOnActivate(() => {
  const memberId = app.selectedMemberId.value;
  if (memberId) return load(memberId);
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="回收站" description="已删除报告会先保留 30 天，确认无误后可永久删除" />
    <p v-if="error" class="inline-panel-error">{{ error }}</p>
    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <EmptyState v-else-if="!reports.length && !error" title="回收站为空" description="移入回收站的报告会显示在这里。" />
    <template v-else>
      <div class="data-list">
        <article v-for="report in reports" :key="report.id">
          <span class="item-icon"><Trash2 :size="18" /></span>
          <div><strong>{{ report.title }}</strong><span>{{ report.reportIssuedAt || "日期待确认" }} · {{ report.hospitalName || "医院待整理" }}</span></div>
          <div class="row-actions">
            <button type="button" :disabled="restoringId === report.id" @click="restore(report)">
              <LoaderCircle v-if="restoringId === report.id" class="spin-icon" :size="15" /><RotateCcw v-else :size="15" />恢复
            </button>
            <button class="danger-action" type="button" :disabled="restoringId === report.id" @click="purge(report)"><Trash2 :size="15" />永久删除</button>
          </div>
        </article>
      </div>
      <div v-if="hasMore" class="form-actions">
        <button type="button" :disabled="loadingMore" @click="loadMore">
          <LoaderCircle v-if="loadingMore" class="spin-icon" :size="15" />{{ loadingMore ? "正在加载" : "加载更多" }}
        </button>
      </div>
    </template>
  </section>
</template>
