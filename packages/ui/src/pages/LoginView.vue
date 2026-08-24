<script setup lang="ts">
import { ref } from "vue";
import { LoaderCircle, LogIn, ShieldCheck, TriangleAlert } from "@lucide/vue";
import appIcon from "../assets/app-icon.png";
import { useAppContext } from "../composables/useAppContext";
import { request } from "../utils/api";

const emit = defineEmits<{ authenticated: [] }>();
const app = useAppContext();
const username = ref("admin");
const password = ref("");
const submitting = ref(false);
const error = ref("");

async function submit() {
  if (submitting.value || app.session.value?.setupRequired) return;
  submitting.value = true;
  error.value = "";
  try {
    await request("auth/login", {
      method: "POST",
      body: JSON.stringify({ username: username.value, password: password.value })
    });
    password.value = "";
    emit("authenticated");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "登录失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-panel">
      <span class="login-icon"><img :src="appIcon" alt="" /></span>
      <div><h1>健康档案</h1><p>{{ app.session.value?.authMode === "local" ? "使用本地管理员账号登录" : "请从 fnOS 桌面或应用网关打开" }}</p></div>
      <form v-if="app.session.value?.authMode === 'local' && !app.session.value.setupRequired" class="login-form" @submit.prevent="submit">
        <label><span>用户名</span><input v-model.trim="username" autocomplete="username" required /></label>
        <label><span>密码</span><input v-model="password" type="password" autocomplete="current-password" required /></label>
        <p v-if="error" class="login-error">{{ error }}</p>
        <button class="primary-button" type="submit" :disabled="submitting || !username || !password">
          <LoaderCircle v-if="submitting" class="spin-icon" :size="17" />
          <LogIn v-else :size="17" />
          {{ submitting ? "正在登录" : "登录" }}
        </button>
      </form>
      <p v-else-if="app.session.value?.authMode === 'local'" class="login-notice login-warning">
        <TriangleAlert :size="18" />本地管理员尚未初始化，请配置管理员密码 Secret 后重启容器。
      </p>
      <p v-else class="login-notice"><ShieldCheck :size="18" />当前请求没有 fnOS 登录态，健康档案不提供独立账号登录。</p>
    </section>
  </main>
</template>
