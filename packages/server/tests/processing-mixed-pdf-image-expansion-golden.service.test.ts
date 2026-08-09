import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  processNextJob,
  type WorkerExecutor,
} from "../services/job-runner.service.ts";
import {
  createUpload,
  listProcessingJobs,
} from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/p3-mixed-pdf-image-expansion-golden.json", import.meta.url),
    "utf8",
  ),
) as {
  mixedExpansion: {
    firstPdfPages: number;
    secondPdfPages: number;
    expectedReportPages: number;
    expectedSourcePages: Array<number | null>;
    expectedJobCounts: Record<string, number>;
  };
  timeoutRecovery: {
    pdfPages: number;
    expectedReportPagesBeforeRetry: number;
    expectedReportPagesAfterRetry: number;
    timeoutCode: string;
    expectedPdfAttempts: number;
    expectedJobCounts: Record<string, number>;
  };
  lateArrivalFairness: {
    pdfPages: number;
    expectedOcrOrderAfterArrival: string[];
  };
  postCommitRecovery: {
    pdfPages: number;
    expectedReportPages: number;
    expectedPdfAttempts: number;
    expectedJobCounts: Record<string, number>;
  };
};

const manager: RequestUser = {
  id: "p3-mixed-pdf-manager",
  displayName: "混合 PDF 金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-mixed-pdf-member";

type ActiveLocalJob = {
  id: string;
  reportId: string;
  jobType: "pdf_extract" | "thumbnail" | "ocr";
  attempts: number;
  pageId: string;
  pageNumber: number;
  sourcePageNumber: number | null;
  originalName: string;
};

function pngBytes(seed: number) {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    seed & 0xff,
  ]);
}

function pdfBytes(seed: number) {
  return Uint8Array.from([
    0x25,
    0x50,
    0x44,
    0x46,
    0x2d,
    0x31,
    0x2e,
    0x37,
    0x0a,
    0x25,
    seed & 0xff,
  ]);
}

async function withGoldenDatabase(run: () => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-mixed-pdf-"));
  const previousStorageDir = process.env.STORAGE_DIR;
  const previousLogDir = process.env.LOG_DIR;
  process.env.STORAGE_DIR = storageDir;
  process.env.LOG_DIR = join(storageDir, "logs");
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

function activeLocalJob() {
  const job = getDatabase()
    .prepare(
      `
      SELECT j.id, j.report_id AS reportId, j.job_type AS jobType, j.attempts,
        p.id AS pageId, p.page_number AS pageNumber,
        p.source_page_number AS sourcePageNumber, p.original_name AS originalName
      FROM processing_jobs j
      JOIN report_pages p ON p.id = j.page_id
      WHERE j.status = 'processing' AND j.job_type IN ('pdf_extract', 'thumbnail', 'ocr')
      ORDER BY j.locked_at DESC, j.id
      LIMIT 1
    `,
    )
    .get() as ActiveLocalJob | undefined;
  assert.ok(job, "executor should observe one active local job");
  return job;
}

function pdfInspection(pageCount: number) {
  return {
    ok: true as const,
    pageCount,
    pages: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      width: 1200,
      height: 1800,
    })),
    elapsedMs: 4,
  };
}

function successfulResponse(job: ActiveLocalJob) {
  if (job.jobType === "thumbnail") {
    return { ok: true as const, width: 600, height: 900, elapsedMs: 3 };
  }
  return {
    ok: true as const,
    engine: "mixed-pdf-golden-ocr",
    modelVersion: "golden-v1",
    lines: [
      {
        id: `line-${job.pageId}`,
        text: `${job.originalName} 报告页${job.pageNumber} 原件页${job.sourcePageNumber ?? "image"} 项目 ${job.pageNumber}.00 mmol/L`,
        confidence: 0.99,
        box: [0, 0, 520, 20],
      },
    ],
    elapsedMs: 5,
  };
}

function reportStatus(reportId: string) {
  return (
    getDatabase()
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(reportId) as { status: string }
  ).status;
}

function reportNotificationCount(reportId: string) {
  return Number(
    (
      getDatabase()
        .prepare(
          "SELECT COUNT(*) AS count FROM app_notifications WHERE report_id = ? AND type = 'report_processed'",
        )
        .get(reportId) as { count: number }
    ).count,
  );
}

function jobCounts(reportId: string) {
  const rows = getDatabase()
    .prepare(
      `
      SELECT job_type AS jobType, COUNT(*) AS count
      FROM processing_jobs WHERE report_id = ?
      GROUP BY job_type
    `,
    )
    .all(reportId) as Array<{ jobType: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.jobType, Number(row.count)]));
}

