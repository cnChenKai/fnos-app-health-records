import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  aiExtractionPromptVersion,
  normalizeAiExtraction,
  persistAiExtraction,
  type AiExtractionResult,
  type AiMorphologyFinding,
} from "../services/ai-extraction.service.ts";
import {
  listMorphologyTracking,
  rebuildMorphologyTrackingForMember,
  rebuildMorphologyTrackingForReport,
  updateMorphologyFinding,
} from "../services/morphology-finding.service.ts";
import { restoreReport, trashReport } from "../services/records.service.ts";

const baseGolden = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/p3-ultrasound-summary-detail-morphology-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { source: { findings: AiMorphologyFinding[] } };

const golden = JSON.parse(
  readFileSync(
    new URL("./fixtures/p3-morphology-cross-report-golden.json", import.meta.url),
    "utf8",
  ),
) as {
  reports: Array<{
    key: string;
    examDate: string;
    calcificationLength: number;
    calcificationUnit: string;
    displayMeasurement: string;
    includeLeftCalcification?: boolean;
  }>;
  manualReview: {
    reportKey: string;
    calcificationLength: number;
    calcificationUnit: string;
  };
  expected: {
    groupCount: number;
    rightCalcificationName: string;
    rightCalcificationPrimaryMmBeforeManualReview: number[];
    rightCalcificationPrimaryMmAfterManualReview: number[];
    rightCalcificationChangeKind: string;
    rightCalcificationChangeSummaryAfterManualReview: string;
    fattyLiverName: string;
    leftCalcificationName: string;
    sourcePage: number;
  };
};

