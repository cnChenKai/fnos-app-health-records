<script setup lang="ts">
import { ref } from "vue";
import { KeyRound, LoaderCircle, ShieldAlert } from "@lucide/vue";
import appIcon from "../assets/app-icon.png";
import { useAppContext } from "../composables/useAppContext";
import { request } from "../utils/api";

const app = useAppContext();
const newPassword = ref("");
const confirmPassword = ref("");
const saving = ref(false);
const error = ref("");

async function changePassword() {
  if (saving.value) return;
  error.value = "";
  if (newPassword.value !== confirmPassword.value) {
    error.value = "两次输入的新密码不一致";
    return;
  }
  saving.value = true;
  try {
    await request("auth/password", {
      method: "PUT",
      body: JSON.stringify({ newPassword: newPassword.value, confirmPassword: confirmPassword.value })
    });
    await app.load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "密码修改失败";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-panel password-required-panel">
      <span class="login-icon"><img :src="appIcon" alt="" /></span>
      <div><h1>首次登录</h1><p>为了保护健康档案，请先设置一个新密码。</p></div>
      <div class="login-notice login-warning"><ShieldAlert :size="18" /><span>当前账号：{{ app.session.value?.displayName }}</span></div>
      <form class="login-form" @submit.prevent="changePassword">
        <label><span>新密码</span><input v-model="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></label>
        <label><span>确认新密码</span><input v-model="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></label>
        <p class="login-hint">密码长度为 8-128 个字符。</p>
        <p v-if="error" class="login-error">{{ error }}</p>
        <button class="primary-button" type="submit" :disabled="saving || !newPassword || !confirmPassword">
          <LoaderCircle v-if="saving" class="spin-icon" :size="17" />
          <KeyRound v-else :size="17" />
          {{ saving ? "正在保存" : "设置新密码" }}
        </button>
      </form>
    </section>
  </main>
</template>
