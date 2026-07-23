<script setup lang="ts">
import { onMounted } from "vue";
import AppShell from "./layouts/AppShell.vue";
import LoginView from "./pages/LoginView.vue";
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
  <LoginView v-else-if="!app.session.value?.authenticated" @authenticated="app.load" />
  <AppShell v-else />
  <div class="toast" :class="{ show: toast.visible.value }" role="status">{{ toast.message.value }}</div>
</template>
