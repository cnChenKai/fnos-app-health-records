<script setup lang="ts">
import { onMounted, ref } from "vue";
import { KeyRound, LoaderCircle, Plus, RotateCcw, ShieldCheck, UserRound, X } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { useAppContext } from "../../composables/useAppContext";
import { useConfirm } from "../../composables/useConfirm";
import { useScrollLock } from "../../composables/useScrollLock";
import { useToast } from "../../composables/useToast";
import { request } from "../../utils/api";
import type { LocalAccount } from "../../types/api";

const app = useAppContext();
const toast = useToast();
const confirmDialog = useConfirm();
const accounts = ref<LocalAccount[]>([]);
const resetting = ref(false);
const resetError = ref("");
const createOpen = ref(false);
const creating = ref(false);
const createUsername = ref("");
const createDisplayName = ref("");
const passwordEditOpen = ref(false);
const passwordEditing = ref(false);
const passwordEditError = ref("");
const passwordEditAccount = ref<LocalAccount | null>(null);
const passwordEditValue = ref("");
const passwordEditConfirmation = ref("");
const isAdmin = Boolean(app.session.value?.isAdmin);

useScrollLock(passwordEditOpen);

async function loadAccounts() {
  if (!isAdmin) return;
  try {
    accounts.value = await request<LocalAccount[]>("auth/accounts");
  } catch (cause) {
    resetError.value = cause instanceof Error ? cause.message : "账号列表加载失败";
  }
}

function resetAccount(account: LocalAccount) {
  confirmDialog.ask({
    title: "重置本地账号密码",
    message: `确认将 ${account.displayName} 的密码重置为 admin？对方下次登录必须立即修改密码。`,
    confirmText: "重置密码",
    danger: true,
    run: async () => {
      if (resetting.value) return;
      resetError.value = "";
      resetting.value = true;
      try {
        const result = await request<{ temporaryPassword?: string }>("auth/accounts/password", {
          method: "PUT",
          body: JSON.stringify({ userId: account.userId })
        });
        if (account.userId === app.session.value?.id) {
          await app.load();
          return;
        }
        await loadAccounts();
        toast.show(`密码已重置为 ${result.temporaryPassword || "临时密码"}，对方下次登录必须修改`, 4200);
      } catch (cause) {
        resetError.value = cause instanceof Error ? cause.message : "密码重置失败";
      } finally {
        resetting.value = false;
      }
    }
  });
}

function openCreate() {
  createUsername.value = "";
  createDisplayName.value = "";
  resetError.value = "";
  createOpen.value = true;
}

function openPasswordEdit(account: LocalAccount) {
  passwordEditAccount.value = account;
  passwordEditValue.value = "";
  passwordEditConfirmation.value = "";
  passwordEditError.value = "";
  passwordEditOpen.value = true;
}

function closePasswordEdit() {
  if (passwordEditing.value) return;
  passwordEditOpen.value = false;
  passwordEditAccount.value = null;
}

async function updateAccountPassword() {
  if (passwordEditing.value || !passwordEditAccount.value) return;
  passwordEditError.value = "";
  if (passwordEditValue.value !== passwordEditConfirmation.value) {
    passwordEditError.value = "两次输入的新密码不一致";
    return;
  }
  passwordEditing.value = true;
  try {
    await request("auth/accounts/password", {
      method: "PUT",
      body: JSON.stringify({
        userId: passwordEditAccount.value.userId,
        newPassword: passwordEditValue.value,
        confirmPassword: passwordEditConfirmation.value
      })
    });
    const updatedAccount = passwordEditAccount.value;
    passwordEditOpen.value = false;
    passwordEditAccount.value = null;
    passwordEditValue.value = "";
    passwordEditConfirmation.value = "";
    if (updatedAccount.userId === app.session.value?.id) {
      await app.load();
      return;
    }
    await loadAccounts();
    toast.show("密码已修改，对方下次登录必须再次确认密码", 4200);
  } catch (cause) {
    passwordEditError.value = cause instanceof Error ? cause.message : "密码修改失败";
  } finally {
    passwordEditing.value = false;
  }
}

async function createAccount() {
  if (creating.value) return;
  resetError.value = "";
  creating.value = true;
  try {
    const result = await request<{ temporaryPassword: string }>("auth/accounts", {
      method: "POST",
      body: JSON.stringify({ username: createUsername.value, displayName: createDisplayName.value })
    });
    await loadAccounts();
    createOpen.value = false;
    toast.show(`账号已创建，临时密码为 ${result.temporaryPassword}，首次登录必须修改`, 4200);
  } catch (cause) {
    resetError.value = cause instanceof Error ? cause.message : "账号创建失败";
  } finally {
    creating.value = false;
  }
}

