<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { BellRing, ClipboardCheck, FileQuestion, FolderHeart, Inbox } from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import PullIndicator from "../components/PullIndicator.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { useAppContext } from "../composables/useAppContext";
import { usePullRefresh } from "../composables/usePullRefresh";
import { useToast } from "../composables/useToast";
import { request } from "../utils/api";
import type { OverviewSummary, Reminder, ReportSummary, ReportSummaryStats } from "../types/api";

const app = useAppContext();
const root = ref<HTMLElement | null>(null);
const loading = ref(true);
const error = ref("");
const stats = ref<ReportSummaryStats | null>(null);
const recentReadyReports = ref<ReportSummary[]>([]);
const unfiledReports = ref<ReportSummary[]>([]);
const reminders = ref<Reminder[]>([]);
const previewReportId = ref<string | null>(null);
const toast = useToast();

const pendingReminders = computed(() => reminders.value.filter((item) => item.status === "pending"));
const unfiledCount = computed(() => {
  if (!stats.value) return 0;
  return Math.max(0, stats.value.totalReports - stats.value.readyReports);
});

function formatDate(value: string | null) {
  if (!value) return "未识别日期";
  return value.slice(0, 10);
}

function statusLabel(value: string) {
  return {
    ready: "已归档",
    needs_review: "待确认",
    processing: "处理中",
    queued: "排队中",
    failed: "失败"
  }[value] || value;
}

function openReport(reportId: string) {
  previewReportId.value = reportId;
}

function reminderMeta(item: Reminder) {
  const source = item.source === "report_suggestion" ? "报告建议" : "手工提醒";
  const report = item.reportTitle ? `来源：${item.reportTitle}` : source;
  const hospital = item.reportHospitalName || "";
  return [item.dueAt, report, hospital].filter(Boolean).join(" · ");
}

function reminderStatusLabel(item: Reminder) {
  return item.status === "pending" ? "待处理" : item.status === "completed" ? "已完成" : "已忽略";
}

async function load(memberId: string, silent = false) {
  if (!silent) loading.value = true;
  error.value = "";
  try {
    const overview = await request<OverviewSummary>(`overview?memberId=${encodeURIComponent(memberId)}`);
    stats.value = overview.stats;
    recentReadyReports.value = overview.recentReadyReports;
    unfiledReports.value = overview.unfiledReports;
    reminders.value = overview.pendingReminders;
    await app.refreshReminderCount(memberId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "概览加载失败";
  } finally {
    if (!silent) loading.value = false;
  }
}

function reloadOverview() {
  const memberId = app.selectedMemberId.value;
  if (memberId) void load(memberId, true);
}

const { pullDistance, refreshing } = usePullRefresh(root, async () => {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  await load(memberId, true);
  toast.show("概览已刷新");
});

watch(() => app.selectedMemberId.value, (memberId) => {
  if (!memberId) {
    loading.value = false;
    stats.value = null;
    recentReadyReports.value = [];
    unfiledReports.value = [];
    reminders.value = [];
    return;
  }
  void load(memberId);
}, { immediate: true });
</script>

<template>
  <section ref="root" class="plain-page overview-page">
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />

    <p v-if="error" class="inline-panel-error">{{ error }}</p>
    <div v-if="loading" class="loading-list"><span v-for="index in 4" :key="index"></span></div>
    <EmptyState v-else-if="!stats || stats.totalReports === 0" title="还没有健康档案" description="从拍照或上传 PDF 开始，识别完成后这里会汇总档案数量和提醒。">
      <RouterLink class="primary-button" to="/upload">上传第一份报告</RouterLink>
    </EmptyState>

    <template v-else>
      <section class="overview-stats">
        <RouterLink class="stat-card" to="/records">
          <span class="stat-icon"><FolderHeart :size="23" /></span>
          <span class="stat-text"><span>报告总数</span><strong>{{ stats.totalReports }}</strong></span>
        </RouterLink>
        <RouterLink class="stat-card" :to="{ path: '/records', query: { status: 'ready' } }">
          <span class="stat-icon"><ClipboardCheck :size="23" /></span>
          <span class="stat-text"><span>已存档</span><strong>{{ stats.readyReports }}</strong></span>
        </RouterLink>
        <RouterLink class="stat-card" :to="{ path: '/records', query: { status: 'unfiled' } }">
          <span class="stat-icon"><FileQuestion :size="23" /></span>
          <span class="stat-text"><span>待识别</span><strong>{{ unfiledCount }}</strong></span>
        </RouterLink>
        <RouterLink class="stat-card" to="/reminders">
          <span class="stat-icon"><BellRing :size="23" /></span>
          <span class="stat-text"><span>待处理提醒</span><strong>{{ pendingReminders.length }}</strong></span>
        </RouterLink>
      </section>

      <section v-if="pendingReminders.length" class="settings-band overview-card">
          <header>
            <div><BellRing :size="18" /><h3>近期提醒</h3></div>
            <RouterLink to="/reminders">全部</RouterLink>
          </header>
          <div class="overview-card-body">
          <article v-for="item in pendingReminders.slice(0, 3)" :key="item.id" class="overview-row overview-reminder-row">
            <div class="overview-reminder-main">
              <strong>{{ item.title }}</strong>
              <span>{{ reminderMeta(item) }}</span>
            </div>
            <div class="overview-reminder-footer">
              <span class="chip status-label chip--amber">{{ reminderStatusLabel(item) }}</span>
              <button v-if="item.reportId" type="button" @click="openReport(item.reportId)">查看报告</button>
            </div>
          </article>
          </div>
      </section>

      <section class="overview-grid">
        <section class="settings-band overview-card">
          <header>
            <div><Inbox :size="18" /><h3>最近报告</h3></div>
            <RouterLink :to="{ path: '/records', query: { status: 'ready' } }">全部</RouterLink>
          </header>
          <div class="overview-card-body">
          <div v-if="!recentReadyReports.length" class="overview-empty-line">暂无已存档报告</div>
          <article v-for="item in recentReadyReports" :key="item.id" class="overview-row report-row" role="button" tabindex="0" @click="openReport(item.id)" @keydown.enter="openReport(item.id)">
            <div>
              <strong>{{ item.title }}</strong>
              <span>{{ formatDate(item.reportIssuedAt) }} · {{ item.hospitalName || "未识别医院" }}</span>
            </div>
            <button type="button" @click="openReport(item.id)">查看</button>
          </article>
          </div>
        </section>

        <section class="settings-band overview-card">
          <header>
            <div><FileQuestion :size="18" /><h3>待识别报告</h3></div>
            <RouterLink :to="{ path: '/records', query: { status: 'unfiled' } }">全部</RouterLink>
          </header>
          <div class="overview-card-body">
          <div v-if="!unfiledReports.length" class="overview-empty-line">暂无待识别报告</div>
          <article v-for="item in unfiledReports" :key="item.id" class="overview-row report-row" role="button" tabindex="0" @click="openReport(item.id)" @keydown.enter="openReport(item.id)">
            <div>
              <strong>{{ item.title }}</strong>
              <span>{{ formatDate(item.reportIssuedAt) }} · {{ item.hospitalName || "未识别医院" }} · {{ statusLabel(item.status) }}</span>
            </div>
            <button type="button" @click="openReport(item.id)">查看</button>
          </article>
          </div>
        </section>
      </section>
    </template>
    <ReportDetailModal :open="Boolean(previewReportId)" :report-id="previewReportId" @close="previewReportId = null" @updated="reloadOverview" />
  </section>
</template>
