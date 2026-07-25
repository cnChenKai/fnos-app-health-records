<script setup lang="ts">
import { ref } from "vue";
import { GitMerge, LoaderCircle, RefreshCw, SearchCheck, Trash2 } from "@lucide/vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import ReportDetailModal from "../../components/ReportDetailModal.vue";
import { request } from "../../utils/api";
import type { DuplicateReportCandidate, DuplicateReportGroup, ReportSummary } from "../../types/api";
import { useAppContext } from "../../composables/useAppContext";
import { useConfirm } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";

const app = useAppContext();
const toast = useToast();
const confirmDialog = useConfirm();
const loading = ref(false);
const groups = ref<DuplicateReportGroup[]>([]);
const error = ref("");
const previewReportId = ref<string | null>(null);

function meta(report: ReportSummary) {
  return [report.reportIssuedAt || "日期待确认", report.hospitalName, report.departmentName, report.bodyPart]
    .filter(Boolean).join(" · ");
}

async function scan() {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  loading.value = true;
  error.value = "";
  try {
    groups.value = await request<DuplicateReportGroup[]>(`duplicates?memberId=${encodeURIComponent(memberId)}`);
    toast.show(groups.value.length ? `发现 ${groups.value.length} 组候选` : "未发现重复候选");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "重复检测失败";
  } finally {
    loading.value = false;
  }
}

function openReport(reportId: string) {
  previewReportId.value = reportId;
}

async function trash(report: ReportSummary) {
  confirmDialog.ask({
    title: "移入回收站",
    message: `确认将「${report.title}」移入回收站？原件会保留 30 天，不会立刻删除。`,
    confirmText: "移入回收站",
    danger: true,
    run: async () => {
      try {
        await request(`reports/${encodeURIComponent(report.id)}`, { method: "DELETE" });
        toast.show("报告已移入回收站");
        await scan();
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
      }
    }
  });
}

async function mergeToCandidate(source: ReportSummary, target: DuplicateReportCandidate) {
  confirmDialog.ask({
    title: "合并报告",
    message: `把「${source.title}」的原件页合并到「${target.title}」，并将当前报告移入回收站？结构化字段以目标报告为准。`,
    confirmText: "合并",
    danger: true,
    run: async () => {
      try {
        await request(`reports/${encodeURIComponent(source.id)}/merge`, {
          method: "POST",
          body: JSON.stringify({ targetReportId: target.id })
        });
        toast.show("已合并原件页，源报告已移入回收站");
        await scan();
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : "合并失败，请稍后重试");
      }
    }
  });
}
</script>

<template>
  <section class="settings-page">
    <SubPageHeader title="重复报告检测" description="手动扫描当前成员，处理疑似重复或高度重复的报告" />
    <section class="settings-band">
      <header>
        <div><SearchCheck :size="20" /><div><h3>手动扫描</h3><p>依据 AI/OCR 提取出的医院、日期、编号、科室、部位、结论和指标判断。</p></div></div>
        <button class="primary-button compact-primary" type="button" :disabled="loading" @click="scan">
          <RefreshCw :size="16" :class="{ 'spin-icon': loading }" />{{ loading ? "扫描中" : "开始检测" }}
        </button>
      </header>
      <p v-if="error" class="inline-panel-error">{{ error }}</p>
    </section>

    <EmptyState v-if="!loading && !groups.length" title="暂无重复候选" description="点击“开始检测”后，疑似重复报告会显示在这里。" />
    <div v-else class="duplicate-scan-list">
      <article v-for="group in groups" :key="group.report.id" class="settings-band duplicate-scan-card">
        <header>
          <div>
            <GitMerge :size="20" />
            <div><h3>{{ group.report.title }}</h3><p>{{ meta(group.report) }}</p></div>
          </div>
          <button type="button" @click="openReport(group.report.id)">查看当前</button>
        </header>
        <section v-for="candidate in group.candidates" :key="candidate.id" class="duplicate-scan-candidate">
          <div>
            <strong>{{ candidate.confidence === "high" ? "高度重复" : "疑似重复" }} · {{ candidate.title }}</strong>
            <span>{{ meta(candidate) }}</span>
            <small>{{ candidate.reason }} · {{ candidate.matchedFields.join("、") }}</small>
          </div>
          <div class="row-actions">
            <button type="button" @click="openReport(candidate.id)">查看已有</button>
            <button type="button" @click="mergeToCandidate(group.report, candidate)"><GitMerge :size="15" />合并到已有</button>
            <button type="button" @click="trash(group.report)"><Trash2 :size="15" />当前进回收站</button>
          </div>
        </section>
      </article>
    </div>

    <ReportDetailModal :open="Boolean(previewReportId)" :report-id="previewReportId" @close="previewReportId = null" @updated="scan" />
  </section>
</template>
