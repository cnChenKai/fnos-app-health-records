<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import {
  ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock3, Download,
  FileImage, FileText, LoaderCircle, Maximize2, Pencil, Plus, RefreshCw, RotateCw, ScrollText,
  Sparkles, Trash2, X
} from "@lucide/vue";
import ClinicalFactEditor from "./ClinicalFactEditor.vue";
import ReportStructuredSectionEditor from "./ReportStructuredSectionEditor.vue";
import FormSelect from "./FormSelect.vue";
import ImageViewer, { type ImageViewerPage } from "./ImageViewer.vue";
import MorphologyFindingEditor from "./MorphologyFindingEditor.vue";
import { request, apiUrl } from "../utils/api";
import { formatDatabaseTime } from "../utils/time";
import type {
  ClinicalEvidence, ClinicalFactType, OcrPageText, ProcessingJob, ProcessingJobEvent,
  ReportDetail, ReportPage, ReportSummary
} from "../types/api";
import { useAppContext } from "../composables/useAppContext";
import { useConfirm } from "../composables/useConfirm";
import { useScrollLock } from "../composables/useScrollLock";
import { useToast } from "../composables/useToast";

type DuplicateCandidate = ReportDetail["duplicateCandidates"][number];

const props = defineProps<{
  reportId: string;
  summary?: ReportSummary | null;
  variant: "panel" | "floating";
}>();
const emit = defineEmits<{
  close: [];
  updated: [];
  openCandidate: [candidate: DuplicateCandidate];
}>();

const app = useAppContext();
const toast = useToast();
const confirmDialog = useConfirm();
const detail = ref<ReportDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const selectedJobs = ref<ProcessingJob[]>([]);
const jobsLoading = ref(false);
const jobsError = ref("");
const processingExpanded = ref(false);
const runtimeAvailable = ref(true);
const eventSheetOpen = ref(false);
const eventLoading = ref(false);
const eventPolling = ref(false);
const eventError = ref("");
const eventJob = ref<ProcessingJob | null>(null);
const jobEvents = ref<ProcessingJobEvent[]>([]);
const viewerOpen = ref(false);
const viewerIndex = ref(0);
const pdfViewerOpen = ref(false);
const pdfViewerPage = ref<ReportPage | null>(null);
const ocrSheetOpen = ref(false);
const ocrLoading = ref(false);
const ocrError = ref("");
const ocrPages = ref<OcrPageText[]>([]);
const ocrReportId = ref<string | null>(null);
const confirming = ref(false);
const triggeringAi = ref(false);
const reprocessingReport = ref(false);
const trashingReport = ref(false);
const editOpen = ref(false);
const morphologyEditItem = ref<ReportDetail["morphologyFindings"][number] | null>(null);
const clinicalFactEditor = ref<{
  type: ClinicalFactType;
  fact: (Record<string, unknown> & { id?: string }) | null;
} | null>(null);
const structuredSectionEditor = ref<ReportDetail["structuredSections"][number] | null | "create">(null);
const allObservationsOpen = ref(false);
const editOriginalIndex = ref(0);
const savingReport = ref(false);
const savingPages = ref(false);
const editForm = ref({
  title: "", reportType: "other", hospitalName: "", hospitalBranch: "", city: "",
  departmentName: "", orderingDepartment: "", performingDepartment: "", reportingDepartment: "",
  bodyPart: "", reportIssuedAt: "", examinedAt: "", clinicalDiagnosis: "", purpose: "",
  findings: "", impression: "", summary: "", recommendation: ""
});
let jobsTimer: ReturnType<typeof setInterval> | null = null;
let eventTimer: ReturnType<typeof setInterval> | null = null;
let detailSeq = 0;
let jobsSeq = 0;
let jobsLoadingSeq = 0;
let ocrSeq = 0;
let jobsPollFailures = 0;
let eventSeq = 0;
let eventRequestPending = false;
const OBSERVATION_PREVIEW_LIMIT = 24;

/* 处理进度区默认折叠：任何写入 jobsError 的失败都要同时展开该区并 toast，否则按钮停了用户却看不到原因 */
function failJobsAction(cause: unknown, fallback: string) {
  jobsError.value = cause instanceof Error ? cause.message : fallback;
  processingExpanded.value = true;
  toast.show(jobsError.value, 3600);
}

const currentDetail = computed(() =>
  detail.value?.id === props.reportId ? detail.value : null
);
const currentSummary = computed(() =>
  props.summary?.id === props.reportId ? props.summary : null
);
const source = computed(() => currentDetail.value || currentSummary.value || null);
/* OCR 全部完成但没有任何文字：原件大概率不是有效报告，在详情顶部明确提示而非仅发通知 */
const ocrEmptyNotice = computed(() => {
  const localJobs = selectedJobs.value.filter((job) => job.jobType !== "ai_extract");
  if (!localJobs.length || localJobs.some((job) => job.status === "queued" || job.status === "processing")) return false;
  const ocrJobs = selectedJobs.value.filter((job) => job.jobType === "ocr" && job.status === "completed");
  return ocrJobs.length > 0 && ocrJobs.every((job) => !job.ocrTextLength);
});
const completedJobs = computed(() => selectedJobs.value.filter((job) => job.status === "completed").length);
const failedJobs = computed(() => selectedJobs.value.filter((job) => job.status === "failed"));
const finishedJobs = computed(() => selectedJobs.value.filter((job) => ["completed", "failed", "cancelled"].includes(job.status)).length);
const progressPercent = computed(() => {
  if (!selectedJobs.value.length) return 0;
  const progress = selectedJobs.value.reduce((sum, job) => {
    if (["completed", "failed", "cancelled"].includes(job.status)) return sum + 1;
    if (job.jobType === "ai_extract" && job.plannedUnits) {
      return sum + Math.min(1, (job.completedUnits || 0) / job.plannedUnits);
    }
    return sum;
  }, 0);
  const percent = Math.round(progress / selectedJobs.value.length * 100);
  const hasUnfinishedJob = selectedJobs.value.some((job) =>
    !["completed", "failed", "cancelled"].includes(job.status)
  );
  // AI units may all be complete while the parent job is still merging and
  // persisting results. Reserve 100% for a genuinely settled job set.
  return hasUnfinishedJob ? Math.min(percent, 99) : percent;
});
const hasRunningJobs = computed(() => selectedJobs.value.some((job) => ["queued", "processing"].includes(job.status)));
const hasProcessingJobs = computed(() => selectedJobs.value.some((job) => job.status === "processing"));
const needsOcrRuntime = computed(() =>
  !runtimeAvailable.value && selectedJobs.value.some((job) => job.jobType === "ocr" && job.status !== "completed")
);
const viewerImagePages = computed<ImageViewerPage[]>(() =>
  (detail.value?.pages || []).map((page) => ({
    key: page.id,
    fullUrl: viewerFullUrl(page),
    previewUrl: page.hasThumbnail ? thumbnailUrl(page) : undefined,
    label: `第 ${page.pageNumber} 页`,
    downloadUrl: originalUrl(page),
    downloadName: page.originalName
  }))
);
const firstPdfPage = computed(() => detail.value?.pages.find((page) => page.mimeType === "application/pdf") || null);
const currentOriginalPage = computed(() => detail.value?.pages[editOriginalIndex.value] || null);
const pdfViewerSrc = computed(() => {
  const page = pdfViewerPage.value;
  if (!page) return "";
  return `${originalUrl(page)}#page=${page.sourcePageNumber || page.pageNumber}`;
});
const hasAiContent = computed(() => Boolean(
  detail.value && (
    detail.value.summary || detail.value.findings || detail.value.impression || detail.value.recommendation
    || detail.value.clinicalDiagnosis || detail.value.purpose || detail.value.chiefComplaint
    || detail.value.observations.length || detail.value.morphologyFindings.length
    || detail.value.diagnoses.length || detail.value.medications.length || detail.value.procedures.length
    || detail.value.vaccinations.length || detail.value.billingSummary || detail.value.billingItems.length
    || detail.value.structuredSections.length
  )
));
const abnormalObservations = computed(() => detail.value?.observations.filter((item) => ["high", "low", "abnormal"].includes(String(item.abnormalFlag))) || []);
const visibleObservations = computed(() => detail.value?.observations.slice(0, OBSERVATION_PREVIEW_LIMIT) || []);
/* 重复匹配是双向的，但确认提示只属于尚未归档的新报告，避免打开已有报告时反向显示同一警告。 */
const duplicateCandidates = computed(() =>
  source.value?.status === "needs_review"
    ? currentDetail.value?.duplicateCandidates || []
    : []
);
const aiJobs = computed(() => selectedJobs.value.filter((job) => job.jobType === "ai_extract"));
const runningAiJobs = computed(() => aiJobs.value.filter((job) => ["queued", "processing"].includes(job.status)));
const failedAiJobs = computed(() => aiJobs.value.filter((job) => job.status === "failed"));
const completedAiJobs = computed(() => aiJobs.value.filter((job) => job.status === "completed"));
const canTriggerAi = computed(() => !hasAiContent.value && !runningAiJobs.value.length);
const aiTriggerLabel = computed(() => failedAiJobs.value.length || completedAiJobs.value.length ? "重新整理" : "开始 AI 整理");
const aiEmptyHint = computed(() => {
  if (runningAiJobs.value.length) return "AI 整理任务已在队列中，请稍候；处理进度里可以查看当前状态和详细日志。";
  if (failedAiJobs.value.length) return "AI 整理失败，可在处理进度里查看日志，也可以点击“重新整理”再次尝试。";
  if (completedAiJobs.value.length) return "上次 AI 整理没有得到结构化内容，可点击“重新整理”再试一次。";
  return "已有 OCR 文本后可手动触发 AI 整理；如果提示 AI 未启用，请让管理员先配置模型。";
});