async function drain(executor: WorkerExecutor, maxJobs = 100) {
  let processed = 0;
  while (processed < maxJobs && (await processNextJob(executor))) processed += 1;
  assert.ok(processed < maxJobs, `queue did not drain within ${maxJobs} jobs`);
  return processed;
}

test("expands two PDFs around an image into one continuous and complete report", async () => {
  await withGoldenDatabase(async () => {
    const upload = createUpload(manager, memberId, [
      { originalName: "first.pdf", data: pdfBytes(0x11) },
      { originalName: "middle.png", data: pngBytes(0x22) },
      { originalName: "second.pdf", data: pdfBytes(0x33) },
    ]);
    const actions: Array<{
      action: string;
      pageNumber: number;
      sourcePageNumber: number | null;
      originalName: string;
      recycleAfterResponse: boolean;
    }> = [];
    const executor: WorkerExecutor = async (request) => {
      const job = activeLocalJob();
      actions.push({
        action: request.action,
        pageNumber: job.pageNumber,
        sourcePageNumber: job.sourcePageNumber,
        originalName: job.originalName,
        recycleAfterResponse: Boolean(request.recycleAfterResponse),
      });
      if (request.action === "inspect_pdf") {
        return pdfInspection(
          job.originalName === "first.pdf"
            ? fixture.mixedExpansion.firstPdfPages
            : fixture.mixedExpansion.secondPdfPages,
        );
      }
      return successfulResponse(job);
    };

    let processed = 0;
    while (await processNextJob(executor)) {
      processed += 1;
      const completedOcr = Number(
        (
          getDatabase()
            .prepare(
              `
              SELECT COUNT(*) AS count
              FROM processing_jobs
              WHERE report_id = ? AND job_type = 'ocr' AND status = 'completed'
            `,
            )
            .get(upload.reportId) as { count: number }
        ).count,
      );
      if (completedOcr < fixture.mixedExpansion.expectedReportPages) {
        assert.equal(reportStatus(upload.reportId), "processing");
        assert.equal(reportNotificationCount(upload.reportId), 0);
      }
      assert.ok(processed < 100);
    }

    const pages = getDatabase()
      .prepare(
        `
        SELECT page_number AS pageNumber, original_name AS originalName,
          source_page_number AS sourcePageNumber, source_page_count AS sourcePageCount
        FROM report_pages WHERE report_id = ? ORDER BY page_number
      `,
      )
      .all(upload.reportId) as Array<{
      pageNumber: number;
      originalName: string;
      sourcePageNumber: number | null;
      sourcePageCount: number | null;
    }>;
    assert.equal(pages.length, fixture.mixedExpansion.expectedReportPages);
    assert.deepEqual(
      pages.map((page) => page.pageNumber),
      Array.from({ length: pages.length }, (_, index) => index + 1),
    );
    assert.deepEqual(
      pages.map((page) => page.sourcePageNumber),
      fixture.mixedExpansion.expectedSourcePages,
    );
    assert.deepEqual(
      pages.map((page) => page.originalName),
      ["first.pdf", "first.pdf", "first.pdf", "middle.png", "second.pdf", "second.pdf"],
    );
    assert.deepEqual(jobCounts(upload.reportId), fixture.mixedExpansion.expectedJobCounts);
    assert.equal(reportStatus(upload.reportId), "needs_review");
    assert.equal(reportNotificationCount(upload.reportId), 1);

    const visibleJobs = listProcessingJobs(manager, upload.reportId);
    assert.equal(visibleJobs.length, 14);
    assert.equal(visibleJobs.every((job) => job.batchId === "initial-upload"), true);
    assert.equal(visibleJobs.every((job) => job.status === "completed"), true);

    const ocrActions = actions.filter((action) => action.action === "ocr");
    assert.deepEqual(
      ocrActions.map((action) => action.pageNumber),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(
      ocrActions.map((action) => action.recycleAfterResponse),
      [false, false, false, false, false, true],
    );
  });
});

test("recovers a timed-out PDF inspection without partial pages or premature worker recycle", async () => {
  await withGoldenDatabase(async () => {
    const delayed = createUpload(manager, memberId, [
      { originalName: "cover.png", data: pngBytes(0x44) },
      { originalName: "delayed.pdf", data: pdfBytes(0x55) },
    ]);
    let timeoutInjected = false;
    const attempts: string[] = [];
    const recycleFlags: Array<{ reportId: string; pageNumber: number; recycle: boolean }> = [];
    const executor: WorkerExecutor = async (request) => {
      const job = activeLocalJob();
      attempts.push(`${job.reportId}:${job.jobType}:${job.pageNumber}#${job.attempts}`);
      if (request.action === "inspect_pdf") {
        if (!timeoutInjected) {
          timeoutInjected = true;
          throw Object.assign(new Error("金标模拟 PDF Worker 静默超时"), {
            code: fixture.timeoutRecovery.timeoutCode,
          });
        }
        return pdfInspection(fixture.timeoutRecovery.pdfPages);
      }
      if (request.action === "ocr") {
        recycleFlags.push({
          reportId: job.reportId,
          pageNumber: job.pageNumber,
          recycle: Boolean(request.recycleAfterResponse),
        });
      }
      return successfulResponse(job);
    };

    await assert.rejects(
      () => processNextJob(executor),
      (error: unknown) =>
        (error as { code?: string })?.code === fixture.timeoutRecovery.timeoutCode,
    );
    assert.equal(
      Number(
        (
          getDatabase()
            .prepare("SELECT COUNT(*) AS count FROM report_pages WHERE report_id = ?")
            .get(delayed.reportId) as { count: number }
        ).count,
      ),
      fixture.timeoutRecovery.expectedReportPagesBeforeRetry,
    );
    assert.equal(
      Number(
        (
          getDatabase()
            .prepare(
              "SELECT COUNT(*) AS count FROM report_pages WHERE report_id = ? AND source_page_count IS NOT NULL",
            )
            .get(delayed.reportId) as { count: number }
        ).count,
      ),
      0,
    );

    const peer = createUpload(manager, memberId, [
      { originalName: "peer.png", data: pngBytes(0x66) },
    ]);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await processNextJob(executor), true);
    }
    assert.equal(await processNextJob(executor), true);
    assert.equal(await processNextJob(executor), true);
    assert.deepEqual(
      recycleFlags.find((entry) => entry.reportId === delayed.reportId),
      {
        reportId: delayed.reportId,
        pageNumber: 1,
        recycle: false,
      },
    );
    assert.equal(reportStatus(delayed.reportId), "processing");
    assert.equal(reportNotificationCount(delayed.reportId), 0);

    assert.equal(reportStatus(peer.reportId), "needs_review");
    assert.equal(reportNotificationCount(peer.reportId), 1);

    getDatabase()
      .prepare(
        `
        UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP
        WHERE report_id = ? AND job_type = 'pdf_extract' AND status = 'queued'
      `,
      )
      .run(delayed.reportId);
    assert.equal(await processNextJob(executor), true);
    await drain(executor);

    const pages = getDatabase()
      .prepare(
        `
        SELECT page_number AS pageNumber, source_page_number AS sourcePageNumber,
          source_page_count AS sourcePageCount
        FROM report_pages WHERE report_id = ? ORDER BY page_number
      `,
      )
      .all(delayed.reportId) as Array<{
      pageNumber: number;
      sourcePageNumber: number | null;
      sourcePageCount: number | null;
    }>;
    assert.equal(pages.length, fixture.timeoutRecovery.expectedReportPagesAfterRetry);
    assert.deepEqual(
      pages.map((page) => page.pageNumber),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      pages.map((page) => page.sourcePageNumber),
      [null, 1, 2, 3],
    );
    assert.deepEqual(jobCounts(delayed.reportId), fixture.timeoutRecovery.expectedJobCounts);

    const pdfJob = getDatabase()
      .prepare(
        `
        SELECT attempts FROM processing_jobs
        WHERE report_id = ? AND job_type = 'pdf_extract'
      `,
      )
      .get(delayed.reportId) as { attempts: number };
    assert.equal(pdfJob.attempts, fixture.timeoutRecovery.expectedPdfAttempts);
    assert.equal(
      attempts.filter((attempt) => attempt.includes(":pdf_extract:")).length,
      2,
    );
    assert.equal(reportStatus(delayed.reportId), "needs_review");
    assert.equal(reportNotificationCount(delayed.reportId), 1);
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
            .get(delayed.reportId) as { count: number }
        ).count,
      ),
      fixture.timeoutRecovery.expectedReportPagesAfterRetry,
    );
  });
});


