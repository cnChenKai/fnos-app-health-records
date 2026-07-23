<script setup lang="ts">
import { ref, watch } from "vue";
import { RotateCcw, Trash2 } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import { request } from "../../utils/api";
import type { CursorPage, ReportSummary } from "../../types/api";
import { useAppContext } from "../../composables/useAppContext";
import { useToast } from "../../composables/useToast";

const app = useAppContext();
const toast = useToast();
const loading = ref(true);
const reports = ref<ReportSummary[]>([]);
const error = ref("");

async function load(memberId: string) {
  loading.value = true;
  error.value = "";
  try {
    reports.value = (await request<CursorPage<ReportSummary>>(`reports?trash=1&memberId=${encodeURIComponent(memberId)}`)).items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "回收站加载失败";
  } finally {
    loading.value = false;
  }
}

async function restore(report: ReportSummary) {
  await request(`reports/${encodeURIComponent(report.id)}/restore`, { method: "POST" });
  const memberId = app.selectedMemberId.value;
  if (memberId) await load(memberId);
  toast.show("报告已恢复");
}

async function purge(report: ReportSummary) {
  if (!window.confirm(`永久删除「${report.title}」？此操作不可恢复。`)) return;
  await request(`reports/${encodeURIComponent(report.id)}?permanent=1`, { method: "DELETE" });
  const memberId = app.selectedMemberId.value;
  if (memberId) await load(memberId);
  toast.show("报告已永久删除");
}

watch(() => app.selectedMemberId.value, (memberId) => { if (memberId) void load(memberId); }, { immediate: true });
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="回收站" description="已删除报告会先保留 30 天，确认无误后可永久删除" />
    <p v-if="error" class="inline-panel-error">{{ error }}</p>
    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <EmptyState v-else-if="!reports.length" title="回收站为空" description="移入回收站的报告会显示在这里。" />
    <div v-else class="data-list">
      <article v-for="report in reports" :key="report.id">
        <span class="item-icon"><Trash2 :size="18" /></span>
        <div><strong>{{ report.title }}</strong><span>{{ report.reportIssuedAt || "日期待确认" }} · {{ report.hospitalName || "医院待整理" }}</span></div>
        <div class="row-actions">
          <button type="button" @click="restore(report)"><RotateCcw :size="15" />恢复</button>
          <button class="danger-action" type="button" @click="purge(report)"><Trash2 :size="15" />永久删除</button>
        </div>
      </article>
    </div>
  </section>
</template>
