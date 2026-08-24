<script setup lang="ts">
import { ref } from "vue";
import { KeyRound, LoaderCircle } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { useAppContext } from "../../composables/useAppContext";
import { useToast } from "../../composables/useToast";
import { request } from "../../utils/api";

const app = useAppContext();
const toast = useToast();
const currentPassword = ref("");
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
      body: JSON.stringify({
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
        confirmPassword: confirmPassword.value
      })
    });
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    toast.show("密码已修改，请使用新密码重新登录", 3600);
    await app.load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "密码修改失败";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="账号安全" description="本地管理员登录凭据" />

    <section class="settings-band">
      <header>
        <KeyRound :size="21" />
        <div><h3>修改密码</h3><p>修改后会退出包括当前浏览器在内的全部登录会话</p></div>
      </header>
      <form class="settings-form" @submit.prevent="changePassword">
        <label>
          <span>当前密码</span>
          <input v-model="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label>
          <span>新密码</span>
          <input v-model="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required />
          <small class="field-hint">长度 12-128 个字符</small>
        </label>
        <label>
          <span>确认新密码</span>
          <input v-model="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required />
        </label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <div class="form-actions">
          <button class="primary-button" type="submit" :disabled="saving">
            <LoaderCircle v-if="saving" class="spin-icon" :size="17" />
            <KeyRound v-else :size="17" />
            {{ saving ? "正在修改" : "修改密码" }}
          </button>
        </div>
      </form>
    </section>
  </section>
</template>