test("retries a PDF after expansion committed without duplicating pages or jobs", async () => {
  await withGoldenDatabase(async () => {
    const upload = createUpload(manager, memberId, [
      { originalName: "committed.pdf", data: pdfBytes(0x99) },
      { originalName: "tail.png", data: pngBytes(0xaa) },
    ]);
    const executor: WorkerExecutor = async (request) => {
      const job = activeLocalJob();
      if (request.action === "inspect_pdf") {
        return pdfInspection(fixture.postCommitRecovery.pdfPages);
      }
      return successfulResponse(job);
    };

    getDatabase().exec(`
      CREATE TRIGGER golden_fail_pdf_complete
      BEFORE UPDATE OF status ON processing_jobs
      WHEN OLD.job_type = 'pdf_extract' AND NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'golden post-expansion completion fault');
      END
    `);
    await assert.rejects(
      () => processNextJob(executor),
      /golden post-expansion completion fault/,
    );
    getDatabase().exec("DROP TRIGGER golden_fail_pdf_complete");

    const expandedOnce = getDatabase()
      .prepare(
        `
        SELECT page_number AS pageNumber, source_page_number AS sourcePageNumber
        FROM report_pages WHERE report_id = ? ORDER BY page_number
      `,
      )
      .all(upload.reportId) as Array<{
      pageNumber: number;
      sourcePageNumber: number | null;
    }>;
    assert.equal(expandedOnce.length, fixture.postCommitRecovery.expectedReportPages);
    assert.deepEqual(
      expandedOnce.map((page) => page.pageNumber),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      expandedOnce.map((page) => page.sourcePageNumber),
      [1, 2, 3, null],
    );
    assert.deepEqual(jobCounts(upload.reportId), fixture.postCommitRecovery.expectedJobCounts);
    assert.equal(reportStatus(upload.reportId), "processing");
    assert.equal(reportNotificationCount(upload.reportId), 0);

    getDatabase()
      .prepare(
        `
        UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP
        WHERE report_id = ? AND job_type = 'pdf_extract' AND status = 'queued'
      `,
      )
      .run(upload.reportId);
    assert.equal(await processNextJob(executor), true);
    await drain(executor);

    assert.deepEqual(jobCounts(upload.reportId), fixture.postCommitRecovery.expectedJobCounts);
    const pdfJob = getDatabase()
      .prepare(
        `
        SELECT attempts FROM processing_jobs
        WHERE report_id = ? AND job_type = 'pdf_extract'
      `,
      )
      .get(upload.reportId) as { attempts: number };
    assert.equal(pdfJob.attempts, fixture.postCommitRecovery.expectedPdfAttempts);
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
      fixture.postCommitRecovery.expectedReportPages,
    );
    assert.equal(reportStatus(upload.reportId), "needs_review");
    assert.equal(reportNotificationCount(upload.reportId), 1);
  });
});

