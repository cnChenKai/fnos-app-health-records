<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { Bell, Camera, ChartNoAxesCombined, ChevronsUpDown, FolderHeart, LayoutDashboard, UserRound } from "@lucide/vue";
import appIcon from "../assets/app-icon.png";
import MemberSwitcher from "../components/MemberSwitcher.vue";
import { useAppContext } from "../composables/useAppContext";

const app = useAppContext();
const route = useRoute();
const memberSheetOpen = ref(false);

const accountRole = computed(() => {
  if (!app.session.value?.isGatewayAdmin) return "家庭成员";
  if (app.session.value.provider === "development") return "开发管理员";
  return "fnOS 系统管理员";
});
const pageTitle = computed(() => (route.meta.title as string) || "健康档案");
const pageSubtitle = computed(() => app.topbarSubtitle.value || (route.meta.subtitle as string) || "");
const memberInitial = computed(() => app.selectedMember.value?.displayName?.slice(0, 1) || "档");
const reminderBadge = computed(() => {
  const count = app.pendingReminderCount.value;
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
});
function isNavActive(to: string) {
  return route.path === to || route.path.startsWith(`${to}/`);
}
const isMePage = computed(() => route.path === "/me");

/* 页面缓存（KeepAlive）下的滚动位置记忆：切走前按路径保存，切回时恢复，未访问过的页面回到顶部 */
const pageScrollPositions = new Map<string, number>();
let activePath = route.fullPath;
function savePageScroll() {
  pageScrollPositions.set(activePath, window.scrollY);
}
function restorePageScroll() {
  activePath = route.fullPath;
  window.scrollTo(0, pageScrollPositions.get(activePath) ?? 0);
}
const sessionInitial = computed(() => app.session.value?.displayName?.slice(0, 1) || "我");
const providerLabel = computed(() => {
  const provider = app.session.value?.provider;
  if (provider === "local") return "直连账号";
  if (provider === "development") return "开发账号";
  return "fnOS 账号";
});
const roleLabel = computed(() => app.session.value?.isGatewayAdmin ? "管理员" : "家庭成员");
const navItems = [
  { to: "/overview", label: "概览", icon: LayoutDashboard },
  { to: "/records", label: "档案", icon: FolderHeart },
  { to: "/upload", label: "上传报告", icon: Camera, primary: true },
  { to: "/trends", label: "趋势", icon: ChartNoAxesCombined },
  { to: "/me", label: "我的", icon: UserRound, badge: reminderBadge }
];
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <img :src="appIcon" alt="" />
        <div><strong>健康档案</strong><span>家庭医疗记录</span></div>
      </div>
      <button class="member-picker-card" type="button" @click="memberSheetOpen = true">
        <span class="member-picker-label">当前成员</span>
        <span class="member-picker-body">
          <span class="member-avatar small" aria-hidden="true">{{ memberInitial }}</span>
          <strong>{{ app.selectedMember.value?.displayName || "选择成员" }}</strong>
          <ChevronsUpDown :size="16" />
        </span>
      </button>
      <nav class="desktop-nav" aria-label="主导航">
        <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" :class="{ primary: item.primary, 'router-link-active': isNavActive(item.to) }">
          <span class="nav-icon-wrap">
            <component :is="item.icon" :size="item.primary ? 19 : 17" />
            <span v-if="item.badge?.value" class="nav-badge">{{ item.badge.value }}</span>
          </span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
      <div class="account-summary">
        <span class="member-avatar small" aria-hidden="true">{{ app.session.value?.displayName?.slice(0, 1) }}</span>
        <div><strong>{{ app.session.value?.displayName }}</strong><span>{{ accountRole }}</span></div>
      </div>
    </aside>

    <section class="workspace">
      <header class="mobile-topbar">
        <template v-if="isMePage">
          <span class="topbar-avatar" aria-hidden="true">{{ sessionInitial }}</span>
          <div class="topbar-heading">
            <strong class="topbar-title">{{ app.session.value?.displayName }}</strong>
            <span class="topbar-subtitle">{{ providerLabel }} · {{ roleLabel }}</span>
          </div>
          <RouterLink class="topbar-bell" to="/reminders" aria-label="查看提醒">
            <Bell :size="19" />
            <span v-if="reminderBadge" class="nav-badge">{{ reminderBadge }}</span>
          </RouterLink>
        </template>
        <template v-else>
          <img class="topbar-brand-icon" :src="appIcon" alt="" />
          <div class="topbar-heading">
            <strong class="topbar-title">{{ pageTitle }}</strong>
            <span v-if="pageSubtitle" class="topbar-subtitle">{{ pageSubtitle }}</span>
          </div>
          <button class="member-chip" type="button" @click="memberSheetOpen = true">
            <span class="member-chip-avatar" aria-hidden="true">{{ memberInitial }}</span>
            <span class="member-chip-name">{{ app.selectedMember.value?.displayName || "选择成员" }}</span>
            <ChevronsUpDown :size="15" />
          </button>
        </template>
      </header>
      <main class="page-content">
        <RouterView v-slot="{ Component }">
          <Transition name="page-fade" mode="out-in" @before-leave="savePageScroll" @after-enter="restorePageScroll">
            <KeepAlive>
              <component :is="Component" />
            </KeepAlive>
          </Transition>
        </RouterView>
      </main>
    </section>

    <nav class="mobile-nav" aria-label="触屏导航">
      <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" :class="{ primary: item.primary, 'router-link-active': isNavActive(item.to) }" :aria-label="item.primary ? '拍照上传' : undefined">
        <span class="mobile-nav-icon">
          <component :is="item.icon" :size="item.primary ? 26 : 21" />
          <span v-if="item.badge?.value" class="nav-badge mobile">{{ item.badge.value }}</span>
        </span>
        <span v-if="!item.primary">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <MemberSwitcher :open="memberSheetOpen" @close="memberSheetOpen = false" />
  </div>
</template>
