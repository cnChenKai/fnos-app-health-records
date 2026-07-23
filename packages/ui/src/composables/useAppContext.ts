import { computed, readonly, ref, watch } from "vue";
import { request } from "../utils/api";
import type { AppNotification, HealthMember, Reminder, Session } from "../types/api";

const loading = ref(true);
const error = ref("");
const session = ref<Session | null>(null);
const members = ref<HealthMember[]>([]);
const selectedMemberId = ref(localStorage.getItem("health-records:selected-member") || "");
const selectedMember = computed(() => members.value.find((member) => member.id === selectedMemberId.value) || null);
const topbarSubtitle = ref("");
const pendingReminderCount = ref(0);

watch(selectedMemberId, (value) => {
  if (value) localStorage.setItem("health-records:selected-member", value);
  else localStorage.removeItem("health-records:selected-member");
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
  } catch {
    pendingReminderCount.value = 0;
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
    topbarSubtitle: readonly(topbarSubtitle),
    pendingReminderCount: readonly(pendingReminderCount),
    setTopbarSubtitle: (value: string) => {
      topbarSubtitle.value = value;
    },
    setPendingReminderCount: (value: number) => {
      pendingReminderCount.value = Math.max(0, Math.round(value));
    },
    refreshMembers,
    refreshReminderCount,
    load
  };
}
