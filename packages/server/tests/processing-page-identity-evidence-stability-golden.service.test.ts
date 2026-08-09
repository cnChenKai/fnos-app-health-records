import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  normalizeAiExtraction,
  type AiExecutor,
} from "../services/ai-extraction.service.ts";
import { buildAiExtractionPlan } from "../services/ai-input-planner.service.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import {
  processNextJob,
  type WorkerExecutor,
} from "../services/job-runner.service.ts";
import {
  deleteReportPage,
  updateReportPages,
} from "../services/records.service.ts";
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/p3-page-identity-evidence-stability-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  reorder: {
    order: number[];
    rotatedSourcePage: number;
    rotation: number;
    expectedSourcePageNumbers: Array<number | null>;
  };
  delete: {
    sourcePageNumber: number;
    expectedSourcePageNumbers: Array<number | null>;
    removedItemName: string;
  };
  expected: {
    initialPageCount: number;
    remainingPageCount: number;
    manualRefreshPipeline: string;
    finalAiJobCount: number;
    finalOcrResultCount: number;
  };
};

const manager: RequestUser = {
  id: "p3-page-identity-manager",
  displayName: "页面身份金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-page-identity-member";

const measurements = {
  pdf1: {
    itemName: "空腹血糖",
    resultText: "5.10",
    numericValue: 5.1,
    unit: "mmol/L",
    referenceLow: 3.9,
    referenceHigh: 6.1,
    quote: "空腹血糖 5.10 mmol/L 参考范围 3.90-6.10",
  },
  pdf2: {
    itemName: "总胆固醇",
    resultText: "4.20",
    numericValue: 4.2,
    unit: "mmol/L",
    referenceLow: 0,
    referenceHigh: 5.2,
    quote: "总胆固醇 4.20 mmol/L 参考范围 0.00-5.20",
  },
  pdf3: {
    itemName: "甘油三酯",
    resultText: "1.30",
    numericValue: 1.3,
    unit: "mmol/L",
    referenceLow: 0,
    referenceHigh: 1.7,
    quote: "甘油三酯 1.30 mmol/L 参考范围 0.00-1.70",
  },
  image: {
    itemName: "血清肌酐",
    resultText: "70",
    numericValue: 70,
    unit: "umol/L",
    referenceLow: 57,
    referenceHigh: 111,
    quote: "血清肌酐 70 umol/L 参考范围 57-111",
  },
} as const;

type MeasurementKey = keyof typeof measurements;
type PageRow = {
  id: string;
  pageNumber: number;
  storagePath: string;
  sourcePageNumber: number | null;
  sourcePageCount: number | null;
  rotation: number;
};
type BatchJob = {
  id: string;
  jobType: string;
  status: string;
  pipelineVersion: string;
};

const pageMeasurement = new Map<string, MeasurementKey>();

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x40,
  ]);
}

