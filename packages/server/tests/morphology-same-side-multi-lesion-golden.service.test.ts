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

const golden = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/p3-morphology-same-side-multi-lesion-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  reports: Array<{
    key: string;
    examDate: string;
    nearDiaphragmMm: number;
    nearHilumMm: number;
  }>;
  manualReview: {
    reportKey: string;
    regionIncludes: string;
    sizeMm: number;
  };
  expected: {
    groupCount: number;
    sourcePage: number;
    nearDiaphragmRegion: string;
    nearHilumRegion: string;
    nearDiaphragmSizesBeforeReview: number[];
    nearDiaphragmSizesAfterReview: number[];
    nearHilumSizes: number[];
    nearDiaphragmChangeKind: string;
    nearHilumChangeKind: string;
  };
};

const manager: RequestUser = {
  id: "morphology-multi-lesion-manager",
  displayName: "同侧多病灶金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "morphology-multi-lesion-member";
const reportIdByKey = new Map(
  golden.reports.map((report) => [report.key, `morphology-multi-${report.key}`]),
);

function finding(
  region: string,
  findingName: string,
  sizeMm: number,
  morphology: string,
): AiMorphologyFinding {
  const quote = `${region}见一枚强回声灶，直径约${sizeMm}mm，${morphology}。`;
  return {
    sectionName: "超声描述",
    organ: "肝脏",
    region: `肝${region}`,
    laterality: "right",
    findingType: "钙化灶",
    findingName,
    presence: "present",
    findingCount: 1,
    size: { length: sizeMm, width: null, height: null, unit: "mm" },
    measurements: [{ key: "直径", value: sizeMm, unit: "mm" }],
    morphology: `强回声灶，${morphology}`,
    attributes: { 后方声影: morphology.includes("无") ? "无" : "有" },
    classification: null,
    comparisonText: null,
    rawText: quote,
    evidence: [{ pageNumber: 18, quote }],
    confidence: 0.96,
  };
}

function findingsForReport(config: (typeof golden.reports)[number]) {
  return [
    finding(
      golden.expected.nearDiaphragmRegion,
      "肝右叶近膈面局灶性钙化灶",
      config.nearDiaphragmMm,
      "后方无声影",
    ),
    finding(
      golden.expected.nearHilumRegion,
      "肝右叶近肝门区局灶性钙化灶",
      config.nearHilumMm,
      "后方伴声影",
    ),
  ];
}

function extractionResult(
  config: (typeof golden.reports)[number],
): AiExtractionResult {
  const normalized = normalizeAiExtraction({
    reportType: "checkup",
    title: `同侧双病灶形态金标 ${config.examDate}`,
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
    `同侧双病灶形态金标 ${config.examDate}`,
    config.examDate,
  );

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
  const insertOcrResult = db.prepare(`
    INSERT INTO ocr_results (
      id, job_id, page_id, engine, model_version, lines_json, text_length
    ) VALUES (?, ?, ?, 'stored-golden', 'fixed-v1', ?, ?)
  `);
  for (let pageNumber = 1; pageNumber <= 18; pageNumber += 1) {
    const pageId = `${reportId}-page-${pageNumber}`;
    const ocrJobId = `${reportId}-ocr-${pageNumber}`;
    insertPage.run(
      pageId,
      reportId,
      pageNumber,
      `page-${pageNumber}.png`,
      `reports/${reportId}/page-${pageNumber}.png`,
      `${reportId}-page-${pageNumber}-hash`,
    );
    insertOcrJob.run(
      ocrJobId,
      reportId,
      pageId,
      `${reportId}:ocr:${pageNumber}`,
    );
    const linesJson = JSON.stringify(
      pageNumber === 18
        ? findingsForReport(config).map((item, index) => ({
            id: `${pageId}-line-${index + 1}`,
            text: item.rawText,
            confidence: 0.99,
          }))
        : [],
    );
    insertOcrResult.run(
      `${reportId}-ocr-result-${pageNumber}`,
      ocrJobId,
      pageId,
      linesJson,
      linesJson.length,
    );
  }
}

function persistReport(config: (typeof golden.reports)[number], suffix: string) {
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

function seriesByRegion(
  tracking: ReturnType<typeof listMorphologyTracking>,
  region: string,
) {
  return tracking.series.find(
    (series) => series.findingType === "钙化" && series.region === region,
  );
}

function assertSeriesSourcePages(
  series: NonNullable<ReturnType<typeof seriesByRegion>>,
) {
  for (const point of series.points) {
    assert.ok(point.sourcePage);
    assert.equal(point.sourcePage.pageNumber, golden.expected.sourcePage);
    assert.equal(point.evidenceQuote, point.rawText);
  }
}

test("keeps two same-side same-type lesions in independent cross-report timelines", () => {
  const storageDir = mkdtempSync(
    join(tmpdir(), "health-records-morphology-multi-lesion-"),
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
    const rebuilt = rebuildMorphologyTrackingForMember(memberId);
    const initial = listMorphologyTracking(manager, memberId);
    assert.equal(rebuilt.untracked, 0);
    assert.equal(initial.summary.groups, golden.expected.groupCount);
    assert.equal(initial.summary.untracked, 0);

    const initialDiaphragm = seriesByRegion(
      initial,
      golden.expected.nearDiaphragmRegion,
    );
    const initialHilum = seriesByRegion(initial, golden.expected.nearHilumRegion);
    assert.ok(initialDiaphragm);
    assert.ok(initialHilum);
    assert.notEqual(initialDiaphragm.trackingGroupId, initialHilum.trackingGroupId);
    assert.deepEqual(
      initialDiaphragm.points.map((point) => point.size.primaryMm),
      golden.expected.nearDiaphragmSizesBeforeReview,
    );
    assert.deepEqual(
      initialHilum.points.map((point) => point.size.primaryMm),
      golden.expected.nearHilumSizes,
    );
    assert.equal(initialDiaphragm.changeKind, golden.expected.nearDiaphragmChangeKind);
    assert.equal(initialHilum.changeKind, golden.expected.nearHilumChangeKind);
    assert.equal(
      initial.series.every(
        (series) => new Set(series.points.map((point) => point.reportId)).size === series.points.length,
      ),
      true,
    );
    assertSeriesSourcePages(initialDiaphragm);
    assertSeriesSourcePages(initialHilum);

    const diaphragmGroupId = initialDiaphragm.trackingGroupId;
    const hilumGroupId = initialHilum.trackingGroupId;
    const middleReportId = reportIdByKey.get(golden.manualReview.reportKey)!;
    const middleDiaphragm = db.prepare(`
      SELECT id FROM morphology_findings
      WHERE report_id = ? AND region LIKE ?
    `).get(middleReportId, `%${golden.manualReview.regionIncludes}%`) as { id: string };
    const afterManual = updateMorphologyFinding(manager, middleDiaphragm.id, {
      sizeLength: golden.manualReview.sizeMm,
      sizeUnit: "mm",
    });
    const manualDiaphragm = seriesByRegion(
      afterManual,
      golden.expected.nearDiaphragmRegion,
    );
    const manualHilum = seriesByRegion(afterManual, golden.expected.nearHilumRegion);
    assert.ok(manualDiaphragm);
    assert.ok(manualHilum);
    assert.deepEqual(
      manualDiaphragm.points.map((point) => point.size.primaryMm),
      golden.expected.nearDiaphragmSizesAfterReview,
    );
    assert.deepEqual(
      manualHilum.points.map((point) => point.size.primaryMm),
      golden.expected.nearHilumSizes,
    );

    const middleConfig = golden.reports.find(
      (report) => report.key === golden.manualReview.reportKey,
    )!;
    persistReport(middleConfig, "rerun");
    const afterRerun = listMorphologyTracking(manager, memberId);
    const rerunDiaphragm = seriesByRegion(
      afterRerun,
      golden.expected.nearDiaphragmRegion,
    );
    const rerunHilum = seriesByRegion(afterRerun, golden.expected.nearHilumRegion);
    assert.ok(rerunDiaphragm);
    assert.ok(rerunHilum);
    assert.equal(rerunDiaphragm.trackingGroupId, diaphragmGroupId);
    assert.equal(rerunHilum.trackingGroupId, hilumGroupId);
    assert.deepEqual(
      rerunDiaphragm.points.map((point) => point.size.primaryMm),
      golden.expected.nearDiaphragmSizesAfterReview,
    );
    assert.deepEqual(
      rerunHilum.points.map((point) => point.size.primaryMm),
      golden.expected.nearHilumSizes,
    );
    const middleRows = db.prepare(`
      SELECT region, size_length AS sizeLength, manual_fields_json AS manualFieldsJson
      FROM morphology_findings WHERE report_id = ? ORDER BY region
    `).all(middleReportId) as Array<{
      region: string;
      sizeLength: number;
      manualFieldsJson: string;
    }>;
    assert.equal(middleRows.length, 2);
    assert.equal(
      middleRows.find((row) => row.region.includes("膈面"))?.sizeLength,
      golden.manualReview.sizeMm,
    );
    assert.deepEqual(
      JSON.parse(middleRows.find((row) => row.region.includes("肝门"))!.manualFieldsJson),
      [],
    );

    const baselineReportId = reportIdByKey.get("baseline")!;
    assert.equal(trashReport(manager, baselineReportId).status, "trashed");
    const trashed = listMorphologyTracking(manager, memberId);
    assert.equal(
      seriesByRegion(trashed, golden.expected.nearDiaphragmRegion)?.pointCount,
      golden.reports.length - 1,
    );
    assert.equal(
      seriesByRegion(trashed, golden.expected.nearHilumRegion)?.pointCount,
      golden.reports.length - 1,
    );

    assert.equal(restoreReport(manager, baselineReportId).status, "needs_review");
    const restored = listMorphologyTracking(manager, memberId);
    const restoredDiaphragm = seriesByRegion(
      restored,
      golden.expected.nearDiaphragmRegion,
    );
    const restoredHilum = seriesByRegion(restored, golden.expected.nearHilumRegion);
    assert.ok(restoredDiaphragm);
    assert.ok(restoredHilum);
    assert.equal(restoredDiaphragm.trackingGroupId, diaphragmGroupId);
    assert.equal(restoredHilum.trackingGroupId, hilumGroupId);
    assert.deepEqual(
      restoredDiaphragm.points.map((point) => point.size.primaryMm),
      golden.expected.nearDiaphragmSizesAfterReview,
    );
    assert.deepEqual(
      restoredHilum.points.map((point) => point.size.primaryMm),
      golden.expected.nearHilumSizes,
    );
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
