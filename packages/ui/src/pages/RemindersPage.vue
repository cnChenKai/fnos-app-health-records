<script setup lang="ts">
import { ref, watch } from "vue";
import { BellRing, CheckCircle2, Clock3, Plus, X } from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import DateTimePicker from "../components/DateTimePicker.vue";
import PullIndicator from "../components/PullIndicator.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { request } from "../utils/api";
import { formatDatabaseTime } from "../utils/time";
import type { AppNotification, Reminder } from "../types/api";
import { useAppContext } from "../composables/useAppContext";
import { usePullRefresh } from "../composables/usePullRefresh";
import { useRefreshOnActivate } from "../composables/useRefreshOnActivate";
import { useToast } from "../composables/useToast";

const app = useAppContext();
const loading = ref(true);
const saving = ref(false);
const formOpen = ref(false);
const error = ref("");
const reminders = ref<Reminder[]>([]);
const notifications = ref<AppNotification[]>([]);
const previewReportId = ref<string | null>(null);
const form = ref({ title: "", dueAt: "" });

function sourceLabel(source: Reminder["source"]) {
  return source === "report_suggestion" ? "报告复查建议" : "手工提醒";
}

function reminderStatusMeta(item: Reminder) {
  if (item.status === "completed") return { label: "已完成", chip: "chip--green" };
  if (item.status === "dismissed") return { label: "已忽略", chip: "" };
  return { label: "待处理", chip: "chip--amber" };
}

function reminderSourceText(item: Reminder) {
  const chunks = [item.dueAt, sourceLabel(item.source)];
  if (item.reportTitle) chunks.push(`来源：${item.reportTitle}`);
  return chunks.join(" · ");
}

function reportMetaText(item: Reminder) {
  return [item.reportHospitalName, item.reportIssuedAt?.slice(0, 10)].filter(Boolean).join(" · ");
}

function openReport(reportId: string | null) {
  if (!reportId) return;
  previewReportId.value = reportId;
}

async function load(memberId: string, silent = false) {
  if (!silent) loading.value = true;
  error.value = "";
  try {
    const [nextReminders, nextNotifications] = await Promise.all([
      request<Reminder[]>(`reminders?memberId=${encodeURIComponent(memberId)}`),
      request<AppNotification[]>(`notifications?memberId=${encodeURIComponent(memberId)}`)
    ]);
    reminders.value = nextReminders;
    notifications.value = nextNotifications;
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : "提醒加载失败";
    throw cause;
  }
  finally {
    await app.refreshReminderCount(memberId);
    if (!silent) loading.value = false;
  }
}

function notificationMeta(item: AppNotification) {
  if (item.type === "report_failed") return { label: "处理失败", chip: "chip--red" };
  if (item.severity === "warning") return { label: "需要注意", chip: "chip--amber" };
  return { label: "处理完成", chip: "chip--green" };
}

async function createManualReminder() {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  saving.value = true;
  error.value = "";
  try {
    await request<Reminder>("reminders", {
      method: "POST",
      body: JSON.stringify({ memberId, ...form.value })
    });
    form.value = { title: "", dueAt: "" };
    formOpen.value = false;
    await load(memberId, true).catch(() => {});
    toast.show("提醒已创建");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "创建提醒失败";
  } finally {
    saving.value = false;
  }
}

const actionPendingId = ref("");

async function setStatus(item: Reminder, status: Reminder["status"]) {
  const memberId = app.selectedMemberId.value;
  if (!memberId || actionPendingId.value) return;
  actionPendingId.value = item.id;
  try {
    await request(`reminders/${encodeURIComponent(item.id)}`, {
      method: "PUT",
      body: JSON.stringify({ status })
    });
    await load(memberId, true).catch(() => {});
    toast.show(status === "completed" ? "提醒已完成" : status === "dismissed" ? "已忽略该提醒" : "提醒已恢复待处理");
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
  } finally {
    actionPendingId.value = "";
  }
}

function reloadReminders() {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  load(memberId, true).catch((cause) => console.warn("[health-records] 提醒后台刷新失败", cause));
}

useRefreshOnActivate(reloadReminders);