const typeLabels: Record<string, string> = {
  checkup: "体检", laboratory: "检验", imaging: "影像", functional: "功能检查", pathology: "病理",
  outpatient: "门诊", inpatient: "住院", prescription: "处方", billing: "票据", vaccination: "疫苗", other: "其他"
};
const statusMeta: Record<string, { label: string; chip: string }> = {
  uploading: { label: "上传中", chip: "chip--info" },
  queued: { label: "排队中", chip: "chip--info" },
  processing: { label: "处理中", chip: "chip--info" },
  needs_review: { label: "待确认", chip: "chip--amber" },
  ready: { label: "已归档", chip: "chip--green" },
  failed: { label: "识别失败", chip: "chip--red" },
  trashed: { label: "回收站", chip: "chip--plain" }
};
const typeOptions = [
  { value: "all", label: "全部类型" },
  ...Object.entries(typeLabels).map(([value, label]) => ({ value, label }))
];
const jobStatusMeta: Record<ProcessingJob["status"], { label: string; chip: string }> = {
  queued: { label: "排队中", chip: "chip--info" },
  processing: { label: "处理中", chip: "chip--info" },
  completed: { label: "完成", chip: "chip--green" },
  failed: { label: "失败", chip: "chip--red" },
  cancelled: { label: "已取消", chip: "chip--plain" }
};
const eventTypeLabels: Record<ProcessingJobEvent["eventType"], string> = {
  queued: "进入队列",
  started: "开始处理",
  completed: "处理完成",
  retry_scheduled: "自动重试",
  failed: "最终失败",
  manual_retry: "手动重试",
  cancelled: "已取消"
};

function typeLabel(reportType: string) {
  return typeLabels[reportType] || "其他";
}

function isManualField(fieldKey: string) {
  return Boolean(detail.value?.manualFieldKeys?.includes(fieldKey));
}

