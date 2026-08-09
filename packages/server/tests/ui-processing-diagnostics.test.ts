import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const reportDetail = readFileSync(join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"), "utf8");
const apiTypes = readFileSync(join(process.cwd(), "packages/ui/src/types/api.ts"), "utf8");
const ocrOverlay = readFileSync(join(process.cwd(), "packages/ui/src/components/OcrTextOverlay.vue"), "utf8");

test("report detail renders the structured processing diagnostics returned by the server", () => {
  assert.match(reportDetail, /jobEventDetail\.value\?\.diagnostics/);
  assert.match(reportDetail, /本次处理摘要/);
  assert.match(reportDetail, /processingDiagnostics\.headline/);
  assert.match(reportDetail, /processingDiagnostics\.reasons/);
  assert.match(reportDetail, /reason\.code/);
  assert.match(reportDetail, /processingDiagnostics\.supplement\.reason/);
});

test("AI unit rows expose input size and candidate matching progress", () => {
  assert.match(reportDetail, /unit\.characterCount/);
  assert.match(reportDetail, /候选 \$\{unit\.candidateCount\} · 匹配 \$\{unit\.matchedCount\}/);
  assert.match(apiTypes, /characterCount: number;/);
  assert.match(apiTypes, /candidateCount: number;/);
  assert.match(apiTypes, /matchedCount: number;/);
});

test("processing summary closes candidates, persisted observations, and trend-ready series", () => {
  assert.match(reportDetail, /候选闭环/);
  assert.match(reportDetail, /metrics\.resolvedCandidateCount/);
  assert.match(reportDetail, /metrics\.candidateClosurePercent/);
  assert.match(reportDetail, /落库指标/);
  assert.match(reportDetail, /metrics\.persistedObservationCount/);
  assert.match(reportDetail, /趋势可用/);
  assert.match(reportDetail, /metrics\.trendReadyObservationCount/);
  assert.match(reportDetail, /metrics\.trendSeriesCount/);
  assert.match(apiTypes, /resolvedCandidateCount: number;/);
  assert.match(apiTypes, /candidateClosurePercent: number;/);
  assert.match(apiTypes, /persistedObservationCount: number;/);
  assert.match(apiTypes, /trendReadyObservationCount: number;/);
  assert.match(apiTypes, /trendSeriesCount: number;/);
});

test("diagnostic reason handling is code-driven instead of parsing localized event messages", () => {
  assert.match(apiTypes, /"SUPPLEMENT_REQUIRED"/);
  assert.match(apiTypes, /"AI_TRUNCATED_OUTPUT"/);
  assert.match(apiTypes, /"POSTPROCESS_REDUNDANT"/);
  assert.doesNotMatch(reportDetail, /event\.message.*supplement|required.*event\.message/i);
});

test("diagnostic review items open a page-level original and OCR evidence comparison", () => {
  assert.match(apiTypes, /export type ProcessingDiagnosticReviewItem/);
  assert.match(apiTypes, /issueType: "ocr_content" \| "ai_missing" \| "layout_ambiguity" \| "evidence_rejected"/);
  assert.match(apiTypes, /sourceLineIds: string\[\]/);
  assert.match(apiTypes, /resultSummary: string/);
  assert.match(apiTypes, /reviewItems: ProcessingDiagnosticReviewItem\[\]/);
  assert.match(reportDetail, /processingDiagnostics\.reviewItems/);
  assert.match(reportDetail, /openDiagnosticReview/);
  assert.match(reportDetail, /核对第 \{\{ item\.pages\[0\] \}\} 页/);
  assert.match(reportDetail, /原件对照/);
  assert.match(reportDetail, /ocr-review-page-/);
  assert.match(reportDetail, /diagnosticReviewItem\.issueType/);
  assert.match(reportDetail, /diagnosticReviewItem\.resultSummary/);
  assert.match(reportDetail, /isDiagnosticSourceLine/);
  assert.match(reportDetail, /:highlight-line-ids="diagnosticSourceLineIds"/);
  assert.match(ocrOverlay, /highlightLineIds\?: string\[\]/);
  assert.match(ocrOverlay, /is-highlighted/);
});

test("diagnostic review selects the smallest safe repair action and focuses queued processing", () => {
  assert.match(reportDetail, /diagnosticRepairMode/);
  assert.match(reportDetail, /item\.issueType === "ocr_content" \? "ocr_ai" : "ai"/);
  assert.match(reportDetail, /重新 OCR \+ AI/);
  assert.match(reportDetail, /重新 AI 整理/);
  assert.match(reportDetail, /repairDiagnosticIssue/);
  assert.match(reportDetail, /requestReportReprocess\(true\)/);
  assert.match(reportDetail, /requestAiExtraction\(true\)/);
  assert.match(reportDetail, /新结果成功前继续显示当前结果/);
  assert.match(reportDetail, /失败不会覆盖旧结果/);
  assert.match(reportDetail, /人工校对字段也不会被覆盖/);
  assert.match(reportDetail, /id="report-processing-section"/);
  assert.match(reportDetail, /closeOcrText\(\)/);
  assert.match(reportDetail, /scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
});
