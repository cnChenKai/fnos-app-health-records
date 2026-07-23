import { createRouter, createWebHistory } from "vue-router";
import OverviewPage from "./pages/OverviewPage.vue";
import RecordsPage from "./pages/RecordsPage.vue";
import TrendsPage from "./pages/TrendsPage.vue";
import UploadPage from "./pages/UploadPage.vue";
import RemindersPage from "./pages/RemindersPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";
import MembersSettingsPage from "./pages/settings/MembersSettingsPage.vue";
import RuntimeSettingsPage from "./pages/settings/RuntimeSettingsPage.vue";
import AiSettingsPage from "./pages/settings/AiSettingsPage.vue";
import TrashSettingsPage from "./pages/settings/TrashSettingsPage.vue";
import DataAuditSettingsPage from "./pages/settings/DataAuditSettingsPage.vue";
import DuplicatesSettingsPage from "./pages/settings/DuplicatesSettingsPage.vue";
import MaintenanceSettingsPage from "./pages/settings/MaintenanceSettingsPage.vue";
import UserAuditSettingsPage from "./pages/settings/UserAuditSettingsPage.vue";
import AiAuditSettingsPage from "./pages/settings/AiAuditSettingsPage.vue";
import AboutSettingsPage from "./pages/settings/AboutSettingsPage.vue";
import { useAppContext } from "./composables/useAppContext";

const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;

const router = createRouter({
  history: createWebHistory(base),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", component: OverviewPage, meta: { title: "概览", subtitle: "报告、提醒和趋势摘要" } },
    { path: "/records", component: RecordsPage, meta: { title: "档案", subtitle: "按医院报告生成日期整理" } },
    { path: "/trends", component: TrendsPage, meta: { title: "趋势", subtitle: "仅比较相同指标和兼容单位" } },
    { path: "/upload", component: UploadPage, meta: { title: "上传报告", subtitle: "拍照或上传 PDF，自动识别归档" } },
    { path: "/reminders", component: RemindersPage, meta: { title: "提醒", subtitle: "集中处理即将到期的健康事项" } },
    { path: "/me", component: SettingsPage, meta: { title: "我的", subtitle: "账号、成员与识别服务" } },
    { path: "/me/members", component: MembersSettingsPage, meta: { title: "家庭成员" } },
    { path: "/me/trash", component: TrashSettingsPage, meta: { title: "回收站" } },
    { path: "/me/duplicates", component: DuplicatesSettingsPage, meta: { title: "重复报告检测" } },
    { path: "/me/data", component: DataAuditSettingsPage, meta: { title: "备份与恢复" } },
    { path: "/me/audit", component: UserAuditSettingsPage, meta: { title: "用户操作日志", requiresAdmin: true } },
    { path: "/me/ai-audit", component: AiAuditSettingsPage, meta: { title: "AI 审计", requiresAdmin: true } },
    { path: "/me/maintenance", component: MaintenanceSettingsPage, meta: { title: "维护工具", requiresAdmin: true } },
    { path: "/me/runtime", component: RuntimeSettingsPage, meta: { title: "运行与识别", requiresAdmin: true } },
    { path: "/me/ai", component: AiSettingsPage, meta: { title: "AI 解析模型", requiresAdmin: true } },
    { path: "/me/about", component: AboutSettingsPage, meta: { title: "关于" } },
    { path: "/settings", redirect: "/me" },
    { path: "/:pathMatch(.*)*", redirect: "/overview" }
  ]
});

router.beforeEach(async (to) => {
  if (!to.meta.requiresAdmin) return true;
  const app = useAppContext();
  if (!app.session.value) await app.load();
  if (app.session.value?.isGatewayAdmin) return true;
  return "/me";
});

export default router;
