<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ExternalLink, RefreshCw, Sparkles } from "@lucide/vue";
import EmptyState from "../../components/EmptyState.vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import { request } from "../../utils/api";
import { buildIndicatorDictionaryIssueUrl, sanitizeIndicatorFeedbackName } from "../../utils/indicator-feedback";
import type { IndicatorNormalizationIssue } from "../../types/api";

const issues = ref<IndicatorNormalizationIssue[]>([]);
const selectedNames = ref<string[]>([]);
const loading = ref(false);
const error = ref("");
const maxFeedbackNames = 40;

type AggregatedIssue = IndicatorNormalizationIssue & {
  key: string;
  units: string[];
  sections: string[];
};

function issueKey(value: string) {
  return sanitizeIndicatorFeedbackName(value)?.toLocaleLowerCase("zh-CN") || "";
}

const aggregatedIssues = computed<AggregatedIssue[]>(() => {
  const rows = new Map<string, AggregatedIssue>();
  for (const issue of issues.value) {
    const name = sanitizeIndicatorFeedbackName(issue.rawName);
    const key = issueKey(issue.rawName);
    if (!name || !key) continue;
    const current = rows.get(key);
    if (!current) {
      rows.set(key, {
        ...issue,
        rawName: name,
        key,
        units: issue.unit ? [issue.unit] : [],
        sections: issue.sectionName ? [issue.sectionName] : []
      });
      continue;
    }
    current.count += issue.count;
    if (issue.unit && !current.units.includes(issue.unit)) current.units.push(issue.unit);
    if (issue.sectionName && !current.sections.includes(issue.sectionName)) current.sections.push(issue.sectionName);
    if ((issue.latestReportIssuedAt || "") > (current.latestReportIssuedAt || "")) {
      current.latestReportIssuedAt = issue.latestReportIssuedAt;
    }
  }
  return [...rows.values()].sort((left, right) =>
    right.count - left.count || (right.latestReportIssuedAt || "").localeCompare(left.latestReportIssuedAt || "")
  );
});

const selectedIssueNames = computed(() => aggregatedIssues.value
  .filter((issue) => selectedNames.value.includes(issue.key))
  .map((issue) => issue.rawName));
const allSelected = computed(() => aggregatedIssues.value.length > 0
  && aggregatedIssues.value.slice(0, maxFeedbackNames).every((issue) => selectedNames.value.includes(issue.key)));
const feedbackUrl = computed(() => {
  return buildIndicatorDictionaryIssueUrl(selectedIssueNames.value);
});

const issueStatusLabels: Record<IndicatorNormalizationIssue["status"], string> = {
  unknown: "未命中字典",
  low: "低可信",
  excluded: "已排除"
};

function formatDate(value: string | null) {
  return value ? value.slice(0, 10) : "日期未知";
}

function toggleIssue(key: string) {
  selectedNames.value = selectedNames.value.includes(key)
    ? selectedNames.value.filter((item) => item !== key)
    : selectedNames.value.length < maxFeedbackNames ? [...selectedNames.value, key] : selectedNames.value;
}

function toggleAll() {
  selectedNames.value = allSelected.value
    ? []
    : aggregatedIssues.value.slice(0, maxFeedbackNames).map((issue) => issue.key);
}

async function loadIssues() {
  loading.value = true;
  error.value = "";
  try {
    issues.value = await request<IndicatorNormalizationIssue[]>("maintenance/indicator-normalization/issues");
    const validKeys = new Set(issues.value.map((issue) => issueKey(issue.rawName)));
    selectedNames.value = selectedNames.value.filter((key) => validKeys.has(key));
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
      description="持久化聚合未命中核心或远程字典的名称，用于后续完善远程指标字典"
      back-to="/me/maintenance/indicators"
      back-label="返回指标管理"
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
        <div class="indicator-issue-heading">
          <Sparkles :size="20" />
          <div>
            <h3>问题池列表</h3>
            <p>{{ aggregatedIssues.length }} 个名称尚未命中字典，按出现次数和最近报告排序。</p>
          </div>
        </div>
        <div class="indicator-feedback-actions">
          <button class="soft-action-button compact-soft" type="button" @click="toggleAll">
            {{ allSelected ? "取消全选" : "全选" }}
          </button>
          <a
            class="primary-button compact-primary"
            :class="{ disabled: !feedbackUrl }"
            :href="feedbackUrl || undefined"
            target="_blank"
            rel="noreferrer"
            :aria-disabled="!feedbackUrl"
            @click="!feedbackUrl && $event.preventDefault()"
          >
            <ExternalLink :size="15" />反馈{{ selectedIssueNames.length ? ` ${selectedIssueNames.length}` : "" }}项
          </a>
        </div>
      </header>
      <p class="indicator-feedback-note">一次最多选择 {{ maxFeedbackNames }} 个名称，反馈内容不会包含报告数据。</p>
      <div class="maintenance-issue-rows">
        <article v-for="issue in aggregatedIssues" :key="issue.key" class="indicator-issue-row">
          <label class="indicator-issue-check" :aria-label="`选择 ${issue.rawName}`">
            <input
              type="checkbox"
              :checked="selectedNames.includes(issue.key)"
              :disabled="!selectedNames.includes(issue.key) && selectedNames.length >= maxFeedbackNames"
              @change="toggleIssue(issue.key)"
            />
          </label>
          <div class="maintenance-issue-main">
            <strong>{{ issue.rawName }}</strong>
            <span>{{ issue.sections.join("、") || "未分组" }} · {{ issue.units.join("、") || "无单位" }}</span>
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