onMounted(() => { void loadAccounts(); });
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="账号安全" description="管理本地账号与登录密码" />

    <section v-if="isAdmin" class="settings-band account-management-band">
      <header class="account-management-header">
        <ShieldCheck :size="21" />
        <div class="account-management-title"><h3>本地账号管理</h3><p>管理员可添加账号或直接重置密码；临时密码登录后必须重新设置</p></div>
        <button class="header-action" type="button" @click="openCreate"><Plus :size="16" />添加账号</button>
      </header>
      <form v-if="createOpen" class="account-create-form" @submit.prevent="createAccount">
        <div class="account-create-heading">
          <div><h4>添加本地账号</h4><p>创建后使用临时密码 <code>admin</code> 登录，并在首次登录时完成修改。</p></div>
          <span class="account-create-badge"><ShieldCheck :size="14" />管理员操作</span>
        </div>
        <div class="form-grid account-form-grid">
          <label><span>显示名称</span><input v-model.trim="createDisplayName" maxlength="40" placeholder="例如：张三" required /></label>
          <label><span>用户名</span><input v-model.trim="createUsername" minlength="3" maxlength="64" autocomplete="username" placeholder="用于登录的账号名" required /></label>
        </div>
        <p v-if="resetError" class="form-error" role="alert">{{ resetError }}</p>
        <div class="form-actions">
          <button type="button" @click="createOpen = false">取消</button>
          <button class="primary-button" type="submit" :disabled="creating">
            <LoaderCircle v-if="creating" class="spin-icon" :size="17" />
            <Plus v-else :size="17" />
            {{ creating ? "正在创建" : "创建账号" }}
          </button>
        </div>
      </form>
      <div class="account-list">
        <article v-for="account in accounts" :key="account.id" class="account-row">
          <span class="member-avatar small" aria-hidden="true"><UserRound :size="16" /></span>
          <div class="account-summary">
            <strong>{{ account.displayName }}</strong>
            <span class="account-username">{{ account.username }}</span>
            <div class="account-meta">
              <span class="account-role">{{ account.isAdmin ? "管理员" : "普通用户" }}</span>
              <span v-if="account.mustChangePassword" class="account-password-status">待修改密码</span>
              <span v-else class="account-password-status is-ready">密码已设置</span>
            </div>
          </div>
          <div class="account-actions">
            <button class="account-action account-action-edit" type="button" :disabled="resetting || passwordEditing" @click="openPasswordEdit(account)"><KeyRound :size="16" />修改密码</button>
            <button class="account-action account-action-reset" type="button" :disabled="resetting || passwordEditing" @click="resetAccount(account)"><RotateCcw :size="16" />重置为 admin</button>
          </div>
        </article>
        <p v-if="!accounts.length && !resetError" class="preview-hint">暂无本地账号</p>
      </div>
      <p v-if="resetError" class="form-error account-reset-error" role="alert">{{ resetError }}</p>
    </section>

    <Teleport to="body">
      <div v-if="passwordEditOpen && passwordEditAccount" class="modal-backdrop account-password-backdrop" @click.self="closePasswordEdit">
        <section class="modal-panel account-password-modal" role="dialog" aria-modal="true" aria-labelledby="account-password-title">
          <header>
            <div><KeyRound :size="20" /><h3 id="account-password-title">修改账号密码</h3></div>
            <button type="button" aria-label="关闭" :disabled="passwordEditing" @click="closePasswordEdit"><X :size="19" /></button>
          </header>
          <form class="member-form account-password-form" @submit.prevent="updateAccountPassword">
            <div class="account-password-target">
              <span class="member-avatar small" aria-hidden="true"><UserRound :size="16" /></span>
              <div><strong>{{ passwordEditAccount.displayName }}</strong><span>{{ passwordEditAccount.username }}</span></div>
            </div>
            <p class="account-password-note">设置后会撤销该账号的现有登录会话，下次登录仍需确认新密码。</p>
            <label>
              <span>新密码</span>
              <input v-model="passwordEditValue" type="password" autocomplete="new-password" minlength="8" maxlength="128" required />
              <small class="field-hint">长度 8-128 个字符</small>
            </label>
            <label>
              <span>确认新密码</span>
              <input v-model="passwordEditConfirmation" type="password" autocomplete="new-password" minlength="8" maxlength="128" required />
            </label>
            <p v-if="passwordEditError" class="form-error" role="alert">{{ passwordEditError }}</p>
            <div class="form-actions">
              <button type="button" :disabled="passwordEditing" @click="closePasswordEdit">取消</button>
              <button class="primary-button" type="submit" :disabled="passwordEditing">
                <LoaderCircle v-if="passwordEditing" class="spin-icon" :size="17" />
                <KeyRound v-else :size="17" />
                {{ passwordEditing ? "正在修改" : "保存密码" }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </Teleport>
  </section>
</template>