async function withGoldenDatabase(run: () => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-page-id-"));
  const previousStorageDir = process.env.STORAGE_DIR;
  const previousLogDir = process.env.LOG_DIR;
  process.env.STORAGE_DIR = storageDir;
  process.env.LOG_DIR = join(storageDir, "logs");
  pageMeasurement.clear();
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    db.prepare(
      `
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES (?, '本人', 'self', ?)
    `,
    ).run(memberId, manager.id);
    db.prepare(
      `
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `,
    ).run(memberId, manager.id, manager.id);
    saveAiSettings({
      enabled: true,
      baseUrl: "https://ai.example.test/v1",
      textModel: "golden-test-model",
      apiKey: "test-secret",
    });
    await run();
  } finally {
    closeDatabaseForTests();
    if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorageDir;
    if (previousLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previousLogDir;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function reportPages(reportId: string) {
  return getDatabase()
    .prepare(
      `
      SELECT id, page_number AS pageNumber, storage_path AS storagePath,
        source_page_number AS sourcePageNumber,
        source_page_count AS sourcePageCount, rotation
      FROM report_pages WHERE report_id = ? ORDER BY page_number
    `,
    )
    .all(reportId) as PageRow[];
}

function activePageJob() {
  const row = getDatabase()
    .prepare(
      `
      SELECT j.id, j.page_id AS pageId, j.job_type AS jobType
      FROM processing_jobs j
      WHERE j.status = 'processing' AND j.page_id IS NOT NULL
      ORDER BY j.rowid DESC LIMIT 1
    `,
    )
    .get() as { id: string; pageId: string; jobType: string } | undefined;
  assert.ok(row, "Worker 执行时应存在当前页面任务");
  return row;
}

const worker: WorkerExecutor = async (request) => {
  const job = activePageJob();
  if (request.action === "thumbnail") {
    return { ok: true, width: 600, height: 900, elapsedMs: 2 };
  }
  const key = pageMeasurement.get(job.pageId);
  assert.ok(key, `页面 ${job.pageId} 应保持稳定的原件身份`);
  const measurement = measurements[key];
  return {
    ok: true,
    engine: "page-identity-golden-ocr",
    modelVersion: "golden-v1",
    lines: [
      {
        id: `${key}-measurement`,
        text: measurement.quote,
        confidence: 0.99,
        box: [0, 20, 520, 42],
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `${key}-context-${index + 1}`,
        text: `检验报告信息完整确认 ${index + 1}`,
        confidence: 0.99,
        box: [0, 50 + index * 18, 520, 64 + index * 18],
      })),
    ],
    elapsedMs: 4,
  };
};

function measurementPageNumbers(text: string) {
  const pages = new Map<string, number>();
  const blockPattern = /\[第 (\d+) 页[^\]]*\]\n([\s\S]*?)(?=\n\n\[第 \d+ 页|$)/g;
  for (const match of text.matchAll(blockPattern)) {
    const pageNumber = Number(match[1]);
    const content = match[2] || "";
    for (const measurement of Object.values(measurements)) {
      if (content.includes(measurement.quote)) {
        pages.set(measurement.quote, pageNumber);
      }
    }
  }
  return pages;
}

const ai: AiExecutor = async (input) => {
  const pageNumbers = measurementPageNumbers(input.text);
  const observations = Object.values(measurements)
    .filter((measurement) => pageNumbers.has(measurement.quote))
    .map((measurement) => ({
      sectionName: "生化检查",
      itemName: measurement.itemName,
      normalizedName: measurement.itemName,
      resultText: measurement.resultText,
      numericValue: measurement.numericValue,
      unit: measurement.unit,
      referenceLow: measurement.referenceLow,
      referenceHigh: measurement.referenceHigh,
      abnormalFlag: "normal" as const,
      evidence: [
        {
          pageNumber: pageNumbers.get(measurement.quote)!,
          quote: measurement.quote,
        },
      ],
    }));
  const normalized = normalizeAiExtraction({
    ...(input.allowDocumentFields
      ? {
          reportType: "laboratory",
          title: "页面身份稳定性金标报告",
          reportIssuedAt: "2026-08-07",
        }
      : {}),
    observations,
  });
  return {
    provider: "golden-test-provider",
    model: "golden-test-model",
    promptVersion: "p3-page-identity-v1",
    ...normalized,
    rawResponseJson: JSON.stringify(normalized),
    promptTokens: 12,
    completionTokens: 10,
    elapsedMs: 6,
  };
};

async function drainJobs(maxJobs = 40) {
  let processed = 0;
  while (processed < maxJobs && (await processNextJob(worker, ai))) {
    processed += 1;
  }
  assert.ok(processed < maxJobs, "页面身份金标任务不应超过处理上限");
  return processed;
}

function configureMixedSource(reportId: string) {
  const pages = reportPages(reportId);
  assert.equal(pages.length, fixture.expected.initialPageCount);
  const pdfStoragePath = pages[0]!.storagePath;
  const keys: MeasurementKey[] = ["pdf1", "pdf2", "pdf3", "image"];
  pages.forEach((page, index) => pageMeasurement.set(page.id, keys[index]!));
  const db = getDatabase();
  pages.slice(0, 3).forEach((page, index) => {
    db.prepare(
      `
      UPDATE report_pages
      SET original_name = 'stable-source.pdf', storage_path = ?,
        mime_type = 'application/pdf', source_page_number = ?, source_page_count = 3
      WHERE id = ?
    `,
    ).run(pdfStoragePath, index + 1, page.id);
  });
  return reportPages(reportId);
}