async function setNotificationStatus(item: AppNotification, status: AppNotification["status"]) {
  const memberId = app.selectedMemberId.value;
  if (!memberId || actionPendingId.value) return;
  actionPendingId.value = item.id;
  try {
    await request(`notifications/${encodeURIComponent(item.id)}`, {
      method: "PUT",
      body: JSON.stringify({ status })
    });
    await load(memberId, true).catch(() => {});
    toast.show("通知已归档");
  } catch (cause) {
    toast.show(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
  } finally {
    actionPendingId.value = "";
  }
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
</script>

<template>
  <section ref="root" class="plain-page">
    <div class="page-intro">
      <div><h2>复查与随访</h2><p>确认报告中的复查要求后会自动生成，也可以手工添加</p></div>
      <button class="primary-button compact-primary" type="button" @click="formOpen = !formOpen"><Plus :size="17" />添加提醒</button>
    </div>
    <PullIndicator :distance="pullDistance" :refreshing="refreshing" />
    <div class="mobile-only reminder-add-row">
      <button class="soft-action-button" type="button" @click="formOpen = !formOpen"><Plus :size="16" />添加提醒</button>
    </div>
    <form v-if="formOpen" class="settings-band reminder-form" @submit.prevent="createManualReminder">
      <div class="form-grid">
        <label><span>提醒标题</span><input v-model="form.title" placeholder="例如 复查甲状腺彩超" /></label>
        <label><span>到期日期</span><DateTimePicker v-model="form.dueAt" aria-label="到期日期" /></label>
      </div>
      <p v-if="error" class="inline-panel-error">{{ error }}</p>
      <div class="form-actions"><button type="button" @click="formOpen = false">取消</button><button class="primary-button" :disabled="saving">保存</button></div>
    </form>
    <p v-else-if="error" class="inline-panel-error">{{ error }}</p>
    <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
    <EmptyState v-else-if="!reminders.length && !notifications.length" title="当前没有通知" description="报告处理完成、处理失败和复查提醒会集中显示在这里。" />
    <div v-if="!loading && notifications.length" class="data-list reminder-list notification-list">
      <article v-for="item in notifications" :key="item.id" :class="{ unread: item.status === 'unread' }">
        <div class="reminder-card-head">
          <span class="item-icon"><BellRing :size="19" /></span>
          <div class="reminder-card-main">
            <strong>{{ item.title }}</strong>
            <span>{{ formatDatabaseTime(item.createdAt) }} · {{ item.reportTitle || "关联报告" }}</span>
            <small v-if="item.message">{{ item.message }}</small>
          </div>
        </div>
        <div class="reminder-card-footer">
          <span class="chip status-label" :class="notificationMeta(item).chip">{{ notificationMeta(item).label }}</span>
          <div class="row-actions">
            <button v-if="item.reportId" type="button" @click="openReport(item.reportId)">查看报告</button>
            <button type="button" :disabled="actionPendingId === item.id" @click="setNotificationStatus(item, 'archived')"><CheckCircle2 :size="15" />知道了</button>
          </div>
        </div>
      </article>
    </div>
    <div v-if="!loading && reminders.length" class="data-list reminder-list">
      <article v-for="item in reminders" :key="item.id">
        <div class="reminder-card-head">
          <span class="item-icon"><BellRing :size="19" /></span>
          <div class="reminder-card-main">
            <strong>{{ item.title }}</strong>
            <span>{{ reminderSourceText(item) }}</span>
            <small v-if="item.reportTitle && reportMetaText(item)">{{ reportMetaText(item) }}</small>
          </div>
        </div>
        <div class="reminder-card-footer">
          <span class="chip status-label" :class="reminderStatusMeta(item).chip">{{ reminderStatusMeta(item).label }}</span>
          <div class="row-actions">
            <button v-if="item.reportId" type="button" @click="openReport(item.reportId)">查看报告</button>
            <button v-if="item.status !== 'completed'" type="button" :disabled="actionPendingId === item.id" @click="setStatus(item, 'completed')"><CheckCircle2 :size="15" />完成</button>
            <button v-if="item.status !== 'dismissed'" class="danger-action" type="button" :disabled="actionPendingId === item.id" @click="setStatus(item, 'dismissed')"><X :size="15" />忽略</button>
            <button v-if="item.status !== 'pending'" type="button" :disabled="actionPendingId === item.id" @click="setStatus(item, 'pending')"><Clock3 :size="15" />恢复</button>
          </div>
        </div>
      </article>
    </div>
    <ReportDetailModal :open="Boolean(previewReportId)" :report-id="previewReportId" @close="previewReportId = null" @updated="reloadReminders" />
  </section>
</template>