function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) return "";
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (match) return `${match[1]}T${match[2]}:${match[3] || "00"}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : "";
}

function jobLabel(jobType: ProcessingJob["jobType"]) {
  return { pdf_extract: "PDF 拆页", thumbnail: "生成缩略图", ocr: "文字识别", ai_extract: "AI 整理" }[jobType];
}

function formatMs(value: number | null) {
  if (value == null) return "";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function jobMeta(job: ProcessingJob) {
  const parts = [
    job.pageNumber ? `第 ${job.pageNumber} 页${job.originalName ? ` · ${job.originalName}` : ""}` : "整份报告",
    job.startedAt ? `开始 ${formatDatabaseTime(job.startedAt)}` : `创建 ${formatDatabaseTime(job.createdAt)}`
  ];
  if (job.finishedAt) parts.push(`结束 ${formatDatabaseTime(job.finishedAt)}`);
  if (job.jobType === "ai_extract" && job.aiRequestCount) {
    parts.push(`调用 ${job.aiRequestCount} 次（成功 ${job.aiSuccessCount || 0} / 失败 ${job.aiFailureCount || 0}）`);
  } else if (job.attempts > 0) {
    parts.push(`尝试 ${job.attempts} 次`);
  }
  return parts.join(" · ");
}

function jobDetail(job: ProcessingJob) {
  if (job.errorMessage) return job.errorMessage;
  if (job.jobType === "ocr" && job.ocrEngine) {
    return [job.ocrEngine, job.ocrModelVersion, formatMs(job.ocrElapsedMs)].filter(Boolean).join(" · ");
  }
  if (
    job.jobType === "ai_extract"
    && (
      job.aiModel
      || job.aiElapsedMs != null
      || job.promptTokens != null
      || job.completionTokens != null
      || Boolean(job.unmatchedCandidates)
    )
  ) {
    const tokens = [job.promptTokens, job.completionTokens].some((value) => value != null)
      ? `${job.promptTokens || 0}/${job.completionTokens || 0} tokens`
      : "";
    const quality = job.unmatchedCandidates ? `${job.unmatchedCandidates} 项待核对` : "";
    return [job.aiModel, formatMs(job.aiElapsedMs), tokens, quality].filter(Boolean).join(" · ");
  }
  if (job.jobType === "ai_extract" && job.plannedUnits) {
    const pages = job.currentPages?.length ? `当前第 ${job.currentPages.join("、")} 页` : "";
    return [`解析单元 ${job.completedUnits || 0}/${job.plannedUnits}`, pages].filter(Boolean).join(" · ");
  }
  return job.status === "processing" ? "任务正在后台执行" : job.status === "queued" ? "等待后台队列处理" : "任务已完成";
}

function eventTitle(event: ProcessingJobEvent) {
  if (event.detail?.stage === "duplicate_precheck") return "发现重复报告";
  const prefix = eventTypeLabels[event.eventType] || event.eventType;
  return event.attempt > 0 ? `${prefix} · 第 ${event.attempt} 次尝试` : prefix;
}

function eventDetail(event: ProcessingJobEvent) {
  const payload = event.detail || {};
  const ocrSourceText = {
    pdf_text: "PDF 文字层",
    pdf_render: "PDF 高清渲染 OCR",
    pdf_text_plus_render: "PDF 文字层+高清 OCR 合并"
  }[typeof payload.ocrSource === "string" ? payload.ocrSource : ""] || "";
  const parts = [
    typeof payload.code === "string" ? `错误码 ${payload.code}` : "",
    typeof payload.elapsedMs === "number" ? `耗时 ${formatMs(payload.elapsedMs)}` : "",
    typeof payload.retryDelaySeconds === "number" ? `${payload.retryDelaySeconds} 秒后自动重试` : "",
    typeof payload.model === "string" ? String(payload.model) : "",
    typeof payload.engine === "string" ? `OCR ${payload.engine}` : "",
    typeof payload.modelVersion === "string" ? String(payload.modelVersion) : "",
    ocrSourceText,
    typeof payload.renderScale === "number" ? `${payload.renderScale}x 渲染` : "",
    typeof payload.mergedLines === "number" ? `合并 ${payload.mergedLines} 行` : "",
    typeof payload.ocrLines === "number" && typeof payload.mergedLines !== "number" ? `OCR ${payload.ocrLines} 行` : "",
    typeof payload.pdfTextLines === "number" ? `文字层 ${payload.pdfTextLines} 行` : "",
    typeof payload.imageCoverage === "number" && payload.imageCoverage > 0
      ? `图片覆盖 ${Math.round(payload.imageCoverage * 100)}%`
      : "",
    typeof payload.promptTokens === "number" || typeof payload.completionTokens === "number"
      ? `${Number(payload.promptTokens || 0)}/${Number(payload.completionTokens || 0)} tokens`
      : "",
    Array.isArray(payload.pageNumbers) && payload.pageNumbers.length
      ? `第 ${payload.pageNumbers.join("、")} 页`
      : "",
    typeof payload.unitIndex === "number" ? `单元 ${payload.unitIndex + 1}` : "",
    typeof payload.characterCount === "number" ? `${payload.characterCount} 字符` : "",
    typeof payload.candidateCount === "number" ? `${payload.candidateCount} 个候选行` : "",
    typeof payload.unmatchedCandidates === "number" && payload.unmatchedCandidates > 0
      ? `${payload.unmatchedCandidates} 项待核对`
      : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function originalUrl(page: ReportPage) {
  return apiUrl(`reports/${page.reportId}/pages/${page.id}/original`);
}

function thumbnailUrl(page: ReportPage) {
  return apiUrl(`reports/${page.reportId}/pages/${page.id}/thumbnail`);
}

function previewUrl(page: ReportPage) {
  return apiUrl(`reports/${page.reportId}/pages/${page.id}/preview`);
}

function viewerFullUrl(page: ReportPage) {
  return page.mimeType === "application/pdf" ? previewUrl(page) : originalUrl(page);
}

function openOriginalViewer(index: number) {
  if (!viewerImagePages.value[index]) return;
  viewerIndex.value = index;
  viewerOpen.value = true;
}

function openPdfOriginalViewer(page: ReportPage) {
  pdfViewerPage.value = page;
  pdfViewerOpen.value = true;
}

function closePdfOriginalViewer() {
  pdfViewerOpen.value = false;
  pdfViewerPage.value = null;
}

/* 弹层打开期间锁定背景滚动（页面缩放已全局禁用） */
useScrollLock(computed(() =>
  pdfViewerOpen.value || editOpen.value || Boolean(morphologyEditItem.value)
  || Boolean(clinicalFactEditor.value) || ocrSheetOpen.value || eventSheetOpen.value
  || Boolean(structuredSectionEditor.value) || allObservationsOpen.value
));

function abnormalLabel(value: string | null) {
  return { high: "偏高", low: "偏低", abnormal: "异常", normal: "正常" }[value || ""] || "";
}

function observationValueLine(item: ReportDetail["observations"][number]) {
  const result = (item.resultText || "").trim();
  const unit = (item.unit || "").trim();
  if (!result) return unit;
  if (!unit) return result;
  /* 部分报告的 resultText 已包含单位（如 “89 mmHg”），避免 “89 mmHg mmHg” 重复展示 */
  if (result.toLowerCase().endsWith(unit.toLowerCase())) return result;
  return `${result} ${unit}`;
}

function observationNormalizationLine(item: ReportDetail["observations"][number]) {
  if (item.canonicalName) {
    const quality = {
      high: "高可信",
      medium: "中可信",
      low: "低可信",
      excluded: "已识别"
    }[String(item.normalizationQuality)] || "已识别";
    const value = item.canonicalValue !== null && item.canonicalValue !== undefined
      ? ` · 趋势值 ${item.canonicalValue}${item.canonicalUnit ? ` ${item.canonicalUnit}` : ""}`
      : "";
    return `已整理为：${item.canonicalName} · ${quality}${value}`;
  }
  return "";
}

function medicationDetail(item: ReportDetail["medications"][number]) {
  return [
    item.specification,
    [item.dose, item.doseUnit].filter(Boolean).join(" "),
    item.frequency,
    item.route,
    item.duration,
    item.quantity ? `数量 ${item.quantity}${item.quantityUnit || ""}` : null
  ].filter(Boolean).join(" · ");
}

function procedureDetail(item: ReportDetail["procedures"][number]) {
  return [item.performedAt, item.bodyPart, item.resultText].filter(Boolean).join(" · ");
}

function billingMoney(value: number | null, currency = "CNY") {
  if (value === null || value === undefined) return "";
  return `${currency === "CNY" ? "¥" : `${currency} `}${value.toFixed(2)}`;
}

const clinicalFactTypeLabels: Record<ClinicalFactType, string> = {
  diagnosis: "诊断",
  medication: "用药",
  procedure: "操作",
  vaccination: "疫苗",
  billingSummary: "费用汇总",
  billingItem: "费用明细"
};

const structuredSectionLabels: Record<ReportDetail["structuredSections"][number]["sectionKey"], string> = {
  checkup_package: "体检套餐", checkup_positive_findings: "阳性发现",
  checkup_abnormal_summary: "异常汇总", checkup_final_conclusion: "总检结论",
  checkup_original_recommendation: "原报告建议", laboratory_specimen: "检验标本",
  laboratory_method: "检验方法", imaging_modality: "检查方式", imaging_contrast: "增强信息",
  functional_method: "检查方法", functional_description: "检查描述",
  pathology_specimen: "病理标本", pathology_gross_findings: "肉眼所见",
  pathology_microscopic_findings: "镜下所见", pathology_immunohistochemistry: "免疫组化",
  pathology_grade: "病理分级", pathology_stage: "病理分期", outpatient_history: "病史",
  outpatient_physical_examination: "体格检查", outpatient_disposition: "处置",
  outpatient_advice: "医嘱", inpatient_course: "住院经过",
  inpatient_discharge_instructions: "出院医嘱"
};

const clinicalFactAddTypes = computed<ClinicalFactType[]>(() => {
  const type = detail.value?.reportType;
  if (type === "outpatient") return ["diagnosis", "medication", "procedure"];
  if (type === "inpatient") return ["diagnosis", "medication", "procedure"];
  if (type === "prescription") return ["medication"];
  if (type === "billing") return ["billingSummary", "billingItem"];
  if (type === "vaccination") return ["vaccination"];
  if (type === "pathology") return ["diagnosis", "procedure"];
  return [];
});

function editClinicalFact(type: ClinicalFactType, fact: object | null = null) {
  clinicalFactEditor.value = {
    type,
    fact: fact ? fact as Record<string, unknown> & { id?: string } : null
  };
}

async function clinicalFactSaved() {
  await loadDetail(props.reportId, true);
  emit("updated");
}

function openClinicalEvidence(evidence: ClinicalEvidence) {
  const pageNumber = evidence[0]?.pageNumber;
  if (!pageNumber || !detail.value) {
    toast.show("这条记录没有可定位的原页证据");
    return;
  }
  const index = detail.value.pages.findIndex((page) => page.pageNumber === pageNumber);
  if (index < 0) {
    toast.show(`未找到第 ${pageNumber} 页原件`);
    return;
  }
  openOriginalViewer(index);
}

function removeClinicalFact(type: ClinicalFactType, fact: { id: string }) {
  confirmDialog.ask({
    title: `删除${clinicalFactTypeLabels[type]}`,
    message: "删除后，后续 AI 重跑也不会自动恢复同一条原文记录。",
    confirmText: "删除",
    danger: true,
    run: async () => {
      try {
        detail.value = await request<ReportDetail>(
          `clinical-facts/${type}/${encodeURIComponent(fact.id)}`,
          { method: "DELETE" }
        );
        emit("updated");
        toast.show(`${clinicalFactTypeLabels[type]}已删除`);
      } catch (cause) {
        detailError.value = cause instanceof Error ? cause.message : "删除失败";
        toast.show(detailError.value);
      }
    }
  });
}

async function structuredSectionSaved() {
  await loadDetail(props.reportId, true);
  emit("updated");
}

function removeStructuredSection(section: ReportDetail["structuredSections"][number]) {
  confirmDialog.ask({
    title: `删除${section.title}`,
    message: "删除后，后续 AI 重跑也不会自动恢复同一类原文内容。",
    confirmText: "删除",
    danger: true,
    run: async () => {
      try {
        detail.value = await request<ReportDetail>(
          `report-structured-sections/${encodeURIComponent(section.id)}`,
          { method: "DELETE" }
        );
        emit("updated");
        toast.show(`${section.title}已删除`);
      } catch (cause) {
        detailError.value = cause instanceof Error ? cause.message : "删除失败";
        toast.show(detailError.value);
      }
    }
  });
}

const morphologyLateralityLabels: Record<ReportDetail["morphologyFindings"][number]["laterality"], string> = {
  left: "左侧",
  right: "右侧",
  bilateral: "双侧",
  midline: "正中",
  unspecified: ""
};

function morphologySizeLine(item: ReportDetail["morphologyFindings"][number]) {
  const dimensions = [item.size.length, item.size.width, item.size.height]
    .filter((value): value is number => value !== null && value !== undefined);
  if (!dimensions.length) return "";
  return `${dimensions.join(" × ")}${item.size.unit ? ` ${item.size.unit}` : ""}`;
}

function morphologyLocationLine(item: ReportDetail["morphologyFindings"][number]) {
  return [
    morphologyLateralityLabels[item.laterality],
    item.organ,
    item.region
  ].filter(Boolean).join(" · ") || item.sectionName || "部位未明确";
}

function morphologyClassificationLine(item: ReportDetail["morphologyFindings"][number]) {
  if (!item.classification) return "";
  return item.classification.text
    || [item.classification.system, item.classification.value].filter(Boolean).join(" ");
}

async function morphologySaved() {
  await loadDetail(props.reportId, true);
  emit("updated");
}

function openEditReport() {
  const current = source.value;
  if (!current) return;
  const reportId = props.reportId;
  editForm.value = {
    title: current.title || "",
    reportType: current.reportType || "other",
    hospitalName: current.hospitalName || "",
    hospitalBranch: current.hospitalBranch || "",
    city: detail.value?.city || "",
    departmentName: detail.value?.visitDepartment || "",
    orderingDepartment: detail.value?.orderingDepartment || "",
    performingDepartment: detail.value?.performingDepartment || "",
    reportingDepartment: detail.value?.reportingDepartment || "",
    bodyPart: current.bodyPart || "",
    reportIssuedAt: toDateTimeLocalValue(current.reportIssuedAt),
    examinedAt: toDateTimeLocalValue(detail.value?.examinedAt),
    clinicalDiagnosis: detail.value?.clinicalDiagnosis || "",
    purpose: detail.value?.purpose || "",
    findings: detail.value?.findings || "",
    impression: detail.value?.impression || "",
    summary: detail.value?.summary || "",
    recommendation: detail.value?.recommendation || ""
  };
  editOpen.value = true;
  if (
    window.matchMedia("(min-width: 761px)").matches
    && (!ocrPages.value.length || ocrReportId.value !== reportId)
    && !ocrLoading.value
  ) {
    void loadOcrPages(reportId);
  }
}

async function saveReportFields() {
  savingReport.value = true;
  detailError.value = "";
  try {
    detail.value = await request<ReportDetail>(`reports/${encodeURIComponent(props.reportId)}`, {
      method: "PUT",
      body: JSON.stringify(editForm.value)
    });
    editOpen.value = false;
    emit("updated");
    toast.show("校对内容已保存");
  } catch (cause) {
    detailError.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    savingReport.value = false;
  }
}

async function savePageLayout(pages: ReportPage[]) {
  savingPages.value = true;
  detailError.value = "";
  try {
    detail.value = await request<ReportDetail>(`reports/${encodeURIComponent(props.reportId)}/pages`, {
      method: "PUT",
      body: JSON.stringify({ pages: pages.map((page) => ({ id: page.id, rotation: page.rotation })) })
    });
    await refreshJobs(true);
    toast.show("页面调整已保存，正在重新生成缩略图/OCR");
  } catch (cause) {
    detailError.value = cause instanceof Error ? cause.message : "页面调整失败";
  } finally {
    savingPages.value = false;
  }
}

async function rotateSavedPage(page: ReportPage) {
  if (!detail.value) return;
  await savePageLayout(detail.value.pages.map((item) => item.id === page.id ? { ...item, rotation: (item.rotation + 90) % 360 } : item));
}

async function moveSavedPage(page: ReportPage, direction: -1 | 1) {
  if (!detail.value) return;
  const pages = [...detail.value.pages];
  const index = pages.findIndex((item) => item.id === page.id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= pages.length) return;
  [pages[index], pages[target]] = [pages[target], pages[index]];
  await savePageLayout(pages);
}

async function deleteSavedPage(page: ReportPage) {
  confirmDialog.ask({
    title: "删除单页",
    message: `确认删除第 ${page.pageNumber} 页？原文件不会立即物理清理。`,
    confirmText: "删除",
    danger: true,
    run: async () => {
      savingPages.value = true;
      try {
        detail.value = await request<ReportDetail>(`reports/${encodeURIComponent(props.reportId)}/pages/${encodeURIComponent(page.id)}`, { method: "DELETE" });
        emit("updated");
        toast.show("页面已删除");
      } catch (cause) {
        detailError.value = cause instanceof Error ? cause.message : "页面删除失败";
      } finally {
        savingPages.value = false;
      }
    }
  });
}

/* 原件 swiper：触摸滑动翻页 + OCR 栏联动 */
let originalSwipeX = 0;
let originalSwipeY = 0;

function onOriginalSwipeStart(event: TouchEvent) {
  originalSwipeX = event.touches[0].clientX;
  originalSwipeY = event.touches[0].clientY;
}

function onOriginalSwipeEnd(event: TouchEvent) {
  const dx = event.changedTouches[0].clientX - originalSwipeX;
  const dy = event.changedTouches[0].clientY - originalSwipeY;
  const pageCount = detail.value?.pages.length || 0;
  if (Math.abs(dx) < 56 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
  if (dx < 0 && editOriginalIndex.value < pageCount - 1) editOriginalIndex.value += 1;
  else if (dx > 0 && editOriginalIndex.value > 0) editOriginalIndex.value -= 1;
}

watch(editOriginalIndex, (index) => {
  const page = detail.value?.pages[index];
  if (!page) return;
  document.getElementById(`edit-ocr-page-${page.pageNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

async function loadOcrPages(reportId = props.reportId) {
  const seq = ++ocrSeq;
  ocrLoading.value = true;
  ocrError.value = "";
  ocrPages.value = [];
  ocrReportId.value = null;
  try {
    const nextPages = await request<OcrPageText[]>(`reports/${encodeURIComponent(reportId)}/ocr`);
    if (seq !== ocrSeq || props.reportId !== reportId) return;
    ocrPages.value = nextPages;
    ocrReportId.value = reportId;
  } catch (cause) {
    if (seq === ocrSeq && props.reportId === reportId) {
      ocrError.value = cause instanceof Error ? cause.message : "无法读取 OCR 文本";
    }
  } finally {
    if (seq === ocrSeq && props.reportId === reportId) ocrLoading.value = false;
  }
}

async function openOcrText() {
  ocrSheetOpen.value = true;
  await loadOcrPages(props.reportId);
}

async function confirmReady() {
  confirming.value = true;
  jobsError.value = "";
  try {
    await request(`reports/${encodeURIComponent(props.reportId)}/confirm`, { method: "POST" });
    await loadDetail(props.reportId);
    emit("updated");
    toast.show("已确认归档");
  } catch (cause) {
    failJobsAction(cause, "确认归档失败");
  } finally {
    confirming.value = false;
  }
}

function askTrash() {
  confirmDialog.ask({
    title: "移入回收站",
    message: `确认将「${source.value?.title || "当前报告"}」移入回收站？原件会保留 30 天，不会立刻删除。`,
    confirmText: "移入回收站",
    danger: true,
    run: trashCurrentReport
  });
}

async function trashCurrentReport() {
  if (trashingReport.value) return;
  trashingReport.value = true;
  jobsError.value = "";
  try {
    await request(`reports/${encodeURIComponent(props.reportId)}`, { method: "DELETE" });
    stopJobsPolling();
    detail.value = null;
    selectedJobs.value = [];
    emit("updated");
    emit("close");
    toast.show("已移入回收站，原件将保留 30 天");
  } catch (cause) {
    failJobsAction(cause, "移入回收站失败");
  } finally {
    trashingReport.value = false;
  }
}

async function triggerAiExtraction() {
  triggeringAi.value = true;
  jobsError.value = "";
  try {
    await request(`reports/${encodeURIComponent(props.reportId)}/ai`, { method: "POST" });
    await refreshJobs();
    toast.show("AI 整理任务已加入队列");
  } catch (cause) {
    failJobsAction(cause, "AI 整理触发失败");
  } finally {
    triggeringAi.value = false;
  }
}

async function reprocessCurrentReport() {
  if (reprocessingReport.value) return;
  const title = source.value?.title || "当前报告";
  confirmDialog.ask({
    title: "重新识别",
    message: `确认重新识别「${title}」？\n\n会清空这份报告当前的 OCR 文本、AI 整理结果和指标，然后重新 OCR；原件不会删除，已人工校对的字段会保留且不会被 AI 自动覆盖。`,
    confirmText: "重新识别",
    run: async () => {
      reprocessingReport.value = true;
      jobsError.value = "";
      try {
        const result = await request<{ queuedOcr: number; aiWillRun: boolean }>(
          `reports/${encodeURIComponent(props.reportId)}/reprocess`,
          { method: "POST" }
        );
        processingExpanded.value = true;
        await refreshJobs();
        await loadDetail(props.reportId, true);
        emit("updated");
        toast.show(result.aiWillRun
          ? `已重新排队 OCR ${result.queuedOcr} 页，完成后会自动 AI 整理`
          : `已重新排队 OCR ${result.queuedOcr} 页，AI 未配置时需稍后手动整理`);
      } catch (cause) {
        failJobsAction(cause, "重新识别失败");
      } finally {
        reprocessingReport.value = false;
      }
    }
  });
}

function handleViewerKeydown(event: KeyboardEvent) {
  if (pdfViewerOpen.value && event.key === "Escape") {
    closePdfOriginalViewer();
    event.preventDefault();
  }
}

function stopJobsPolling() {
  if (jobsTimer) clearInterval(jobsTimer);
  jobsTimer = null;
}

function stopEventPolling() {
  if (eventTimer) clearInterval(eventTimer);
  eventTimer = null;
  eventPolling.value = false;
}

function eventJobIsRunning(jobId: string) {
  const current = selectedJobs.value.find((job) => job.id === jobId) || eventJob.value;
  return Boolean(current && ["queued", "processing"].includes(current.status));
}

function startEventPolling(jobId: string) {
  stopEventPolling();
  if (!eventSheetOpen.value || !eventJobIsRunning(jobId)) return;
  eventPolling.value = true;
  eventTimer = setInterval(() => { void loadJobEvents(jobId, true); }, 2000);
}

function maybeStartJobsPolling() {
  stopJobsPolling();
  if (hasRunningJobs.value || source.value?.status === "queued" || source.value?.status === "processing") {
    jobsTimer = setInterval(() => { void refreshJobs(true); }, 2500);
  }
}

/* 详情/列表/提醒级联刷新的节流时间戳：处理中任务状态几乎每轮都变，避免每 2.5 秒拉一整页数据 */
let lastDetailSyncAt = 0;

async function refreshJobs(silent = false) {
  if (!props.reportId) return;
  const reportId = props.reportId;
  const seq = ++jobsSeq;
  const previousStatuses = new Map(selectedJobs.value.map((job) => [job.id, job.status]));
  if (!silent) {
    jobsLoadingSeq = seq;
    jobsLoading.value = true;
  }
  jobsError.value = "";
  try {
    /* OCR 运行状态只在打开报告/手动重试（非轮询）时查询，轮询周期内不再重复请求 */
    const [nextJobs, ocr] = await Promise.all([
      request<ProcessingJob[]>(`jobs?reportId=${encodeURIComponent(reportId)}`),
      !silent && app.session.value?.isGatewayAdmin ? request<{ available: boolean }>("ocr/status") : Promise.resolve(null)
    ]);
    if (seq !== jobsSeq || props.reportId !== reportId) return;
    const jobStatusChanged = nextJobs.length !== previousStatuses.size
      || nextJobs.some((job) => previousStatuses.get(job.id) !== job.status);
    selectedJobs.value = nextJobs;
    if (eventJob.value) {
      eventJob.value = nextJobs.find((job) => job.id === eventJob.value?.id) || eventJob.value;
    }
    jobsPollFailures = 0;
    if (ocr) runtimeAvailable.value = ocr.available;
    const settled = nextJobs.length > 0 && nextJobs.every((job) => ["completed", "failed"].includes(job.status));
    const newlyFailed = nextJobs.some((job) => job.status === "failed" && previousStatuses.get(job.id) !== "failed");
    /* 级联刷新（详情+提醒+列表）节流 10 秒；任务全部结束或出现新失败时立即同步 */
    const shouldSync = jobStatusChanged && (settled || newlyFailed || Date.now() - lastDetailSyncAt > 10000);
    if (shouldSync && props.reportId === reportId) {
      lastDetailSyncAt = Date.now();
      await loadDetail(reportId, true);
      if (app.selectedMemberId.value) await app.refreshReminderCount(app.selectedMemberId.value);
      emit("updated");
    }
    maybeStartJobsPolling();
  } catch (cause) {
    if (seq !== jobsSeq || props.reportId !== reportId) return;
    jobsPollFailures += 1;
    /* 轮询允许偶发失败（网络抖动），连续 3 次失败才停止并提示，避免进度条假死 */
    if (!silent || jobsPollFailures >= 3) {
      failJobsAction(cause, "无法读取处理进度");
      stopJobsPolling();
    }
  } finally {
    if (!silent && jobsLoadingSeq === seq && props.reportId === reportId) jobsLoading.value = false;
  }
}

async function loadDetail(reportId: string, preserveCurrent = false) {
  const seq = ++detailSeq;
  detailLoading.value = true;
  detailError.value = "";
  if (!preserveCurrent) detail.value = null;
  try {
    const next = await request<ReportDetail>(`reports/${encodeURIComponent(reportId)}`);
    if (seq === detailSeq && props.reportId === reportId && next.id === reportId) detail.value = next;
  } catch (cause) {
    if (seq === detailSeq && props.reportId === reportId) {
      detailError.value = cause instanceof Error ? cause.message : "报告详情读取失败";
    }
  } finally {
    if (seq === detailSeq && props.reportId === reportId) detailLoading.value = false;
  }
}

async function retryJob(job: ProcessingJob) {
  jobsError.value = "";
  try {
    await request(`jobs/${job.id}/retry`, { method: "POST" });
    await refreshJobs();
  } catch (cause) {
    failJobsAction(cause, "任务重试失败");
  }
}

async function openJobEvents(job: ProcessingJob) {
  const seq = ++eventSeq;
  stopEventPolling();
  eventJob.value = job;
  eventSheetOpen.value = true;
  eventError.value = "";
  jobEvents.value = [];
  await loadJobEvents(job.id, false, seq);
  if (seq === eventSeq && eventSheetOpen.value) startEventPolling(job.id);
}

async function loadJobEvents(jobId: string, silent = false, expectedSeq = eventSeq) {
  if (eventRequestPending || !eventSheetOpen.value || eventJob.value?.id !== jobId) return;
  eventRequestPending = true;
  if (!silent) eventLoading.value = true;
  try {
    const nextEvents = await request<ProcessingJobEvent[]>(`jobs/${jobId}/events`);
    if (expectedSeq !== eventSeq || !eventSheetOpen.value || eventJob.value?.id !== jobId) return;
    jobEvents.value = nextEvents;
    eventError.value = "";
    if (!eventJobIsRunning(jobId)) stopEventPolling();
  } catch (cause) {
    if (expectedSeq === eventSeq && eventSheetOpen.value && eventJob.value?.id === jobId) {
      eventError.value = cause instanceof Error ? cause.message : "无法读取详细日志";
    }
  } finally {
    eventRequestPending = false;
    if (!silent && expectedSeq === eventSeq) eventLoading.value = false;
  }
}

function closeJobEvents() {
  eventSeq += 1;
  stopEventPolling();
  eventSheetOpen.value = false;
  eventJob.value = null;
  jobEvents.value = [];
  eventError.value = "";
  eventLoading.value = false;
}

watch(() => props.reportId, (reportId) => {
  stopJobsPolling();
  closeJobEvents();
  jobsSeq += 1;
  jobsLoadingSeq = 0;
  ocrSeq += 1;
  selectedJobs.value = [];
  jobsLoading.value = false;
  jobsPollFailures = 0;
  jobsError.value = "";
  processingExpanded.value = false;
  ocrSheetOpen.value = false;
  ocrPages.value = [];
  ocrReportId.value = null;
  ocrLoading.value = false;
  ocrError.value = "";
  editOpen.value = false;
  allObservationsOpen.value = false;
  editOriginalIndex.value = 0;
  if (!reportId) {
    detail.value = null;
    return;
  }
  /* 打开报告时 watch 已拉详情，标记同步时间点避免首轮轮询重复级联 */
  lastDetailSyncAt = Date.now();
  void loadDetail(reportId);
  void refreshJobs();
}, { immediate: true });

onMounted(() => {
  window.addEventListener("keydown", handleViewerKeydown);
});
onBeforeUnmount(() => {
  stopJobsPolling();
  stopEventPolling();
  eventSeq += 1;
  window.removeEventListener("keydown", handleViewerKeydown);
});
/* 随 KeepAlive 页面失活暂停任务轮询，激活时立即刷新一次并按任务状态恢复轮询 */
onDeactivated(() => {
  stopJobsPolling();
  stopEventPolling();
});
onActivated(() => {
  if (hasRunningJobs.value || source.value?.status === "queued" || source.value?.status === "processing") {
    void refreshJobs(true);
  }
  if (eventSheetOpen.value && eventJob.value) {
    void loadJobEvents(eventJob.value.id, true);
    startEventPolling(eventJob.value.id);
  }
});
</script>

<template>
  <header v-if="variant === 'floating'" class="sheet-header report-detail-floating-header">
    <h3>{{ source?.title || "报告详情" }}</h3>
    <button class="plain-icon-button" type="button" title="关闭" @click="emit('close')"><X :size="18" /></button>
  </header>
  <div v-if="!source" class="mini-loading report-detail-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取报告详情</div>
  <div v-else class="preview-stack" :class="{ 'preview-stack--floating': variant === 'floating' }">
    <article class="preview-card">
      <div class="preview-heading">
        <span class="chip chip--type">{{ typeLabel(source.reportType) }}</span>
        <span v-if="statusMeta[source.status]" class="chip" :class="statusMeta[source.status].chip">
          {{ statusMeta[source.status].label }}
        </span>
        <button class="preview-trash-button" type="button" title="移入回收站" :disabled="trashingReport" @click="askTrash">
          <LoaderCircle v-if="trashingReport" class="spin-icon" :size="16" />
          <Trash2 v-else :size="16" />
        </button>
      </div>
      <h3>{{ source.title }}</h3>
      <p v-if="detailError" class="inline-panel-error">{{ detailError }}</p>
      <div v-if="ocrEmptyNotice" class="runtime-warning compact">
        <CircleAlert :size="18" />
        <div><strong>没有识别到文字</strong><span>这份报告的原件上没有识别到任何文字，可能不是有效的体检报告。可重新上传清晰原件，或直接手动校对填写。</span></div>
      </div>
      <dl class="preview-facts">
        <div><dt>报告日期</dt><dd>{{ source.reportIssuedAt || "日期待确认" }}<span v-if="isManualField('reportIssuedAt')" class="manual-field-chip">人工校对</span></dd></div>
        <div><dt>医院</dt><dd>{{ [source.hospitalName, source.hospitalBranch].filter(Boolean).join(" · ") || "待整理" }}<span v-if="isManualField('hospitalName') || isManualField('hospitalBranch')" class="manual-field-chip">人工校对</span></dd></div>
        <div><dt>科室</dt><dd>{{ source.departmentName || "待整理" }}<span v-if="['departmentName', 'performingDepartment', 'reportingDepartment', 'orderingDepartment'].some(isManualField)" class="manual-field-chip">人工校对</span></dd></div>
        <div><dt>部位</dt><dd>{{ source.bodyPart || "待整理" }}<span v-if="isManualField('bodyParts')" class="manual-field-chip">人工校对</span></dd></div>
        <div><dt>页数</dt><dd>{{ source.pageCount || 0 }} 页</dd></div>
        <div><dt>状态</dt><dd>{{ statusMeta[source.status]?.label || source.status }}</dd></div>
      </dl>
      <div v-if="detailLoading" class="mini-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取报告详情</div>
      <div class="report-action-row">
        <button v-if="source.status === 'needs_review'" class="primary-button compact-primary" type="button" :disabled="confirming" @click="confirmReady">
          <LoaderCircle v-if="confirming" class="spin-icon" :size="17" />
          <CheckCircle2 v-else :size="17" />
          {{ confirming ? "确认中" : "确认归档" }}
        </button>
        <button class="soft-action-button" type="button" @click="openEditReport"><Pencil :size="17" />校对字段</button>
        <button class="soft-action-button" type="button" @click="openOcrText"><ScrollText :size="17" />查看 OCR</button>
        <button v-if="firstPdfPage" class="soft-action-button" type="button" @click="openPdfOriginalViewer(firstPdfPage)"><FileText :size="17" />查看 PDF</button>
      </div>
      <section v-if="duplicateCandidates.length" class="duplicate-warning">
        <CircleAlert :size="18" />
        <div>
          <strong>可能已上传过这份报告</strong>
          <p>系统根据原件、OCR 和已整理的报告内容发现 {{ duplicateCandidates.length }} 个候选，确认归档前建议先核对。若自动 AI 整理已暂缓，仍可在下方手动继续。</p>
          <button
            v-for="candidate in duplicateCandidates"
            :key="candidate.id"
            class="duplicate-candidate-button"
            type="button"
            @click="emit('openCandidate', candidate)"
          >
            查看已有报告 · {{ candidate.confidence === "high" ? "高度重复" : "疑似重复" }} · {{ candidate.title }}
            <span>{{ candidate.reason }} · {{ candidate.matchedFields.join("、") }}</span>
          </button>
          <div v-if="source.status === 'needs_review'" class="duplicate-actions">
            <button class="duplicate-confirm-button" type="button" :disabled="confirming" @click="confirmReady">
              <CheckCircle2 :size="15" />仍然确认归档
            </button>
          </div>
        </div>
      </section>
    </article>

    <article class="preview-card ai-result-card">
      <div class="section-title-row">
        <div><h4>AI 整理结果</h4><p>{{ hasAiContent ? "以下内容来自 OCR 后的结构化整理，确认前请核对原件。" : "AI 尚未整理出结构化内容。" }}</p></div>
        <div class="section-title-actions">
          <button v-if="canTriggerAi" class="soft-action-button ai-trigger-button" type="button" :disabled="triggeringAi" @click="triggerAiExtraction">
            <LoaderCircle v-if="triggeringAi" class="spin-icon" :size="16" />
            <Sparkles v-else :size="16" />
            {{ triggeringAi ? "提交中" : aiTriggerLabel }}
          </button>
          <Sparkles :size="19" />
        </div>
      </div>
      <div v-if="hasAiContent" class="ai-content">
        <section v-if="detail?.summary || detail?.impression || detail?.recommendation" class="ai-section-grid">
          <article v-if="detail?.summary"><span>摘要<em v-if="isManualField('summary')" class="manual-field-chip">人工校对</em></span><p>{{ detail.summary }}</p></article>
          <article v-if="detail?.impression"><span>结论<em v-if="isManualField('impression')" class="manual-field-chip">人工校对</em></span><p>{{ detail.impression }}</p></article>
          <article v-if="detail?.recommendation"><span>建议/复查<em v-if="isManualField('recommendation')" class="manual-field-chip">人工校对</em></span><p>{{ detail.recommendation }}</p></article>
        </section>
        <section v-if="detail?.clinicalDiagnosis || detail?.purpose || detail?.chiefComplaint || detail?.findings" class="ai-long-text">
          <article v-if="detail?.clinicalDiagnosis"><span>临床诊断<em v-if="isManualField('clinicalDiagnosis')" class="manual-field-chip">人工校对</em></span><p>{{ detail.clinicalDiagnosis }}</p></article>
          <article v-if="detail?.purpose"><span>检查目的<em v-if="isManualField('purpose')" class="manual-field-chip">人工校对</em></span><p>{{ detail.purpose }}</p></article>
          <article v-if="detail?.chiefComplaint"><span>主诉<em v-if="isManualField('chiefComplaint')" class="manual-field-chip">人工校对</em></span><p>{{ detail.chiefComplaint }}</p></article>
          <article v-if="detail?.findings"><span>检查所见<em v-if="isManualField('findings')" class="manual-field-chip">人工校对</em></span><p>{{ detail.findings }}</p></article>
        </section>
        <section v-if="clinicalFactAddTypes.length" class="clinical-fact-add-strip">
          <span>补充分类信息</span>
          <div>
            <button v-for="type in clinicalFactAddTypes" :key="type" type="button" @click="editClinicalFact(type)">
              <Plus :size="15" />{{ clinicalFactTypeLabels[type] }}
            </button>
          </div>
        </section>
        <section
          v-if="detail && ['checkup', 'laboratory', 'imaging', 'functional', 'pathology', 'outpatient', 'inpatient'].includes(detail.reportType)"
          class="clinical-fact-add-strip"
        >
          <span>报告专属内容</span>
          <div>
            <button type="button" @click="structuredSectionEditor = 'create'">
              <Plus :size="15" />补充内容
            </button>
          </div>
        </section>
        <section v-if="detail?.structuredSections.length" class="clinical-fact-panel structured-section-panel">
          <header><strong>报告专属内容</strong><span>共 {{ detail.structuredSections.length }} 项</span></header>
          <div class="structured-section-list">
            <article v-for="item in detail.structuredSections" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>
                  {{ item.title || structuredSectionLabels[item.sectionKey] }}
                  <em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em>
                </strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" title="查看原页" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对专属内容" @click="structuredSectionEditor = item"><Pencil :size="15" /></button>
                  <button type="button" title="删除专属内容" @click="removeStructuredSection(item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ item.content }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.diagnoses.length" class="clinical-fact-panel">
          <header><strong>诊断记录</strong><span>共 {{ detail.diagnoses.length }} 项</span></header>
          <div class="clinical-fact-list">
            <article v-for="item in detail.diagnoses" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.diagnosisText }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" title="查看原页" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对诊断" @click="editClinicalFact('diagnosis', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除诊断" @click="removeClinicalFact('diagnosis', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ [item.sectionName, item.diagnosisCode, item.codeSystem].filter(Boolean).join(" · ") || "原报告诊断" }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.medications.length" class="clinical-fact-panel">
          <header><strong>用药记录</strong><span>共 {{ detail.medications.length }} 项</span></header>
          <div class="clinical-fact-list">
            <article v-for="item in detail.medications" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.medicationName }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" title="查看原页" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对用药" @click="editClinicalFact('medication', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除用药" @click="removeClinicalFact('medication', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ medicationDetail(item) || item.instructions || "原报告未注明详细用法" }}</p>
              <small v-if="item.instructions && medicationDetail(item)">{{ item.instructions }}</small>
            </article>
          </div>
        </section>
        <section v-if="detail?.procedures.length" class="clinical-fact-panel">
          <header><strong>诊疗与操作</strong><span>共 {{ detail.procedures.length }} 项</span></header>
          <div class="clinical-fact-list">
            <article v-for="item in detail.procedures" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.procedureName }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" title="查看原页" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对操作" @click="editClinicalFact('procedure', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除操作" @click="removeClinicalFact('procedure', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ procedureDetail(item) || item.sectionName || "原报告诊疗记录" }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.vaccinations.length" class="clinical-fact-panel">
          <header><strong>疫苗接种</strong><span>共 {{ detail.vaccinations.length }} 项</span></header>
          <div class="clinical-fact-list">
            <article v-for="item in detail.vaccinations" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.vaccineName }}<template v-if="item.doseNumber"> · {{ item.doseNumber }}</template><em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" title="查看原页" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对疫苗" @click="editClinicalFact('vaccination', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除疫苗" @click="removeClinicalFact('vaccination', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ [item.administeredAt, item.manufacturer, item.lotNumber ? `批号 ${item.lotNumber}` : null, item.administrationSite].filter(Boolean).join(" · ") || "原报告接种记录" }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.billingSummary || detail?.billingItems.length" class="clinical-fact-panel">
          <header><strong>费用信息</strong><span>{{ detail.billingItems.length }} 项明细</span></header>
          <div v-if="detail.billingSummary" class="billing-summary-block">
            <div class="billing-summary-line">
              <span v-if="detail.billingSummary.totalAmount !== null">合计 <strong>{{ billingMoney(detail.billingSummary.totalAmount, detail.billingSummary.currency) }}</strong></span>
              <span v-if="detail.billingSummary.insuranceAmount !== null">医保 <strong>{{ billingMoney(detail.billingSummary.insuranceAmount, detail.billingSummary.currency) }}</strong></span>
              <span v-if="detail.billingSummary.selfPayAmount !== null">自费 <strong>{{ billingMoney(detail.billingSummary.selfPayAmount, detail.billingSummary.currency) }}</strong></span>
              <em v-if="detail.billingSummary.manualFields.length" class="manual-field-chip">人工校对</em>
            </div>
            <div class="clinical-fact-actions">
              <button v-if="detail.billingSummary.evidence.length" type="button" title="查看原页" @click="openClinicalEvidence(detail.billingSummary.evidence)"><FileImage :size="15" /></button>
              <button type="button" title="校对费用汇总" @click="editClinicalFact('billingSummary', detail.billingSummary)"><Pencil :size="15" /></button>
              <button type="button" title="删除费用汇总" @click="removeClinicalFact('billingSummary', detail.billingSummary)"><Trash2 :size="15" /></button>
            </div>
          </div>
          <div v-if="detail.billingItems.length" class="clinical-fact-list">
            <article v-for="item in detail.billingItems" :key="item.id">
              <div class="clinical-fact-heading">
                <strong>{{ item.itemName }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                <div class="clinical-fact-actions">
                  <button v-if="item.evidence.length" type="button" title="查看原页" @click="openClinicalEvidence(item.evidence)"><FileImage :size="15" /></button>
                  <button type="button" title="校对费用明细" @click="editClinicalFact('billingItem', item)"><Pencil :size="15" /></button>
                  <button type="button" title="删除费用明细" @click="removeClinicalFact('billingItem', item)"><Trash2 :size="15" /></button>
                </div>
              </div>
              <p>{{ [item.category, billingMoney(item.amount, detail.billingSummary?.currency || 'CNY')].filter(Boolean).join(" · ") }}</p>
            </article>
          </div>
        </section>
        <section v-if="detail?.morphologyFindings.length" class="morphology-panel">
          <header>
            <strong>形态学发现</strong>
            <span>共 {{ detail.morphologyFindings.length }} 项</span>
          </header>
          <div class="morphology-list">
            <article v-for="item in detail.morphologyFindings" :key="item.id">
              <div class="morphology-heading">
                <div>
                  <strong>{{ item.findingName }}<em v-if="item.manualFields.length" class="manual-field-chip">人工校对</em></strong>
                  <span>{{ morphologyLocationLine(item) }}</span>
                </div>
                <div class="morphology-heading-actions">
                  <em v-if="item.presence !== 'present'" :class="`morphology-presence morphology-presence--${item.presence}`">
                    {{ item.presence === "absent" ? "未见" : "待确认" }}
                  </em>
                  <button class="plain-icon-button" type="button" title="校对形态字段" @click="morphologyEditItem = item"><Pencil :size="16" /></button>
                </div>
              </div>
              <div v-if="morphologySizeLine(item) || morphologyClassificationLine(item)" class="morphology-facts">
                <span v-if="morphologySizeLine(item)">尺寸 <strong>{{ morphologySizeLine(item) }}</strong></span>
                <span v-if="morphologyClassificationLine(item)">分级 <strong>{{ morphologyClassificationLine(item) }}</strong></span>
              </div>
              <p v-if="item.morphology">{{ item.morphology }}</p>
              <div v-if="item.measurements.length" class="morphology-measurements">
                <span v-for="measurement in item.measurements" :key="`${measurement.key}-${measurement.value}-${measurement.unit || ''}`">
                  {{ measurement.key }} {{ measurement.value }}{{ measurement.unit ? ` ${measurement.unit}` : "" }}
                </span>
              </div>
              <details v-if="item.rawText" class="morphology-raw">
                <summary>查看原文<template v-if="item.evidence[0]?.pageNumber"> · 第 {{ item.evidence[0].pageNumber }} 页</template></summary>
                <p>{{ item.rawText }}</p>
              </details>
            </article>
          </div>
        </section>
        <section v-if="detail?.observations.length" class="observation-panel">
          <header>
            <strong>结构化指标</strong>
            <span>共 {{ detail.observations.length }} 项<template v-if="abnormalObservations.length"> · {{ abnormalObservations.length }} 项异常</template></span>
          </header>
          <div class="observation-list">
            <article v-for="item in visibleObservations" :key="item.id">
              <strong>{{ item.itemName }}</strong>
              <p>{{ observationValueLine(item) }}<em v-if="item.abnormalFlag" :class="{ abnormal: item.abnormalFlag !== 'normal' }">{{ abnormalLabel(item.abnormalFlag) }}</em></p>
              <div class="observation-meta"><span>{{ item.sectionName || item.normalizedName || "未分组" }}</span><span v-if="item.referenceText">参考 {{ item.referenceText }}</span></div>
              <small v-if="observationNormalizationLine(item)" class="observation-normalization-line">{{ observationNormalizationLine(item) }}</small>
              <small v-if="item.canonicalExplanation" class="observation-explanation-line">说明：{{ item.canonicalExplanation }}</small>
            </article>
          </div>
          <div v-if="detail.observations.length > visibleObservations.length" class="observation-panel-footer">
            <span>已显示前 {{ visibleObservations.length }} 项</span>
            <button type="button" @click="allObservationsOpen = true">
              查看全部
              <ChevronRight :size="16" />
            </button>
          </div>
        </section>
      </div>
      <div v-else class="preview-hint">{{ aiEmptyHint }}</div>
    </article>

    <MorphologyFindingEditor
      :open="Boolean(morphologyEditItem)"
      :finding="morphologyEditItem"
      @close="morphologyEditItem = null"
      @saved="morphologySaved"
    />
    <ClinicalFactEditor
      v-if="clinicalFactEditor"
      :open="Boolean(clinicalFactEditor)"
      :report-id="props.reportId"
      :type="clinicalFactEditor.type"
      :fact="clinicalFactEditor.fact"
      @close="clinicalFactEditor = null"
      @saved="clinicalFactSaved"
    />
    <ReportStructuredSectionEditor
      v-if="structuredSectionEditor && detail"
      :open="Boolean(structuredSectionEditor)"
      :report-id="props.reportId"
      :report-type="detail.reportType"
      :section="structuredSectionEditor === 'create' ? null : structuredSectionEditor"
      @close="structuredSectionEditor = null"
      @saved="structuredSectionSaved"
    />

    <article class="preview-card processing-card">
      <div class="section-title-row">
        <div>
          <h4>处理进度</h4>
          <p v-if="selectedJobs.length">已完成 {{ completedJobs }} / {{ selectedJobs.length }}，失败 {{ failedJobs.length }} 个</p>
          <p v-else>{{ jobsLoading ? "正在读取任务状态" : "这份报告暂无后台任务记录" }}</p>
        </div>
        <div class="section-title-actions">
          <button class="soft-action-button reprocess-action-button" type="button" :disabled="reprocessingReport || hasProcessingJobs" @click="reprocessCurrentReport">
            <LoaderCircle v-if="reprocessingReport" class="spin-icon" :size="16" />
            <RefreshCw v-else :size="16" />
            {{ reprocessingReport ? "提交中" : "重跑 OCR+AI" }}
          </button>
          <button
            v-if="selectedJobs.length || jobsError || needsOcrRuntime"
            class="collapse-toggle"
            type="button"
            :aria-expanded="processingExpanded"
            @click="processingExpanded = !processingExpanded"
          >
            <ChevronDown :size="16" :class="{ rotated: processingExpanded }" />
            {{ processingExpanded ? "收起" : "展开" }}
          </button>
          <button class="plain-icon-button" type="button" title="刷新处理进度" :disabled="jobsLoading" @click="refreshJobs()">
            <RefreshCw :size="17" :class="{ 'spin-icon': jobsLoading }" />
          </button>
        </div>
      </div>
      <div v-if="selectedJobs.length" class="job-progress-compact">
        <div class="job-progress-bar" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
          <span :style="{ width: `${progressPercent}%` }"></span>
        </div>
        <strong>{{ progressPercent }}%</strong>
      </div>
      <div v-if="processingExpanded" class="processing-details">
        <div v-if="needsOcrRuntime" class="runtime-warning compact">
          <CircleAlert :size="18" />
          <div><strong>等待安装本地 OCR 环境</strong><span>{{ app.session.value?.isGatewayAdmin ? "原件已保存，安装后任务会自动继续。" : "原件已保存，请联系 fnOS 管理员安装 OCR 环境。" }}</span></div>
          <RouterLink v-if="app.session.value?.isGatewayAdmin" to="/me/runtime">去设置</RouterLink>
        </div>
        <p v-if="jobsError" class="inline-panel-error">{{ jobsError }}</p>
        <div v-if="selectedJobs.length" class="job-log-list">
          <article v-for="job in selectedJobs" :key="job.id" class="job-log-item">
            <span class="job-icon" :class="`job-icon--${job.status}`">
              <CheckCircle2 v-if="job.status === 'completed'" :size="17" />
              <CircleAlert v-else-if="job.status === 'failed'" :size="17" />
              <LoaderCircle v-else-if="job.status === 'processing'" class="spin-icon" :size="17" />
              <Clock3 v-else :size="17" />
            </span>
            <div>
              <header>
                <strong>{{ jobLabel(job.jobType) }}</strong>
                <span class="chip" :class="jobStatusMeta[job.status].chip">{{ jobStatusMeta[job.status].label }}</span>
              </header>
              <span>{{ jobMeta(job) }}</span>
              <small>{{ jobDetail(job) }}</small>
            </div>
            <div class="job-log-actions">
              <button type="button" @click="openJobEvents(job)"><ScrollText :size="16" />日志</button>
              <button v-if="job.status === 'failed'" class="retry-action" type="button" @click="retryJob(job)"><RefreshCw :size="16" />重试</button>
            </div>
          </article>
        </div>
      </div>
    </article>

    <article class="preview-card originals-card">
      <div class="section-title-row">
        <div><h4>报告原件</h4><p>点击打开原图或 PDF 原件</p></div>
      </div>
      <div v-if="detail?.pages.length" class="original-grid">
        <div v-for="(page, index) in detail.pages" :key="page.id" class="original-tile-card">
          <button type="button" class="original-tile" @click="openOriginalViewer(index)">
            <img v-if="page.hasThumbnail" :src="thumbnailUrl(page)" alt="" loading="lazy" decoding="async" />
            <FileText v-else-if="page.mimeType === 'application/pdf'" :size="28" />
            <FileImage v-else :size="28" />
            <span>第 {{ page.pageNumber }} 页</span>
            <Maximize2 :size="15" />
          </button>
          <div class="page-edit-actions">
            <button type="button" :disabled="savingPages || index === 0" title="上移" @click="moveSavedPage(page, -1)"><ArrowUp :size="15" /></button>
            <button type="button" :disabled="savingPages || index === detail.pages.length - 1" title="下移" @click="moveSavedPage(page, 1)"><ArrowDown :size="15" /></button>
            <button type="button" :disabled="savingPages" title="旋转" @click="rotateSavedPage(page)"><RotateCw :size="15" /></button>
            <button type="button" :disabled="savingPages || detail.pages.length <= 1" title="删除" @click="deleteSavedPage(page)"><Trash2 :size="15" /></button>
          </div>
        </div>
      </div>
      <p v-else class="preview-hint">详情加载后会显示关联原件。</p>
    </article>
  </div>

  <Teleport to="body">
    <div v-if="allObservationsOpen && detail" class="modal-backdrop observation-all-backdrop" @click.self="allObservationsOpen = false">
      <section class="modal-panel observation-all-modal" role="dialog" aria-modal="true" aria-label="全部结构化指标">
        <header>
          <div>
            <ScrollText :size="20" />
            <div class="observation-all-title">
              <h3>全部结构化指标</h3>
              <p>共 {{ detail.observations.length }} 项<template v-if="abnormalObservations.length"> · {{ abnormalObservations.length }} 项异常</template></p>
            </div>
          </div>
          <button class="plain-icon-button" type="button" title="关闭" @click="allObservationsOpen = false"><X :size="18" /></button>
        </header>
        <div class="observation-all-body">
          <div class="observation-list">
            <article v-for="item in detail.observations" :key="item.id">
              <strong>{{ item.itemName }}</strong>
              <p>{{ observationValueLine(item) }}<em v-if="item.abnormalFlag" :class="{ abnormal: item.abnormalFlag !== 'normal' }">{{ abnormalLabel(item.abnormalFlag) }}</em></p>
              <div class="observation-meta"><span>{{ item.sectionName || item.normalizedName || "未分组" }}</span><span v-if="item.referenceText">参考 {{ item.referenceText }}</span></div>
              <small v-if="observationNormalizationLine(item)" class="observation-normalization-line">{{ observationNormalizationLine(item) }}</small>
              <small v-if="item.canonicalExplanation" class="observation-explanation-line">说明：{{ item.canonicalExplanation }}</small>
            </article>
          </div>
        </div>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="editOpen" class="modal-backdrop report-edit-backdrop" @click.self="editOpen = false">
      <section class="modal-panel edit-workspace" role="dialog" aria-modal="true" aria-label="校对报告字段">
        <header class="edit-workspace-header">
          <div class="edit-workspace-title">
            <Pencil :size="20" />
            <div><h3>校对报告字段</h3><p>对照原件与 OCR 文本逐项核对</p></div>
          </div>
          <button class="plain-icon-button" type="button" title="关闭" @click="editOpen = false"><X :size="18" /></button>
        </header>
        <div class="edit-workspace-body">
          <section class="edit-col edit-col-originals">
            <h4>报告原件</h4>
            <button v-if="firstPdfPage" class="soft-action-button edit-original-pdf" type="button" @click="openPdfOriginalViewer(firstPdfPage)">
              <FileText :size="16" />打开 PDF 原件
            </button>
            <div v-if="currentOriginalPage" class="edit-swiper">
              <button
                class="edit-swiper-nav edit-swiper-nav--prev"
                type="button" title="上一页" :disabled="editOriginalIndex === 0"
                @click="editOriginalIndex -= 1"
              ><ChevronLeft :size="20" /></button>
              <div
                class="edit-swiper-stage"
                @touchstart="onOriginalSwipeStart"
                @touchend="onOriginalSwipeEnd"
              >
                <Transition name="page-fade" mode="out-in">
                  <button
                    :key="currentOriginalPage.id"
                    type="button"
                    class="edit-original-page"
                    :title="`第 ${currentOriginalPage.pageNumber} 页，点击放大`"
                    @click="openOriginalViewer(editOriginalIndex)"
                  >
                    <img :src="viewerFullUrl(currentOriginalPage)" :alt="`第 ${currentOriginalPage.pageNumber} 页`" decoding="async" />
                  </button>
                </Transition>
              </div>
              <button
                class="edit-swiper-nav edit-swiper-nav--next"
                type="button" title="下一页" :disabled="editOriginalIndex >= (detail?.pages.length || 1) - 1"
                @click="editOriginalIndex += 1"
              ><ChevronRight :size="20" /></button>
            </div>
            <div v-if="(detail?.pages.length || 0) > 1" class="edit-swiper-indicator">
              <span>第 {{ currentOriginalPage?.pageNumber }} 页 / 共 {{ detail?.pages.length }} 页</span>
              <div class="edit-swiper-dots">
                <button
                  v-for="(page, index) in detail?.pages || []"
                  :key="page.id"
                  type="button"
                  :class="{ active: index === editOriginalIndex }"
                  :aria-label="`第 ${page.pageNumber} 页`"
                  @click="editOriginalIndex = index"
                ></button>
              </div>
            </div>
          </section>
          <section class="edit-col edit-col-ocr">
            <h4>OCR 识别文本</h4>
            <div v-if="ocrLoading" class="mini-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取 OCR 文本</div>
            <p v-else-if="ocrError" class="inline-panel-error">{{ ocrError }}</p>
            <template v-else-if="ocrPages.length">
              <article v-for="page in ocrPages" :key="page.pageId" :id="`edit-ocr-page-${page.pageNumber}`" class="ocr-page-text">
                <header>
                  <strong>第 {{ page.pageNumber }} 页</strong>
                  <span>{{ page.engine || "未识别" }} · {{ page.lineCount }} 行</span>
                </header>
                <pre v-if="page.text">{{ page.text }}</pre>
                <p v-else class="preview-hint">这一页还没有 OCR 文本。</p>
              </article>
            </template>
            <p v-else class="preview-hint">暂无 OCR 文本。</p>
          </section>
          <section class="edit-col edit-col-form">
            <form class="settings-form report-edit-form" @submit.prevent="saveReportFields">
              <div class="form-grid">
                <label><span>标题<em v-if="isManualField('title')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.title" /></label>
                <label><span>报告类型<em v-if="isManualField('reportType')" class="manual-field-chip">人工校对</em></span><FormSelect v-model="editForm.reportType" :options="typeOptions.filter((option) => option.value !== 'all')" aria-label="报告类型" /></label>
                <label><span>报告生成时间<em v-if="isManualField('reportIssuedAt')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.reportIssuedAt" type="datetime-local" step="1" /></label>
                <label><span>检查时间<em v-if="isManualField('examinedAt')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.examinedAt" type="datetime-local" step="1" /></label>
                <label><span>医院<em v-if="isManualField('hospitalName')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.hospitalName" /></label>
                <label><span>院区/分院<em v-if="isManualField('hospitalBranch')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.hospitalBranch" /></label>
                <label><span>城市<em v-if="isManualField('city')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.city" /></label>
                <label><span>就诊科室<em v-if="isManualField('departmentName')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.departmentName" /></label>
                <label><span>开单科室<em v-if="isManualField('orderingDepartment')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.orderingDepartment" /></label>
                <label><span>执行科室<em v-if="isManualField('performingDepartment')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.performingDepartment" /></label>
                <label><span>报告科室<em v-if="isManualField('reportingDepartment')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.reportingDepartment" /></label>
                <label><span>检查部位<em v-if="isManualField('bodyParts')" class="manual-field-chip">人工校对</em></span><input v-model="editForm.bodyPart" /></label>
              </div>
              <label><span>临床诊断<em v-if="isManualField('clinicalDiagnosis')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.clinicalDiagnosis" rows="2"></textarea></label>
              <label><span>检查目的<em v-if="isManualField('purpose')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.purpose" rows="2"></textarea></label>
              <label><span>检查所见<em v-if="isManualField('findings')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.findings" rows="4"></textarea></label>
              <label><span>结论<em v-if="isManualField('impression')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.impression" rows="3"></textarea></label>
              <label><span>摘要<em v-if="isManualField('summary')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.summary" rows="3"></textarea></label>
              <label><span>建议/复查<em v-if="isManualField('recommendation')" class="manual-field-chip">人工校对</em></span><textarea v-model="editForm.recommendation" rows="3"></textarea></label>
              <p v-if="detailError" class="inline-panel-error">{{ detailError }}</p>
              <div class="form-actions">
                <button type="button" @click="editOpen = false">取消</button>
                <button class="primary-button" type="submit" :disabled="savingReport">
                  <LoaderCircle v-if="savingReport" class="spin-icon" :size="16" />
                  保存校对
                </button>
              </div>
            </form>
          </section>
        </div>
      </section>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="ocrSheetOpen" class="sheet-backdrop ocr-text-sheet-backdrop" @click.self="ocrSheetOpen = false">
      <section class="sheet-panel ocr-text-sheet">
        <span class="sheet-grabber"></span>
        <header class="sheet-header">
          <div>
            <h3>OCR 识别文本</h3>
            <p>{{ source?.title }} · 敏感号码已过滤</p>
          </div>
          <button class="plain-icon-button" type="button" title="关闭" @click="ocrSheetOpen = false"><X :size="18" /></button>
        </header>
        <div class="ocr-text-body">
          <div v-if="ocrLoading" class="mini-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取 OCR 文本</div>
          <p v-else-if="ocrError" class="inline-panel-error">{{ ocrError }}</p>
          <template v-else-if="ocrPages.length">
            <article v-for="page in ocrPages" :key="page.pageId" class="ocr-page-text">
              <header>
                <strong>第 {{ page.pageNumber }} 页</strong>
                <span>
                  {{ page.engine || "未识别" }}<template v-if="page.elapsedMs"> · {{ formatMs(page.elapsedMs) }}</template> · {{ page.lineCount }} 行
                  <template v-if="page.qualityLevel"> · 质量{{ page.qualityLevel === "good" ? "良好" : page.qualityLevel === "weak" ? "偏弱" : "较差" }} {{ page.qualityScore ?? "—" }}</template>
                </span>
              </header>
              <p v-if="page.qualityLevel && page.qualityLevel !== 'good'" class="preview-hint">{{ page.qualityReason || "OCR 文本质量不足，AI 整理可能不完整，可尝试重新 OCR 或启用视觉模型兜底。" }}</p>
              <pre v-if="page.text">{{ page.text }}</pre>
              <p v-else class="preview-hint">这一页还没有 OCR 文本，可能仍在处理或识别失败。</p>
            </article>
          </template>
          <p v-else class="preview-hint">暂无 OCR 文本。</p>
        </div>
      </section>
    </div>
  </Teleport>

  <ImageViewer v-if="viewerOpen" :pages="viewerImagePages" :start-index="viewerIndex" @close="viewerOpen = false" />

  <Teleport to="body">
    <div v-if="pdfViewerOpen && pdfViewerPage" class="original-viewer pdf-document-viewer" role="dialog" aria-modal="true" @click.self="closePdfOriginalViewer">
      <header class="original-viewer-header">
        <div>
          <strong>PDF 原件</strong>
          <span>已打开到第 {{ pdfViewerPage.pageNumber }} 页</span>
        </div>
        <div class="original-viewer-actions">
          <a :href="originalUrl(pdfViewerPage)" :download="pdfViewerPage.originalName" title="下载 PDF"><Download :size="18" /></a>
          <button type="button" title="关闭" @click="closePdfOriginalViewer"><X :size="20" /></button>
        </div>
      </header>
      <main class="original-viewer-stage pdf-document-stage">
        <iframe :src="pdfViewerSrc" title="PDF 原件"></iframe>
      </main>
      <footer class="original-viewer-footer">
        <span>这是完整 PDF 原件，文件较大时加载会比当前页图片慢。</span>
      </footer>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="eventSheetOpen && eventJob" class="sheet-backdrop job-event-sheet-backdrop" @click.self="closeJobEvents">
      <section class="sheet-panel job-event-sheet">
        <span class="sheet-grabber"></span>
        <header class="sheet-header">
          <div>
            <h3>{{ jobLabel(eventJob.jobType) }}详细日志</h3>
            <p>
              {{ eventJob.pageNumber ? `第 ${eventJob.pageNumber} 页` : "整份报告" }}{{ eventJob.originalName ? ` · ${eventJob.originalName}` : "" }}
              <template v-if="eventPolling"> · 实时更新中</template>
            </p>
          </div>
          <button class="plain-icon-button" type="button" title="关闭" @click="closeJobEvents"><X :size="18" /></button>
        </header>
        <div class="job-event-body">
          <div v-if="eventLoading" class="mini-loading"><LoaderCircle class="spin-icon" :size="16" />正在读取详细日志</div>
          <p v-if="eventError" class="inline-panel-error">{{ eventError }}</p>
          <div v-if="!eventLoading && jobEvents.length" class="job-event-timeline">
            <article v-for="event in jobEvents" :key="event.id" class="job-event-item" :class="`job-event-item--${event.eventType}`">
              <span class="job-event-dot"></span>
              <div>
                <time>{{ formatDatabaseTime(event.createdAt) }}</time>
                <strong>{{ eventTitle(event) }}</strong>
                <p v-if="event.message">{{ event.message }}</p>
                <small v-if="eventDetail(event)">{{ eventDetail(event) }}</small>
              </div>
            </article>
          </div>
          <p v-else-if="!eventLoading && !eventError" class="preview-hint">这条任务还没有详细事件记录，处理中会自动更新。</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