function observationEvidence(reportId: string) {
  const rows = getDatabase()
    .prepare(
      `
      SELECT item_name AS itemName, evidence_json AS evidenceJson
      FROM observations WHERE report_id = ? ORDER BY item_name
    `,
    )
    .all(reportId) as Array<{ itemName: string; evidenceJson: string }>;
  return new Map(
    rows.map((row) => {
      const evidence = JSON.parse(row.evidenceJson) as Array<{
        pageNumber: number;
        quote: string;
      }>;
      return [row.itemName, evidence[0]?.pageNumber ?? null] as const;
    }),
  );
}

function newestManualBatchId(reportId: string) {
  const row = getDatabase()
    .prepare(
      `
      SELECT detail_json AS detailJson
      FROM processing_job_events
      WHERE report_id = ? AND event_type = 'queued'
        AND json_extract(detail_json, '$.batchId') IS NOT NULL
      ORDER BY rowid DESC LIMIT 1
    `,
    )
    .get(reportId) as { detailJson: string } | undefined;
  assert.ok(row, "页面操作应创建带 batchId 的处理批次");
  return String(JSON.parse(row.detailJson).batchId);
}

function batchJobs(reportId: string, batchId: string) {
  return getDatabase()
    .prepare(
      `
      SELECT j.id, j.job_type AS jobType, j.status,
        j.pipeline_version AS pipelineVersion
      FROM processing_jobs j
      JOIN processing_job_events e ON e.job_id = j.id AND e.event_type = 'queued'
      WHERE j.report_id = ? AND json_extract(e.detail_json, '$.batchId') = ?
      ORDER BY j.rowid
    `,
    )
    .all(reportId, batchId) as BatchJob[];
}

function aiJobCount(reportId: string) {
  return Number(
    (
      getDatabase()
        .prepare(
          "SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ? AND job_type = 'ai_extract'",
        )
        .get(reportId) as { count: number }
    ).count,
  );
}

