<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { CircleAlert, Database, Download, History, RefreshCw, RotateCcw } from "@lucide/vue";
import EmptyState from "../../components/EmptyState.vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { useConfirm } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";
import { request } from "../../utils/api";

type DictionaryState = {
  layer: "core" | "remote";
  revision: number;
  contentSha256: string;
  snapshotId: string;
  updatedAt: string;
  sourceUrl: string | null;
};
type DictionarySnapshot = {
  id: string;
  layer: "core" | "remote";
  revision: number;
  contentSha256: string;
  sourceUrl: string | null;
  createdAt: string;
  active: number;
};
type DictionaryHistory = {
  id: string;
  operation: "core_sync" | "remote_update" | "rollback";
  layer: "core" | "remote";
  fromRevision: number | null;
  toRevision: number | null;
  snapshotId: string | null;
  status: "started" | "completed" | "failed";
  sourceUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  actorName: string | null;
};
type DictionaryStatus = {
  version: string;
  remoteBaseUrl: string;
  remoteBaseUrls: string[];
  states: DictionaryState[];
  snapshots: DictionarySnapshot[];
  history: DictionaryHistory[];
  catalog: Array<{ layer: "core" | "remote"; count: number }>;
};
type UpdateCheck = {
  currentRevision: number | null;
  latestRevision: number;
  updateAvailable: boolean;
  revisionContentChanged?: boolean;
  generatedAt: string;
  signatureVerified: boolean;
  sourceUrl: string;
  changes: {
    indicators: { added: number; updated: number; removed: number };
    aliases: { added: number; removed: number };
    taxonomy: { groupsAdded: number; groupsRemoved: number; categoriesAdded: number; categoriesRemoved: number };
    redirects: { added: number; removed: number };
    samples: { added: string[]; updated: string[]; removed: string[] };
  };
};

const confirmDialog = useConfirm();
const toast = useToast();
const status = ref<DictionaryStatus | null>(null);
const checkResult = ref<UpdateCheck | null>(null);
const loading = ref(false);
const checking = ref(false);
const updating = ref(false);
const rollbackId = ref("");
const error = ref("");

const coreState = computed(() => status.value?.states.find((item) => item.layer === "core") || null);
const remoteState = computed(() => status.value?.states.find((item) => item.layer === "remote") || null);
const remoteSnapshots = computed(() => status.value?.snapshots.filter((item) => item.layer === "remote") || []);

function countFor(layer: "core" | "remote") {
  return Number(status.value?.catalog.find((item) => item.layer === layer)?.count || 0);
}

function sourceName(value: string) {
  try {
    const host = new URL(value).host;
    if (host === "gitee.com") return "Gitee 国内镜像";
    if (host.endsWith("github.io")) return "GitHub Pages";
    return host;
  } catch {
    return value;
  }
}

const remoteSourceSummary = computed(() => {
  const sources = status.value?.remoteBaseUrls || (status.value?.remoteBaseUrl ? [status.value.remoteBaseUrl] : []);
  return sources.map((source, index) => `${sourceName(source)}${index === 0 ? "（优先）" : "（备用）"}`).join(" · ");
});

