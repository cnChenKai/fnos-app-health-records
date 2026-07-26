<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Cpu, LoaderCircle, UserRound } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { request } from "../../utils/api";

type AboutSummary = {
  appName: string;
  appTitle: string;
  appVersion: string;
  appDescription: string;
  maintainer: string;
  maintainerUrl: string;
  distributor: string;
  distributorUrl: string;
  osMinVersion: string;
  accessMode: string;
  runtime: {
    name: string;
    node: string;
    platform: string;
    arch: string;
  };
  database: {
    driver: string;
    schemaVersion: number;
    appliedSchemaVersion: number;
    journalMode: string;
    integrity: string;
  };
};

type UpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseUrl: string;
  downloadUrl: string;
  downloadSizeBytes: number | null;
  publishedAt: string;
  checkedAt: string;
};

const about = ref<AboutSummary | null>(null);
const loadFailed = ref(false);
const message = ref("");
const placeholder = computed(() => (loadFailed.value ? "—" : "加载中"));
const subtitle = computed(() => `应用标识：${about.value?.appName || "fnos-app-health-records"}`);
const currentSchemaVersion = computed(() => about.value?.database?.appliedSchemaVersion || about.value?.database?.schemaVersion || "—");
const updateCheck = ref<UpdateCheck | null>(null);
const updateCheckState = ref<"idle" | "checking" | "failed">("idle");
const updateCheckError = ref("");

async function loadAbout() {
  loadFailed.value = false;
  message.value = "";
  try {
    about.value = await request<AboutSummary>("about");
  } catch (error) {
    loadFailed.value = true;
    message.value = error instanceof Error ? error.message : "无法读取应用信息";
  }
}

function formatBytes(value: number | null) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function checkUpdates(refresh = false) {
  updateCheckState.value = "checking";
  updateCheckError.value = "";
  try {
    updateCheck.value = await request<UpdateCheck>(refresh ? "update-check?refresh=1" : "update-check");
    updateCheckState.value = "idle";
  } catch (error) {
    updateCheckState.value = "failed";
    updateCheckError.value = error instanceof Error ? error.message : "检查更新失败";
  }
}

onMounted(() => {
  void loadAbout();
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="关于" :description="subtitle" />

    <section class="settings-band about-hero">
      <div class="about-summary-grid">
        <div><span>应用版本</span><strong>{{ about?.appVersion || placeholder }}</strong></div>
        <div><span>当前数据库版本</span><strong>v{{ currentSchemaVersion }}</strong></div>
      </div>
      <div class="about-update-row">
        <template v-if="updateCheckState === 'checking'">
          <LoaderCircle class="spin-icon" :size="15" /><span>正在检查更新…</span>
        </template>
        <template v-else-if="updateCheckState === 'failed'">
          <span class="about-update-failed">{{ updateCheckError }}</span>
          <button type="button" @click="checkUpdates(true)">重试</button>
        </template>
        <template v-else-if="updateCheck?.updateAvailable">
          <span class="about-update-available">发现新版本 v{{ updateCheck.latestVersion }}</span>
          <a
            v-if="updateCheck.downloadUrl"
            class="about-update-download"
            :href="updateCheck.downloadUrl"
            target="_blank"
            rel="noreferrer"
            title="下载 fnOS 安装包（.fpk），然后在应用中心手动安装"
          >点击下载<template v-if="formatBytes(updateCheck.downloadSizeBytes)">（{{ formatBytes(updateCheck.downloadSizeBytes) }}）</template></a>
          <a :href="updateCheck.releaseUrl" target="_blank" rel="noreferrer">查看更新</a>
          <button type="button" @click="checkUpdates(true)">重新检查</button>
        </template>
        <template v-else-if="updateCheck">
          <span>当前已是最新版本</span>
          <button type="button" @click="checkUpdates(true)">重新检查</button>
        </template>
        <template v-else>
          <button type="button" @click="checkUpdates(true)">检查更新</button>
        </template>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <Cpu :size="21" />
        <div><h3>运行环境</h3><p>服务端运行时与设备架构</p></div>
      </header>
      <div class="about-summary-grid about-summary-grid--compact">
        <div><span>运行时</span><strong>{{ about?.runtime?.name || placeholder }}</strong></div>
        <div><span>Node.js</span><strong>{{ about?.runtime?.node || placeholder }}</strong></div>
        <div><span>平台</span><strong>{{ about?.runtime?.platform || placeholder }}</strong></div>
        <div><span>架构</span><strong>{{ about?.runtime?.arch || placeholder }}</strong></div>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <UserRound :size="21" />
        <div><h3>开发者信息</h3><p>维护者与源代码</p></div>
      </header>
      <div class="about-kv-list">
        <div><span>维护者</span><strong>{{ about?.maintainer || placeholder }}</strong></div>
        <div><span>源代码</span><a v-if="about?.maintainerUrl" :href="about.maintainerUrl" target="_blank" rel="noreferrer">{{ about.maintainerUrl }}</a><strong v-else>{{ placeholder }}</strong></div>
      </div>
    </section>

    <p v-if="message" class="inline-panel-error">
      {{ message }}<button class="error-retry" type="button" @click="loadAbout">重试</button>
    </p>
  </section>
</template>
