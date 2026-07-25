<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Bot, LoaderCircle, Save, TestTubeDiagonal } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import FormSelect from "../../components/FormSelect.vue";
import { request } from "../../utils/api";

type AiProviderKey = "deepseek" | "kimi" | "glm" | "qwen";
type AiProviderOption = {
  key: AiProviderKey;
  label: string;
  defaultBaseUrl: string;
  defaultTextModel: string;
  defaultVisionModel: string;
};
type AiProviderSettings = {
  visionEnabled: boolean;
  baseUrl: string;
  textModel: string;
  visionModel: string;
  apiKeyConfigured: boolean;
  apiKeyMasked: string;
};
type AiSettings = AiProviderSettings & {
  enabled: boolean;
  provider: AiProviderKey;
  apiKey: string;
  providerSettings: Record<AiProviderKey, AiProviderSettings>;
  providers: AiProviderOption[];
};

const ai = ref<AiSettings>({
  enabled: false,
  provider: "deepseek",
  visionEnabled: false,
  baseUrl: "https://api.deepseek.com",
  textModel: "deepseek-chat",
  visionModel: "",
  apiKey: "",
  apiKeyConfigured: false,
  apiKeyMasked: "",
  providerSettings: {} as Record<AiProviderKey, AiProviderSettings>,
  providers: []
});
const message = ref("");
const loading = ref(true);
const loadError = ref("");
const saving = ref(false);
const testing = ref(false);
const currentProvider = computed(() => ai.value.providers.find((item) => item.key === ai.value.provider));

function aiBody() {
  return {
    enabled: ai.value.enabled,
    provider: ai.value.provider,
    visionEnabled: ai.value.visionEnabled,
    baseUrl: ai.value.baseUrl,
    textModel: ai.value.textModel,
    visionModel: ai.value.visionModel,
    ...(ai.value.apiKey.trim() ? { apiKey: ai.value.apiKey.trim() } : {})
  };
}
function changeProvider() {
  const provider = currentProvider.value;
  if (!provider) return;
  const saved = ai.value.providerSettings[provider.key];
  ai.value.visionEnabled = saved?.visionEnabled ?? false;
  ai.value.baseUrl = saved?.baseUrl || provider.defaultBaseUrl;
  ai.value.textModel = saved?.textModel || provider.defaultTextModel;
  ai.value.visionModel = saved?.visionModel || provider.defaultVisionModel;
  ai.value.apiKeyConfigured = Boolean(saved?.apiKeyConfigured);
  ai.value.apiKeyMasked = saved?.apiKeyMasked || "";
  ai.value.apiKey = "";
  message.value = saved?.apiKeyConfigured
    ? `已载入 ${provider.label} 保存的配置`
    : `${provider.label} 尚未配置 API Key`;
}
async function save() {
  saving.value = true; message.value = "";
  try {
    ai.value = await request<AiSettings>("ai/settings", { method: "PUT", body: JSON.stringify(aiBody()) });
    message.value = `${currentProvider.value?.label || "AI"} 配置已保存`;
  }
  catch (error) { message.value = error instanceof Error ? error.message : "保存失败"; }
  finally { saving.value = false; }
}
async function test() {
  testing.value = true; message.value = "";
  try {
    const result = await request<{ model: string; elapsedMs: number }>("ai/test", {
      method: "POST",
      body: JSON.stringify(aiBody())
    });
    message.value = `${result.model} 连接正常，耗时 ${result.elapsedMs} ms`;
  }
  catch (error) { message.value = error instanceof Error ? error.message : "连接失败"; }
  finally { testing.value = false; }
}
async function loadSettings() {
  loading.value = true;
  loadError.value = "";
  try {
    ai.value = await request<AiSettings>("ai/settings");
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "AI 配置加载失败";
  } finally {
    loading.value = false;
  }
}
onMounted(() => { void loadSettings(); });
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="AI 解析模型" description="原图仅在视觉增强开启后发送" />
    <section class="settings-band">
      <header><Bot :size="21" /><div><h3>模型配置</h3><p>使用兼容 Chat Completions 的服务</p></div></header>
      <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
      <p v-else-if="loadError" class="inline-panel-error">
        {{ loadError }}<button class="error-retry" type="button" @click="loadSettings">重试</button>
      </p>
      <div v-else class="settings-form">
        <label class="toggle-row"><div><strong>启用 AI 整理</strong><span>识别后的文本由 AI 整理为结构化字段</span></div><input v-model="ai.enabled" class="switch" type="checkbox" /></label>
        <label><span>AI 服务商</span><FormSelect v-model="ai.provider" :options="ai.providers.map((provider) => ({ value: provider.key, label: provider.label }))" aria-label="AI 服务商" @change="changeProvider" /></label>
        <label class="toggle-row"><div><strong>视觉增强</strong><span>复杂表格可发送处理后的页面副本</span></div><input v-model="ai.visionEnabled" class="switch" type="checkbox" /></label>
        <label><span>API 地址</span><input v-model.trim="ai.baseUrl" :placeholder="currentProvider?.defaultBaseUrl || 'https://api.example.com/v1'" /></label>
        <div class="form-grid"><label><span>文本模型</span><input v-model.trim="ai.textModel" :placeholder="currentProvider?.defaultTextModel" /></label><label><span>视觉模型</span><input v-model.trim="ai.visionModel" :placeholder="currentProvider?.defaultVisionModel || '按需填写支持图片的模型'" /></label></div>
        <label><span>API Key</span><input v-model="ai.apiKey" type="password" autocomplete="new-password" :placeholder="ai.apiKeyConfigured ? `已配置 ${ai.apiKeyMasked}` : '输入 API Key'" /></label>
        <p v-if="message" class="form-message">{{ message }}</p>
        <div class="form-actions"><button type="button" :disabled="saving || testing" @click="test"><LoaderCircle v-if="testing" class="spin-icon" :size="17" /><TestTubeDiagonal v-else :size="17" />{{ testing ? "正在测试" : "测试连接" }}</button><button class="primary-button" type="button" :disabled="saving || testing" @click="save"><LoaderCircle v-if="saving" class="spin-icon" :size="17" /><Save v-else :size="17" />{{ saving ? "正在保存" : "保存" }}</button></div>
      </div>
    </section>
  </section>
</template>
