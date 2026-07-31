import { computed, readonly, ref, shallowRef, watch, type Ref } from "vue";
import { request } from "../utils/api";
import { readStorage, removeStorage, writeStorage } from "../utils/storage";
import type { AppNotification, HealthMember, Reminder, Session } from "../types/api";

const loading = ref(true);
const error = ref("");
const session = ref<Session | null>(null);
const members = ref<HealthMember[]>([]);
const selectedMemberId = ref(readStorage("health-records:selected-member") || "");
const selectedMember = computed(() => members.value.find((member) => member.id === selectedMemberId.value) || null);
const topbarSubtitles = ref<Record<string, string>>({});
export type TopbarSearchConfig = {
  key: string;
  model: Ref<string>;
  placeholder: string;
  expandedPlaceholder?: string;
  submit?: () => void;
};
const topbarSearch = shallowRef<TopbarSearchConfig | null>(null);
const pendingReminderCount = ref(0);
/* 数据变更信号：上传完成、后台任务跑完等场景递增，各页面据此静默刷新缓存数据 */
const dataVersion = ref(0);
function notifyDataChanged() {
  dataVersion.value += 1;
}

watch(selectedMemberId, (value) => {
  if (value) writeStorage("health-records:selected-member", value);
  else removeStorage("health-records:selected-member");
  void refreshReminderCount(value);
});

async function refreshReminderCount(memberId = selectedMemberId.value) {
  if (!session.value?.authenticated || !memberId) {
    pendingReminderCount.value = 0;
    return;
  }
  try {
    const [reminders, notifications] = await Promise.all([
      request<Reminder[]>(`reminders?memberId=${encodeURIComponent(memberId)}`),
      request<AppNotification[]>(`notifications?memberId=${encodeURIComponent(memberId)}`)
    ]);
    pendingReminderCount.value = reminders.filter((item) => item.status === "pending").length
      + notifications.filter((item) => item.status === "unread").length;
  } catch (cause) {
    pendingReminderCount.value = 0;
    console.warn("[health-records] 提醒计数刷新失败", cause);
  }
}

async function refreshMembers() {
  members.value = await request<HealthMember[]>("members");
  if (!members.value.some((member) => member.id === selectedMemberId.value)) {
    selectedMemberId.value = members.value[0]?.id || "";
  }
  await refreshReminderCount();
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    session.value = await request<Session>("session");
    if (session.value.authenticated) {
      await refreshMembers();
    } else {
      members.value = [];
      selectedMemberId.value = "";
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

export function useAppContext() {
  return {
    loading: readonly(loading),
    error: readonly(error),
    session: readonly(session),
    members: readonly(members),
    selectedMemberId,
    selectedMember,
    topbarSubtitles: readonly(topbarSubtitles),
    topbarSearch: readonly(topbarSearch),
    pendingReminderCount: readonly(pendingReminderCount),
    dataVersion: readonly(dataVersion),
    notifyDataChanged,
    setTopbarSubtitle: (key: string, value: string) => {
      topbarSubtitles.value = { ...topbarSubtitles.value, [key]: value };
    },
    clearTopbarSubtitle: (key: string) => {
      if (!(key in topbarSubtitles.value)) return;
      const next = { ...topbarSubtitles.value };
      delete next[key];
      topbarSubtitles.value = next;
    },
    setTopbarSearch: (value: TopbarSearchConfig) => {
      topbarSearch.value = value;
    },
    setTopbarSearchValue: (value: string) => {
      if (topbarSearch.value) topbarSearch.value.model.value = value;
    },
    clearTopbarSearch: (key: string) => {
      if (topbarSearch.value?.key === key) topbarSearch.value = null;
    },
    setPendingReminderCount: (value: number) => {
      pendingReminderCount.value = Math.max(0, Math.round(value));
    },
    refreshMembers,
    refreshReminderCount,
    load
  };
}