const manager: RequestUser = {
  id: "morphology-cross-report-manager",
  displayName: "跨报告形态金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "morphology-cross-report-member";
const reportIdByKey = new Map(
  golden.reports.map((report) => [report.key, `morphology-cross-${report.key}`]),
);

function replaceMeasurement(value: string, displayMeasurement: string) {
  return value.replace(/直径约5mm/g, `直径约${displayMeasurement}`);
}

function findingsForReport(config: (typeof golden.reports)[number]) {
  const findings = structuredClone(baseGolden.source.findings);
  for (const finding of findings) {
    finding.rawText = replaceMeasurement(finding.rawText, config.displayMeasurement);
    finding.evidence = finding.evidence.map((evidence) => ({
      ...evidence,
      quote: replaceMeasurement(evidence.quote, config.displayMeasurement),
    }));
    if (finding.findingName !== "肝右叶强回声区") continue;
    finding.size = {
      length: config.calcificationLength,
      width: null,
      height: null,
      unit: config.calcificationUnit,
    };
    finding.measurements = [{
      key: "直径",
      value: config.calcificationLength,
      unit: config.calcificationUnit,
    }];
  }
  if (config.includeLeftCalcification) {
    const quote = "肝左叶见局灶性强回声灶，直径约6mm，后方无声影。";
    findings.push({
      sectionName: "超声描述",
      organ: "肝脏",
      region: "左叶",
      laterality: "left",
      findingType: "钙化灶",
      findingName: golden.expected.leftCalcificationName,
      presence: "present",
      findingCount: 1,
      size: { length: 6, width: null, height: null, unit: "mm" },
      measurements: [{ key: "直径", value: 6, unit: "mm" }],
      morphology: "局灶性强回声灶，后方无声影",
      attributes: { 后方声影: "无" },
      classification: null,
      comparisonText: null,
      rawText: quote,
      evidence: [{ pageNumber: 18, quote }],
      confidence: 0.94,
    });
  }
  return findings;
}

function extractionResult(
  config: (typeof golden.reports)[number],
): AiExtractionResult {
  const normalized = normalizeAiExtraction({
    reportType: "checkup",
    title: `跨报告形态金标 ${config.examDate}`,
    reportIssuedAt: config.examDate,
    morphologyFindings: findingsForReport(config),
  });
  return {
    provider: "fixed-golden",
    model: "fixed-structured-fixture",
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify(normalized),
    promptTokens: 0,
    completionTokens: 0,
    elapsedMs: 0,
  };
}

function insertReport(config: (typeof golden.reports)[number]) {
  const db = getDatabase();
  const reportId = reportIdByKey.get(config.key)!;
  db.prepare(`
    INSERT INTO reports (
      id, member_id, created_by, report_type, title, status, report_issued_at
    ) VALUES (?, ?, ?, 'checkup', ?, 'ready', ?)
  `).run(
    reportId,
    memberId,
    manager.id,
    `跨报告形态金标 ${config.examDate}`,
    config.examDate,
  );

  const findings = findingsForReport(config);
  const evidenceByPage = new Map<number, string[]>();
  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      const quotes = evidenceByPage.get(evidence.pageNumber) || [];
      if (!quotes.includes(evidence.quote)) quotes.push(evidence.quote);
      evidenceByPage.set(evidence.pageNumber, quotes);
    }
  }
  const insertPage = db.prepare(`
    INSERT INTO report_pages (
      id, report_id, page_number, original_name, storage_path, mime_type,
      file_size, sha256
    ) VALUES (?, ?, ?, ?, ?, 'image/png', 1, ?)
  `);
  const insertOcrJob = db.prepare(`
    INSERT INTO processing_jobs (
      id, report_id, page_id, job_type, status, pipeline_version,
      deduplication_key, started_at, finished_at
    ) VALUES (?, ?, ?, 'ocr', 'completed', 'fixed-golden', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  const insertOcr = db.prepare(`
    INSERT INTO ocr_results (
      id, job_id, page_id, engine, model_version, lines_json, text_length
    ) VALUES (?, ?, ?, 'stored-golden', 'fixed-v1', ?, ?)
  `);
  for (let pageNumber = 1; pageNumber <= 18; pageNumber += 1) {
    const pageId = `${reportId}-page-${pageNumber}`;
    const jobId = `${reportId}-ocr-job-${pageNumber}`;
    insertPage.run(
      pageId,
      reportId,
      pageNumber,
      `page-${pageNumber}.png`,
      `reports/${reportId}/page-${pageNumber}.png`,
      `${reportId}-page-${pageNumber}-hash`,
    );
    insertOcrJob.run(jobId, reportId, pageId, `${reportId}:ocr:${pageNumber}`);
    const lines = (evidenceByPage.get(pageNumber) || []).map((text, index) => ({
      id: `${pageId}-line-${index + 1}`,
      text,
      confidence: 0.99,
    }));
    const linesJson = JSON.stringify(lines);
    insertOcr.run(`${reportId}-ocr-${pageNumber}`, jobId, pageId, linesJson, linesJson.length);
  }
  return reportId;
}

function persistReport(
  config: (typeof golden.reports)[number],
  suffix: string,
) {
  const reportId = reportIdByKey.get(config.key)!;
  const jobId = `${reportId}-ai-${suffix}`;
  getDatabase().prepare(`
    INSERT INTO processing_jobs (
      id, report_id, job_type, status, pipeline_version, deduplication_key,
      started_at, finished_at
    ) VALUES (?, ?, 'ai_extract', 'completed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(jobId, reportId, `fixed-${suffix}`, `${reportId}:ai:${suffix}`);
  persistAiExtraction(reportId, jobId, extractionResult(config), 0);
  rebuildMorphologyTrackingForReport(reportId);
}

function seriesBySide(
  tracking: ReturnType<typeof listMorphologyTracking>,
  laterality: "left" | "right",
) {
  return tracking.series.find(
    (series) => series.findingType === "钙化" && series.laterality === laterality,
  );
}

function assertSourcePages(
  series: NonNullable<ReturnType<typeof seriesBySide>>,
) {
  for (const point of series.points) {
    assert.ok(point.sourcePage, `趋势点缺少来源页：${point.reportId}`);
    assert.equal(point.sourcePage.pageNumber, golden.expected.sourcePage);
    assert.equal(point.evidenceQuote, point.rawText);
  }
}

test("keeps cross-report morphology grouping, units, evidence, manual review, rerun and trash restore stable", () => {
  const storageDir = mkdtempSync(
    join(tmpdir(), "health-records-morphology-cross-report-"),
  );
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES (?, '匿名成员', 'self', ?)
    `).run(memberId, manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `).run(memberId, manager.id, manager.id);

    for (const config of golden.reports) {
      insertReport(config);
      persistReport(config, "initial");
    }
    rebuildMorphologyTrackingForMember(memberId);

    const initial = listMorphologyTracking(manager, memberId);
    assert.equal(initial.summary.groups, golden.expected.groupCount);
    assert.equal(initial.summary.untracked, 0);
    const initialRight = seriesBySide(initial, "right");
    const initialLeft = seriesBySide(initial, "left");
    const initialFatty = initial.series.find((series) => series.findingType === "脂肪肝");
    assert.ok(initialRight);
    assert.ok(initialLeft);
    assert.ok(initialFatty);
    assert.equal(initialRight.pointCount, golden.reports.length);
    assert.equal(initialFatty.pointCount, golden.reports.length);
    assert.equal(initialLeft.pointCount, 1);
    assert.deepEqual(
      initialRight.points.map((point) => point.size.primaryMm),
      golden.expected.rightCalcificationPrimaryMmBeforeManualReview,
    );
    assert.equal(initialRight.changeKind, golden.expected.rightCalcificationChangeKind);
    assert.equal(initialRight.latest.findingName, golden.expected.rightCalcificationName);
    assert.equal(initialLeft.latest.findingName, golden.expected.leftCalcificationName);
    assert.equal(initialFatty.latest.findingName, golden.expected.fattyLiverName);
    assert.equal(
      initial.series.every(
        (series) => new Set(series.points.map((point) => point.reportId)).size === series.points.length,
      ),
      true,
      "每个 tracking_group_id 对每份报告最多只能保留一个趋势点",
    );
    assertSourcePages(initialRight);
    assertSourcePages(initialLeft);
    const rightGroupId = initialRight.trackingGroupId;
    const leftGroupId = initialLeft.trackingGroupId;

    const middleReportId = reportIdByKey.get(golden.manualReview.reportKey)!;
    const middleRight = db.prepare(`
      SELECT id, tracking_group_id AS trackingGroupId
      FROM morphology_findings
      WHERE report_id = ? AND finding_type = '钙化灶' AND laterality = 'right'
    `).get(middleReportId) as { id: string; trackingGroupId: string };
    assert.equal(middleRight.trackingGroupId, rightGroupId);

    const afterManual = updateMorphologyFinding(manager, middleRight.id, {
      sizeLength: golden.manualReview.calcificationLength,
      sizeUnit: golden.manualReview.calcificationUnit,
    });
    const manualRight = seriesBySide(afterManual, "right");
    assert.ok(manualRight);
    assert.equal(manualRight.trackingGroupId, rightGroupId);
    assert.deepEqual(
      manualRight.points.map((point) => point.size.primaryMm),
      golden.expected.rightCalcificationPrimaryMmAfterManualReview,
    );
    assert.equal(manualRight.changeKind, golden.expected.rightCalcificationChangeKind);
    assert.equal(
      manualRight.changeSummary,
      golden.expected.rightCalcificationChangeSummaryAfterManualReview,
    );
    assert.equal(
      manualRight.points.find((point) => point.reportId === middleReportId)?.manualFields.includes("size"),
      true,
    );

    const middleConfig = golden.reports.find(
      (report) => report.key === golden.manualReview.reportKey,
    )!;
    persistReport(middleConfig, "rerun");
    const afterRerun = listMorphologyTracking(manager, memberId);
    const rerunRight = seriesBySide(afterRerun, "right");
    const rerunLeft = seriesBySide(afterRerun, "left");
    assert.ok(rerunRight);
    assert.ok(rerunLeft);
    assert.equal(rerunRight.trackingGroupId, rightGroupId);
    assert.equal(rerunLeft.trackingGroupId, leftGroupId);
    assert.deepEqual(
      rerunRight.points.map((point) => point.size.primaryMm),
      golden.expected.rightCalcificationPrimaryMmAfterManualReview,
      "AI 重跑不得覆盖人工校对后的尺寸",
    );
    const rerunFatty = afterRerun.series.find(
      (series) => series.findingType === "脂肪肝",
    );
    assert.ok(rerunFatty);
    const rerunMiddleFatty = rerunFatty.points.find(
      (point) => point.reportId === middleReportId,
    );
    assert.ok(rerunMiddleFatty);
    assert.equal(rerunMiddleFatty.size.primaryMm, null);
    assert.deepEqual(rerunMiddleFatty.manualFields, []);
    const rightFindingCount = db.prepare(`
      SELECT COUNT(*) AS count FROM morphology_findings
      WHERE report_id = ? AND finding_type = '钙化灶' AND laterality = 'right'
    `).get(middleReportId) as { count: number };
    assert.equal(
      rightFindingCount.count,
      1,
      "AI 重跑不得追加同一报告同一病灶",
    );
    assertSourcePages(rerunRight);

    const baselineReportId = reportIdByKey.get("baseline")!;
    assert.equal(trashReport(manager, baselineReportId).status, "trashed");
    const inTrash = seriesBySide(listMorphologyTracking(manager, memberId), "right");
    assert.ok(inTrash);
    assert.equal(inTrash.pointCount, golden.reports.length - 1);
    assert.equal(inTrash.trackingGroupId, rightGroupId);

    assert.equal(restoreReport(manager, baselineReportId).status, "needs_review");
    const restored = listMorphologyTracking(manager, memberId);
    const restoredRight = seriesBySide(restored, "right");
    const restoredLeft = seriesBySide(restored, "left");
    assert.ok(restoredRight);
    assert.ok(restoredLeft);
    assert.equal(restoredRight.pointCount, golden.reports.length);
    assert.equal(restoredRight.trackingGroupId, rightGroupId);
    assert.equal(restoredLeft.trackingGroupId, leftGroupId);
    assert.deepEqual(
      restoredRight.points.map((point) => point.size.primaryMm),
      golden.expected.rightCalcificationPrimaryMmAfterManualReview,
    );
    assertSourcePages(restoredRight);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