function formatTime(value: string | null) {
  if (!value) return "-";
  return new Date(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`).toLocaleString("zh-CN", {
    hour12: false
  });
}

function operationLabel(value: DictionaryHistory["operation"]) {
  if (value === "core_sync") return "同步内置字典";
  if (value === "remote_update") return "更新远程字典";
  return "回滚远程字典";
}

function statusLabel(value: DictionaryHistory["status"]) {
  if (value === "completed") return "成功";
  if (value === "failed") return "失败";
  return "处理中";
}

async function loadStatus() {
  loading.value = true;
  error.value = "";
  try {
    status.value = await request<DictionaryStatus>("maintenance/indicator-dictionary");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "指标字典状态读取失败";
  } finally {
    loading.value = false;
  }
}

async function checkUpdate() {
  checking.value = true;
  error.value = "";
  try {
    checkResult.value = await request<UpdateCheck>("maintenance/indicator-dictionary/check", { method: "POST" });
    toast.show(checkResult.value.revisionContentChanged
      ? `远程 revision ${checkResult.value.latestRevision} 内容与本地不一致`
      : checkResult.value.updateAvailable
        ? `发现远程字典 revision ${checkResult.value.latestRevision}`
        : "远程字典已经是最新版本");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "远程字典检查失败";
  } finally {
    checking.value = false;
  }
}

function forceReinstall() {
  if (!checkResult.value?.revisionContentChanged) return;
  confirmDialog.ask({
    title: "强制重装远程字典",
    message: `远程 revision ${checkResult.value.latestRevision} 的内容与本地不一致（未发版期间可能被重新发布过）。确认以远程内容覆盖重装？下载内容会先完成大小、哈希、结构和签名策略校验，失败不会改变当前字典。`,
    confirmText: "验证并重装",
    run: async () => {
      updating.value = true;
      error.value = "";
      try {
        await request("maintenance/indicator-dictionary/update", {
          method: "POST",
          body: JSON.stringify({ force: true })
        });
        checkResult.value = null;
        await loadStatus();
        toast.show("远程指标字典已重装");
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "远程字典重装失败";
      } finally {
        updating.value = false;
      }
    }
  });
}

function updateDictionary() {
  if (!checkResult.value?.updateAvailable) return;
  confirmDialog.ask({
    title: "更新远程指标字典",
    message: `确认安装 revision ${checkResult.value.latestRevision}？下载内容会先完成大小、哈希、结构和签名策略校验，失败不会改变当前字典。`,
    confirmText: "验证并更新",
    run: async () => {
      updating.value = true;
      error.value = "";
      try {
        await request("maintenance/indicator-dictionary/update", { method: "POST" });
        checkResult.value = null;
        await loadStatus();
        toast.show("远程指标字典已更新");
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "远程字典更新失败";
      } finally {
        updating.value = false;
      }
    }
  });
}

function rollback(snapshot: DictionarySnapshot) {
  confirmDialog.ask({
    title: `回滚到 revision ${snapshot.revision}`,
    message: "确认切换到该历史快照？快照会重新校验并原子物化，操作历史和较新快照仍会保留。",
    confirmText: "确认回滚",
    danger: true,
    run: async () => {
      rollbackId.value = snapshot.id;
      error.value = "";
      try {
        await request("maintenance/indicator-dictionary/rollback", {
          method: "POST",
          body: JSON.stringify({ snapshotId: snapshot.id })
        });
        checkResult.value = null;
        await loadStatus();
        toast.show(`已回滚到远程字典 revision ${snapshot.revision}`);
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "远程字典回滚失败";
      } finally {
        rollbackId.value = "";
      }
    }
  });
}

onMounted(() => {
  void loadStatus();
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader
      title="指标字典"
      description="管理核心与远程字典的 SQLite 物化、更新历史和回滚"
      back-to="/me/maintenance/indicators"
      back-label="返回指标管理"
    >
      <button class="soft-action-button compact-soft" type="button" :disabled="loading" @click="loadStatus">
        <RefreshCw :size="16" :class="{ 'spin-icon': loading }" />刷新
      </button>
    </SubPageHeader>

    <p v-if="error" class="inline-panel-error">{{ error }}</p>

    <section class="settings-band">
      <header>
        <div>
          <Database :size="20" />
          <div>
            <h3>当前生效字典</h3>
            <p>{{ status?.version || "读取中" }}</p>
          </div>
        </div>
      </header>
      <div class="maintenance-result">
        <div><span>核心 revision</span><strong>{{ coreState?.revision ?? "-" }}</strong></div>
        <div><span>核心指标</span><strong>{{ countFor("core") }}</strong></div>
        <div><span>远程 revision</span><strong>{{ remoteState?.revision ?? "未安装" }}</strong></div>
        <div><span>远程指标</span><strong>{{ countFor("remote") }}</strong></div>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <div>
          <Download :size="20" />
          <div>
            <h3>远程字典更新</h3>
            <p>{{ remoteSourceSummary || "读取远程地址中" }}</p>
          </div>
        </div>
        <div class="maintenance-actions">
          <button class="soft-action-button" type="button" :disabled="checking || updating" @click="checkUpdate">
            <RefreshCw :size="15" :class="{ 'spin-icon': checking }" />{{ checking ? "检查中" : "检查更新" }}
          </button>
          <button
            class="primary-button"
            type="button"
            :disabled="!checkResult?.updateAvailable || updating"
            @click="updateDictionary"
          >
            <Download :size="15" :class="{ 'spin-icon': updating }" />{{ updating ? "更新中" : "更新字典" }}
          </button>
        </div>
      </header>
      <p v-if="checkResult" class="preview-hint">
        远程 revision {{ checkResult.latestRevision }} ·
        {{ checkResult.updateAvailable ? "可更新" : "已是最新" }} ·
        {{ checkResult.signatureVerified ? "签名已验证" : "未配置签名验证" }} ·
        来源 {{ sourceName(checkResult.sourceUrl) }}
      </p>
      <div v-if="checkResult?.revisionContentChanged" class="dictionary-drift-notice">
        <CircleAlert :size="16" />
        <span>远程 revision {{ checkResult.latestRevision }} 的内容与本地不一致（未发版期间可能被重新发布过），可以远程内容为准强制重装。</span>
        <button class="soft-action-button" type="button" :disabled="updating" @click="forceReinstall">
          <Download :size="14" :class="{ 'spin-icon': updating }" />{{ updating ? "重装中" : "强制重装" }}
        </button>
      </div>
      <template v-if="checkResult?.changes">
        <div class="maintenance-result dictionary-change-summary">
          <div><span>新增指标</span><strong>{{ checkResult.changes.indicators.added }}</strong></div>
          <div><span>变更指标</span><strong>{{ checkResult.changes.indicators.updated }}</strong></div>
          <div><span>新增别名</span><strong>{{ checkResult.changes.aliases.added }}</strong></div>
          <div><span>新增分类</span><strong>{{ checkResult.changes.taxonomy.categoriesAdded }}</strong></div>
          <div><span>移除指标</span><strong>{{ checkResult.changes.indicators.removed }}</strong></div>
        </div>
        <p
          v-if="checkResult.changes.samples.added.length || checkResult.changes.samples.updated.length || checkResult.changes.samples.removed.length"
          class="dictionary-change-samples"
        >
          <span v-if="checkResult.changes.samples.added.length">新增：{{ checkResult.changes.samples.added.join("、") }}</span>
          <span v-if="checkResult.changes.samples.updated.length">变更：{{ checkResult.changes.samples.updated.join("、") }}</span>
          <span v-if="checkResult.changes.samples.removed.length">移除：{{ checkResult.changes.samples.removed.join("、") }}</span>
        </p>
      </template>
    </section>

    <section class="settings-band">
      <header>
        <div>
          <RotateCcw :size="20" />
          <div>
            <h3>远程快照</h3>
            <p>更新和回滚不会删除历史快照。</p>
          </div>
        </div>
      </header>
      <EmptyState
        v-if="!remoteSnapshots.length"
        title="尚未安装远程字典"
        description="核心指标字典已经可以独立使用。"
      />
      <div v-else class="maintenance-issue-rows">
        <article v-for="snapshot in remoteSnapshots" :key="snapshot.id">
          <div class="maintenance-issue-main">
            <strong>revision {{ snapshot.revision }}</strong>
            <span>{{ formatTime(snapshot.createdAt) }} · {{ snapshot.contentSha256.slice(0, 12) }}</span>
          </div>
          <div class="maintenance-issue-meta">
            <span v-if="snapshot.active" class="issue-chip issue-chip--unknown">当前生效</span>
            <button
              v-else
              class="soft-action-button compact-soft"
              type="button"
              :disabled="Boolean(rollbackId)"
              @click="rollback(snapshot)"
            >
              <RotateCcw :size="14" :class="{ 'spin-icon': rollbackId === snapshot.id }" />回滚
            </button>
          </div>
        </article>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <div>
          <History :size="20" />
          <div>
            <h3>更新历史</h3>
            <p>保留核心同步、远程更新、回滚及失败原因。</p>
          </div>
        </div>
      </header>
      <EmptyState
        v-if="status && !status.history.length"
        title="暂无更新历史"
        description="字典发生更新或回滚后会显示在这里。"
      />
      <div v-else class="maintenance-issue-rows">
        <article v-for="item in status?.history || []" :key="item.id">
          <div class="maintenance-issue-main">
            <strong>{{ operationLabel(item.operation) }}</strong>
            <span>
              {{ item.fromRevision ?? "-" }} → {{ item.toRevision ?? "-" }} ·
              {{ item.actorName || "应用启动" }} · {{ formatTime(item.createdAt) }}
            </span>
            <p v-if="item.errorMessage">{{ item.errorMessage }}</p>
          </div>
          <div class="maintenance-issue-meta">
            <span :class="`issue-chip issue-chip--${item.status === 'failed' ? 'excluded' : 'unknown'}`">
              {{ statusLabel(item.status) }}
            </span>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>