function assertUnitPageIdentity(reportId: string) {
  const latestAi = getDatabase()
    .prepare(
      `
      SELECT id FROM processing_jobs
      WHERE report_id = ? AND job_type = 'ai_extract'
      ORDER BY rowid DESC LIMIT 1
    `,
    )
    .get(reportId) as { id: string } | undefined;
  assert.ok(latestAi);
  const ranges = getDatabase()
    .prepare(
      `
      SELECT page_ranges_json AS pageRangesJson
      FROM ai_extraction_units
      WHERE job_id = ? AND status <> 'superseded'
      ORDER BY unit_index
    `,
    )
    .all(latestAi.id) as Array<{ pageRangesJson: string }>;
  const current = new Map(
    reportPages(reportId).map((page) => [page.id, page.pageNumber]),
  );
  assert.ok(ranges.length > 0, "AI 处理应保留可审计的页面范围");
  for (const row of ranges) {
    const pageRanges = JSON.parse(row.pageRangesJson) as Array<{
      pageId: string;
      pageNumber: number;
    }>;
    for (const range of pageRanges) {
      assert.equal(
        range.pageNumber,
        current.get(range.pageId),
        "AI 单元 pageId/pageNumber 必须对应当前报告顺序",
      );
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("keeps page identity, OCR evidence, and AI references stable across reorder and deletion", async () => {
  await withGoldenDatabase(async () => {
    const upload = createUpload(manager, memberId, [
      { originalName: "source-1.png", data: pngBytes() },
      { originalName: "source-2.png", data: pngBytes() },
      { originalName: "source-3.png", data: pngBytes() },
      { originalName: "tail-image.png", data: pngBytes() },
    ]);
    const originalPages = configureMixedSource(upload.reportId);

    assert.equal(await drainJobs(), 9);
    assert.equal(observationEvidence(upload.reportId).size, 4);

    const jobsBeforeRejectedUpdate = Number(
      (
        getDatabase()
          .prepare(
            "SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ?",
          )
          .get(upload.reportId) as { count: number }
      ).count,
    );
    assert.throws(
      () =>
        updateReportPages(manager, upload.reportId, {
          pages: [{ id: originalPages[0]!.id, rotation: 0 }],
        }),
      /页面列表必须包含报告的全部页面/,
    );
    assert.deepEqual(
      reportPages(upload.reportId).map((page) => page.id),
      originalPages.map((page) => page.id),
    );
    assert.equal(
      Number(
        (
          getDatabase()
            .prepare(
              "SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ?",
            )
            .get(upload.reportId) as { count: number }
        ).count,
      ),
      jobsBeforeRejectedUpdate,
      "缺页提交不得创建处理任务",
    );

    const reorderPages = fixture.reorder.order.map(
      (position) => originalPages[position - 1]!,
    );
    updateReportPages(manager, upload.reportId, {
      pages: reorderPages.map((page) => ({
        id: page.id,
        rotation:
          page.sourcePageNumber === fixture.reorder.rotatedSourcePage
            ? fixture.reorder.rotation
            : 0,
      })),
    });

    const reordered = reportPages(upload.reportId);
    assert.deepEqual(
      reordered.map((page) => page.id),
      reorderPages.map((page) => page.id),
      "重排只能改变报告顺序，不能改变稳定 page.id",
    );
    assert.deepEqual(
      reordered.map((page) => page.sourcePageNumber),
      fixture.reorder.expectedSourcePageNumbers,
      "source_page_number 必须继续表示原 PDF 页身份",
    );
    assert.equal(reordered[1]!.rotation, fixture.reorder.rotation);
    assert.deepEqual(Object.fromEntries(observationEvidence(upload.reportId)), {
      空腹血糖: 3,
      总胆固醇: 2,
      甘油三酯: 4,
      血清肌酐: 1,
    });

    const reorderBatchId = newestManualBatchId(upload.reportId);
    const reorderJobs = batchJobs(upload.reportId, reorderBatchId);
    assert.equal(
      reorderJobs.filter((job) => job.jobType === "thumbnail").length,
      4,
    );
    assert.equal(reorderJobs.filter((job) => job.jobType === "ocr").length, 4);
    assert.ok(
      reorderJobs.every(
        (job) => job.pipelineVersion === fixture.expected.manualRefreshPipeline,
      ),
    );
    assert.equal(await drainJobs(), 9);
    assert.equal(aiJobCount(upload.reportId), 2);
    assert.deepEqual(Object.fromEntries(observationEvidence(upload.reportId)), {
      空腹血糖: 3,
      总胆固醇: 2,
      甘油三酯: 4,
      血清肌酐: 1,
    });
    assertUnitPageIdentity(upload.reportId);

    const deleted = reportPages(upload.reportId).find(
      (page) => page.sourcePageNumber === fixture.delete.sourcePageNumber,
    );
    assert.ok(deleted);
    deleteReportPage(manager, upload.reportId, deleted.id);

    const afterDelete = reportPages(upload.reportId);
    assert.deepEqual(
      afterDelete.map((page) => page.pageNumber),
      [1, 2, 3],
    );
    assert.deepEqual(
      afterDelete.map((page) => page.sourcePageNumber),
      fixture.delete.expectedSourcePageNumbers,
    );
    const immediateEvidence = observationEvidence(upload.reportId);
    assert.equal(immediateEvidence.has(fixture.delete.removedItemName), false);
    assert.deepEqual(Object.fromEntries(immediateEvidence), {
      空腹血糖: 2,
      甘油三酯: 3,
      血清肌酐: 1,
    });
    assert.doesNotThrow(() => buildAiExtractionPlan(upload.reportId));

    const deleteBatchId = newestManualBatchId(upload.reportId);
    const deleteJobs = batchJobs(upload.reportId, deleteBatchId);
    assert.equal(
      deleteJobs.filter((job) => job.jobType === "thumbnail").length,
      fixture.expected.remainingPageCount,
    );
    assert.equal(
      deleteJobs.filter((job) => job.jobType === "ocr").length,
      fixture.expected.remainingPageCount,
    );
    assert.equal(await drainJobs(), 7);
    assert.equal(aiJobCount(upload.reportId), 3);
    assert.equal(
      observationEvidence(upload.reportId).has(fixture.delete.removedItemName),
      false,
    );
    assertUnitPageIdentity(upload.reportId);

    const beforeFirstConcurrentEdit = reportPages(upload.reportId);
    updateReportPages(manager, upload.reportId, {
      pages: [
        beforeFirstConcurrentEdit[2],
        beforeFirstConcurrentEdit[0],
        beforeFirstConcurrentEdit[1],
      ].map((page) => ({ id: page!.id, rotation: page!.rotation })),
    });
    const abandonedBatchId = newestManualBatchId(upload.reportId);
    for (let index = 0; index < fixture.expected.remainingPageCount; index += 1) {
      assert.equal(await processNextJob(worker, ai), true);
    }

    const heldOcr = deferred<Awaited<ReturnType<WorkerExecutor>>>();
    let heldJobId = "";
    const heldWorker: WorkerExecutor = async (request) => {
      const job = activePageJob();
      heldJobId = job.id;
      assert.equal(request.action, "ocr");
      return heldOcr.promise;
    };
    const staleRun = processNextJob(heldWorker, ai);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(heldJobId, "应已启动旧批次 OCR");

    const beforeSecondConcurrentEdit = reportPages(upload.reportId);
    updateReportPages(manager, upload.reportId, {
      pages: [
        beforeSecondConcurrentEdit[1],
        beforeSecondConcurrentEdit[2],
        beforeSecondConcurrentEdit[0],
      ].map((page) => ({ id: page!.id, rotation: page!.rotation })),
    });
    const finalBatchId = newestManualBatchId(upload.reportId);
    assert.notEqual(finalBatchId, abandonedBatchId);
    assert.equal(
      (
        getDatabase()
          .prepare("SELECT status FROM processing_jobs WHERE id = ?")
          .get(heldJobId) as { status: string }
      ).status,
      "cancelled",
    );

    heldOcr.resolve({
      ok: true,
      engine: "stale-ocr-must-be-discarded",
      modelVersion: "stale-v1",
      lines: [
        {
          id: "stale-line",
          text: "删除页伪造指标 999 mmol/L",
          confidence: 0.99,
          box: [0, 0, 100, 20],
        },
      ],
      elapsedMs: 1,
    });
    assert.equal(await staleRun, true);
    assert.equal(
      Number(
        (
          getDatabase()
            .prepare("SELECT COUNT(*) AS count FROM ocr_results WHERE job_id = ?")
            .get(heldJobId) as { count: number }
        ).count,
      ),
      0,
      "被取消的旧 OCR 返回后不得写入结果",
    );

    const abandonedJobs = batchJobs(upload.reportId, abandonedBatchId);
    assert.equal(
      abandonedJobs.filter((job) => job.jobType === "ocr" && job.status === "cancelled")
        .length,
      fixture.expected.remainingPageCount,
    );
    assert.equal(await drainJobs(), 7);
    assert.equal(aiJobCount(upload.reportId), fixture.expected.finalAiJobCount);
    assert.equal(
      Number(
        (
          getDatabase()
            .prepare(
              `
              SELECT COUNT(*) AS count FROM ocr_results result
              JOIN report_pages page ON page.id = result.page_id
              WHERE page.report_id = ?
            `,
            )
            .get(upload.reportId) as { count: number }
        ).count,
      ),
      fixture.expected.finalOcrResultCount,
    );
    assert.equal(
      Number(
        (
          getDatabase()
            .prepare(
              `
              SELECT COUNT(*) AS count FROM ocr_results
              WHERE engine = 'stale-ocr-must-be-discarded'
            `,
            )
            .get() as { count: number }
        ).count,
      ),
      0,
    );
    assert.equal(
      batchJobs(upload.reportId, finalBatchId).filter(
        (job) => job.jobType === "ai_extract" && job.status === "completed",
      ).length,
      1,
      "最终页面批次只能生成一个 AI 任务",
    );
    assertUnitPageIdentity(upload.reportId);
  });
});