test("gives a late single-image report the next OCR turn after PDF expansion", async () => {
  await withGoldenDatabase(async () => {
    const large = createUpload(manager, memberId, [
      { originalName: "large.pdf", data: pdfBytes(0x77) },
    ]);
    const labels = new Map([[large.reportId, "large"]]);
    const ocrOrder: string[] = [];
    const executor: WorkerExecutor = async (request) => {
      const job = activeLocalJob();
      if (request.action === "inspect_pdf") {
        return pdfInspection(fixture.lateArrivalFairness.pdfPages);
      }
      if (request.action === "ocr") {
        const label = labels.get(job.reportId);
        assert.ok(label);
        ocrOrder.push(`${label}:${job.pageNumber}`);
      }
      return successfulResponse(job);
    };

    assert.equal(await processNextJob(executor), true);
    for (let index = 0; index < fixture.lateArrivalFairness.pdfPages; index += 1) {
      assert.equal(await processNextJob(executor), true);
    }
    assert.equal(await processNextJob(executor), true);
    assert.deepEqual(ocrOrder, ["large:1"]);

    const single = createUpload(manager, memberId, [
      { originalName: "single.png", data: pngBytes(0x88) },
    ]);
    labels.set(single.reportId, "single");
    assert.equal(await processNextJob(executor), true);
    const orderStart = ocrOrder.length;
    assert.equal(await processNextJob(executor), true);
    assert.equal(await processNextJob(executor), true);
    assert.deepEqual(
      ocrOrder.slice(orderStart),
      fixture.lateArrivalFairness.expectedOcrOrderAfterArrival,
    );

    await drain(executor);
    assert.equal(reportStatus(large.reportId), "needs_review");
    assert.equal(reportStatus(single.reportId), "needs_review");
  });
});
