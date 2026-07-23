<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ArchiveRestore, DatabaseBackup, Download, LoaderCircle, Trash2 } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { apiUrl, request } from "../../utils/api";
import { useAppContext } from "../../composables/useAppContext";
import { useToast } from "../../composables/useToast";
import { formatDatabaseTime } from "../../utils/time";
import type { BackupSummary } from "../../types/api";

const app = useAppContext();
const toast = useToast();
const message = ref("");
const backups = ref<BackupSummary[]>([]);
const loadingBackups = ref(false);
const creatingBackup = ref(false);
const restoringId = ref("");
const deletingId = ref("");

function formatBytes(value?: number | null) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function exportMember() {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  window.location.href = apiUrl(`export/member?memberId=${encodeURIComponent(memberId)}`);
}

async function loadBackups() {
  if (!app.session.value?.isGatewayAdmin) return;
  loadingBackups.value = true;
  try {
    backups.value = await request<BackupSummary[]>("backups");
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "备份列表加载失败";
  } finally {
    loadingBackups.value = false;
  }
}

async function createBackupNow() {
  creatingBackup.value = true;
  message.value = "";
  try {
    const backup = await request<BackupSummary>("backups", { method: "POST" });
    message.value = `完整备份已创建：${backup.filename} · ${formatBytes(backup.sizeBytes)}`;
    toast.show("备份已创建");
    await loadBackups();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "备份创建失败";
  } finally {
    creatingBackup.value = false;
  }
}

function downloadBackup(backup: BackupSummary) {
  window.location.href = apiUrl(`backups/${encodeURIComponent(backup.id)}/download`);
}

async function restoreBackup(backup: BackupSummary) {
  const confirmed = window.confirm(
    `确定从备份“${backup.filename}”恢复吗？\n\n恢复会覆盖当前数据库、报告原件、缩略图、配置和 AI 密钥。系统会先自动创建一份恢复前安全备份。`
  );
  if (!confirmed) return;
  restoringId.value = backup.id;
  message.value = "";
  try {
    const result = await request<{ restored: boolean; backupId: string; safetyBackupId: string }>(
      `backups/${encodeURIComponent(backup.id)}/restore`,
      { method: "POST" }
    );
    message.value = `恢复完成，恢复前安全备份：${result.safetyBackupId}`;
    toast.show("备份已恢复");
    await Promise.all([loadBackups(), app.load()]);
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "备份恢复失败";
  } finally {
    restoringId.value = "";
  }
}

async function deleteBackup(backup: BackupSummary) {
  const label = backup.reason === "pre_restore" ? "恢复前安全备份" : "完整备份";
  const confirmed = window.confirm(`确认删除这份${label}？\n\n${backup.filename}\n\n删除备份不会影响当前档案数据，但删除后无法再用它恢复。`);
  if (!confirmed) return;
  deletingId.value = backup.id;
  message.value = "";
  try {
    await request(`backups/${encodeURIComponent(backup.id)}`, { method: "DELETE" });
    message.value = `备份已删除：${backup.filename}`;
    toast.show("备份已删除");
    await loadBackups();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : "备份删除失败";
  } finally {
    deletingId.value = "";
  }
}

onMounted(() => {
  void loadBackups();
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="备份与恢复" description="导出成员清单，或由管理员创建和恢复完整应用备份" />

    <section class="settings-band">
      <header>
        <Download :size="20" />
        <div><h3>成员清单导出</h3><p>导出当前成员的报告元数据、指标和原件相对路径，适合核对与轻量迁移。</p></div>
      </header>
      <div class="settings-form">
        <div class="form-actions">
          <button class="primary-button" type="button" @click="exportMember"><Download :size="16" />导出当前成员</button>
        </div>
      </div>
    </section>

    <section class="settings-band backup-restore-card">
      <header>
        <DatabaseBackup :size="20" />
        <div><h3>完整应用备份</h3><p>包含 SQLite 快照、报告原件、分页图、运行配置和 AI 密钥；仅系统管理员可操作。</p></div>
        <button
          v-if="app.session.value?.isGatewayAdmin"
          class="header-action"
          type="button"
          :disabled="creatingBackup"
          @click="createBackupNow"
        >
          <LoaderCircle v-if="creatingBackup" class="spin-icon" :size="16" />
          <DatabaseBackup v-else :size="16" />
          {{ creatingBackup ? "备份中" : "创建备份" }}
        </button>
      </header>

      <div v-if="!app.session.value?.isGatewayAdmin" class="settings-form">
        <p class="preview-hint">完整备份包含所有成员的医疗数据和密钥，仅系统管理员可查看和恢复。</p>
      </div>
      <div v-else class="backup-list">
        <p v-if="message" class="preview-hint">{{ message }}</p>
        <p v-if="loadingBackups" class="backup-empty"><LoaderCircle class="spin-icon" :size="16" />正在加载备份列表</p>
        <p v-else-if="!backups.length" class="backup-empty">暂无完整备份，建议在升级、迁移或批量整理前先创建一份。</p>
        <article v-for="backup in backups" :key="backup.id" class="backup-item">
          <div class="backup-main">
            <strong>{{ backup.filename }}</strong>
            <span>{{ formatDatabaseTime(backup.createdAt) }} · {{ formatBytes(backup.sizeBytes) }} · v{{ backup.appVersion }} · DB v{{ backup.schemaVersion }}</span>
            <small>{{ backup.memberCount }} 位成员 · {{ backup.reportCount }} 份报告 · {{ backup.includes.join("、") }}</small>
          </div>
          <div class="backup-actions">
            <span v-if="backup.reason === 'pre_restore'" class="backup-tag">恢复前安全备份</span>
            <button type="button" @click="downloadBackup(backup)"><Download :size="15" />下载</button>
            <button
              class="danger-text-button"
              type="button"
              :disabled="Boolean(restoringId || deletingId)"
              @click="restoreBackup(backup)"
            >
              <LoaderCircle v-if="restoringId === backup.id" class="spin-icon" :size="15" />
              <ArchiveRestore v-else :size="15" />
              {{ restoringId === backup.id ? "恢复中" : "恢复" }}
            </button>
            <button
              class="danger-text-button"
              type="button"
              :disabled="Boolean(restoringId || deletingId)"
              @click="deleteBackup(backup)"
            >
              <LoaderCircle v-if="deletingId === backup.id" class="spin-icon" :size="15" />
              <Trash2 v-else :size="15" />
              {{ deletingId === backup.id ? "删除中" : "删除" }}
            </button>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>
