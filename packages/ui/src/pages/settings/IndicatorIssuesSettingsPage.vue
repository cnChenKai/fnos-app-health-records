<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RefreshCw, Sparkles } from "@lucide/vue";
import EmptyState from "../../components/EmptyState.vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { request } from "../../utils/api";
import type { IndicatorNormalizationIssue } from "../../types/api";

const issues = ref<IndicatorNormalizationIssue[]>([]);
const loading = ref(false);
const error = ref("");

const issueStatusLabels: Record<IndicatorNormalizationIssue["status"], string> = {
  unknown: "未命中字典",
  low: "低可信",
  excluded: "已排除"
};

function formatDate(value: string | null) {
  return value ? value.slice(0, 10) : "日期未知";
}

async function loadIssues() {
  loading.value = true;
  error.value = "";
  try {
    issues.value = await request<IndicatorNormalizationIssue[]>("maintenance/indicator-normalization/issues");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "指标问题池读取失败";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadIssues();
});
</script>

<template>
  <section class="settings-page">
    <SubPageHeader
      title="指标问题池"
      description="聚合未命中字典、低可信和被排除的指标，用于后续完善指标字典与 AI 兜底规则"
      back-to="/me/maintenance"
      back-label="返回维护工具"
    >
      <button class="soft-action-button compact-soft" type="button" :disabled="loading" @click="loadIssues">
        <RefreshCw :size="16" :class="{ 'spin-icon': loading }" />刷新
      </button>
    </SubPageHeader>

    <p v-if="error" class="inline-panel-error">{{ error }}</p>
    <section v-if="loading && !issues.length" class="settings-band">
      <div class="audit-loading"><span v-for="index in 5" :key="index"></span></div>
    </section>
    <EmptyState
      v-else-if="!issues.length"
      title="暂无指标整理问题"
      description="当前没有需要关注的未命中字典、低可信或保守排除指标。"
    />
    <section v-else class="settings-band maintenance-issue-list">
      <header>
        <div>
          <Sparkles :size="20" />
          <div>
            <h3>问题池列表</h3>
            <p>{{ issues.length }} 类指标需要持续完善，按出现次数和最近报告排序。</p>
          </div>
        </div>
      </header>
      <div class="maintenance-issue-rows">
        <article v-for="issue in issues" :key="`${issue.status}-${issue.rawName}-${issue.unit || ''}-${issue.hospitalName || ''}`">
          <div class="maintenance-issue-main">
            <strong>{{ issue.rawName }}</strong>
            <span>{{ issue.sectionName || "未分组" }} · {{ issue.unit || "无单位" }} · {{ issue.hospitalName || "机构未知" }}</span>
            <p>{{ issue.reason }}</p>
          </div>
          <div class="maintenance-issue-meta">
            <span :class="`issue-chip issue-chip--${issue.status}`">{{ issueStatusLabels[issue.status] }}</span>
            <strong>{{ issue.count }} 次</strong>
            <small>{{ formatDate(issue.latestReportIssuedAt) }}</small>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>
