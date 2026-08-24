<script setup lang="ts">
import { ArrowRight, DatabaseBackup, LoaderCircle } from "@lucide/vue";
import { onMounted } from "vue";
import AppShell from "./layouts/AppShell.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import LoginView from "./pages/LoginView.vue";
import PasswordChangeRequiredView from "./pages/PasswordChangeRequiredView.vue";
import { useAppContext } from "./composables/useAppContext";
import { useTheme } from "./composables/useTheme";
import { useToast } from "./composables/useToast";

const app = useAppContext();
const toast = useToast();
useTheme();

/* iOS Safari 无视 user-scalable=no，全局拦截专有手势事件，禁止页面捏合缩放 */
function preventPageGesture(event: Event) {
  event.preventDefault();
}

onMounted(() => {
  void app.load();
  document.addEventListener("gesturestart", preventPageGesture);
  document.addEventListener("gesturechange", preventPageGesture);
});
</script>

<template>
  <div v-if="app.loading.value" class="boot-state">
    <span class="spinner" aria-hidden="true"></span>
    <p>正在打开健康档案</p>
  </div>
  <main v-else-if="app.schemaMaintenance.value" class="boot-state boot-maintenance">
    <DatabaseBackup class="boot-maintenance-icon" :size="30" aria-hidden="true" />
    <div class="boot-maintenance-copy">
      <h1>数据库结构需要适配</h1>
      <p>检测到发布前的临时结构版本。报告和指标数据不会删除，完成备份与适配后即可继续使用。</p>
    </div>
    <div class="boot-maintenance-versions" aria-label="数据库版本适配">
      <div><span>当前数据库</span><strong>v{{ app.schemaMaintenance.value.databaseVersion }}</strong></div>
      <ArrowRight :size="20" aria-hidden="true" />
      <div><span>适配目标</span><strong>v{{ app.schemaMaintenance.value.supportedVersion }}</strong></div>
    </div>
    <button
      class="primary-button"
      type="button"
      :disabled="app.repairingSchema.value"
      @click="app.repairUnreleasedSchema"
    >
      <LoaderCircle v-if="app.repairingSchema.value" class="spin-icon" :size="17" aria-hidden="true" />
      <DatabaseBackup v-else :size="17" aria-hidden="true" />
      {{ app.repairingSchema.value ? "正在备份并适配" : "备份并完成适配" }}
    </button>
    <p v-if="app.repairError.value" class="boot-maintenance-error">{{ app.repairError.value }}</p>
  </main>
  <div v-else-if="app.error.value" class="boot-state">
    <p>应用启动失败：{{ app.error.value }}</p>
    <button class="primary-button" type="button" @click="app.load">重试</button>
  </div>
  <LoginView v-else-if="!app.session.value?.authenticated" @authenticated="app.load" />
  <PasswordChangeRequiredView v-else-if="app.session.value?.mustChangePassword" />
  <AppShell v-else />
  <ConfirmDialog />
  <div class="toast" :class="{ show: toast.visible.value }" role="status">{{ toast.message.value }}</div>
</template>
