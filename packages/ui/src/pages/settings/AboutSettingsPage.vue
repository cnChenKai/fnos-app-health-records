<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Cpu, UserRound } from "@lucide/vue";
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

const about = ref<AboutSummary | null>(null);
const message = ref("");
const subtitle = computed(() => `应用标识：${about.value?.appName || "fnos-app-health-records"}`);
const currentSchemaVersion = computed(() => about.value?.database?.appliedSchemaVersion || about.value?.database?.schemaVersion || "—");

onMounted(async () => {
  try {
    about.value = await request<AboutSummary>("about");
  } catch (error) {
    message.value = error instanceof Error ? error.message : "无法读取应用信息";
  }
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="关于" :description="subtitle" />

    <section class="settings-band about-hero">
      <div class="about-summary-grid">
        <div><span>应用版本</span><strong>{{ about?.appVersion || "加载中" }}</strong></div>
        <div><span>当前数据库版本</span><strong>v{{ currentSchemaVersion }}</strong></div>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <Cpu :size="21" />
        <div><h3>运行环境</h3><p>服务端运行时与设备架构</p></div>
      </header>
      <div class="about-summary-grid about-summary-grid--compact">
        <div><span>运行时</span><strong>{{ about?.runtime?.name || "加载中" }}</strong></div>
        <div><span>Node.js</span><strong>{{ about?.runtime?.node || "加载中" }}</strong></div>
        <div><span>平台</span><strong>{{ about?.runtime?.platform || "加载中" }}</strong></div>
        <div><span>架构</span><strong>{{ about?.runtime?.arch || "加载中" }}</strong></div>
      </div>
    </section>

    <section class="settings-band">
      <header>
        <UserRound :size="21" />
        <div><h3>开发者信息</h3><p>维护者与源代码</p></div>
      </header>
      <div class="about-kv-list">
        <div><span>维护者</span><strong>{{ about?.maintainer || "加载中" }}</strong></div>
        <div><span>源代码</span><a v-if="about?.maintainerUrl" :href="about.maintainerUrl" target="_blank" rel="noreferrer">{{ about.maintainerUrl }}</a><strong v-else>加载中</strong></div>
      </div>
    </section>

    <p v-if="message" class="runtime-message">{{ message }}</p>
  </section>
</template>
