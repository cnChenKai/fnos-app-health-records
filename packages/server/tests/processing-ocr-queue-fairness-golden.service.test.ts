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
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/p3-ocr-queue-fairness-golden.json", import.meta.url),
    "utf8",
  ),
) as {
  policy: string;
  initialQueue: {
    largePages: number;
    peerPages: number;
    expectedOrder: string[];
  };
  lateArrival: {
    largePages: number;
    largePagesProcessedBeforeArrival: number;
    expectedOrderAfterArrival: string[];
  };
  timeoutRecovery: {
    firstReportPages: number;
    secondReportPages: number;
    expectedAttemptOrder: string[];
    timeoutCode: string;
    retriedPageAttempts: number;
    retriedPageResultCount: number;
  };
};

const manager: RequestUser = {
  id: "p3-ocr-fairness-manager",
  displayName: "OCR 公平队列金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-ocr-fairness-member";

type ActiveOcrJob = {
  id: string;
  reportId: string;
  pageNumber: number;
  attempts: number;
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

async function withGoldenDatabase(run: () => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-ocr-fairness-"));
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

function createQueuedImageReport(input: {
  label: string;
  pageCount: number;
  createdAt: string;
  seedBase: number;
}) {
  const upload = createUpload(
    manager,
    memberId,
    Array.from({ length: input.pageCount }, (_, index) => ({
      originalName: `${input.label}-${index + 1}.png`,
      data: pngBytes(input.seedBase + index),
    })),
  );
  const db = getDatabase();
  db.prepare(
    `
    UPDATE processing_jobs
    SET status = 'completed', finished_at = ?, created_at = ?
    WHERE report_id = ? AND job_type = 'thumbnail'
  `,
  ).run(input.createdAt, input.createdAt, upload.reportId);
  db.prepare(
    "UPDATE processing_jobs SET created_at = ? WHERE report_id = ? AND job_type = 'ocr'",
  ).run(input.createdAt, upload.reportId);
  db.prepare(
    "UPDATE reports SET created_at = ?, updated_at = ? WHERE id = ?",
  ).run(input.createdAt, input.createdAt, upload.reportId);
  return upload.reportId;
}

function readActiveOcrJob(): ActiveOcrJob {
  const job = getDatabase()
    .prepare(
      `
      SELECT j.id, j.report_id AS reportId, p.page_number AS pageNumber, j.attempts
      FROM processing_jobs j
      JOIN report_pages p ON p.id = j.page_id
      WHERE j.status = 'processing' AND j.job_type = 'ocr'
      ORDER BY j.locked_at DESC, j.id
      LIMIT 1
    `,
    )
    .get() as ActiveOcrJob | undefined;
  assert.ok(job, "executor should observe exactly one active OCR job");
  return job;
}

function successfulOcrResponse(label: string, pageNumber: number) {
  return {
    ok: true as const,
    engine: "fairness-golden-ocr",
    modelVersion: "golden-v1",
    lines: [
      {
        id: `line-${label}-${pageNumber}`,
        text: `${label}报告第${pageNumber}页 唯一项目${pageNumber} ${pageNumber}.00 mmol/L`,
        confidence: 0.99,
        box: [0, 0, 420, 20],
      },
    ],
    elapsedMs: 5,
  };
}

function schedulerStartedDetails(reportIds: string[]) {
  const placeholders = reportIds.map(() => "?").join(",");
  return getDatabase()
    .prepare(
      `
      SELECT detail_json AS detailJson
      FROM processing_job_events
      WHERE event_type = 'started' AND report_id IN (${placeholders})
      ORDER BY rowid
    `,
    )
    .all(...reportIds)
    .map((row) => JSON.parse((row as { detailJson: string }).detailJson)) as Array<
    Record<string, unknown>
  >;
}

test("round-robins ready OCR pages across reports while preserving page order", async () => {
  await withGoldenDatabase(async () => {
    const largeReportId = createQueuedImageReport({
      label: "large",
      pageCount: fixture.initialQueue.largePages,
      createdAt: "2026-08-07 01:00:00",
      seedBase: 0x10,
    });
    const peerReportId = createQueuedImageReport({
      label: "peer",
      pageCount: fixture.initialQueue.peerPages,
      createdAt: "2026-08-07 01:01:00",
      seedBase: 0x30,
    });
    const labels = new Map([
      [largeReportId, "large"],
      [peerReportId, "peer"],
    ]);
    const actualOrder: string[] = [];
    const executor: WorkerExecutor = async (request) => {
      assert.equal(request.action, "ocr");
      const job = readActiveOcrJob();
      const label = labels.get(job.reportId);
      assert.ok(label);
      actualOrder.push(`${label}:${job.pageNumber}`);
      return successfulOcrResponse(label, job.pageNumber);
    };

    for (let index = 0; index < fixture.initialQueue.expectedOrder.length; index += 1) {
      assert.equal(await processNextJob(executor), true);
    }
    assert.deepEqual(actualOrder, fixture.initialQueue.expectedOrder);
    assert.equal(await processNextJob(executor), false);

    const startedDetails = schedulerStartedDetails([
      largeReportId,
      peerReportId,
    ]);
    assert.equal(startedDetails.length, fixture.initialQueue.expectedOrder.length);
    assert.equal(
      startedDetails.every(
        (detail) =>
          detail.schedulerPolicy === fixture.policy &&
          detail.schedulerLane === "ocr",
      ),
      true,
    );
  });
});

test("gives a newly uploaded single-page report the next ready OCR turn", async () => {
  await withGoldenDatabase(async () => {
    const largeReportId = createQueuedImageReport({
      label: "large",
      pageCount: fixture.lateArrival.largePages,
      createdAt: "2026-08-07 02:00:00",
      seedBase: 0x50,
    });
    const labels = new Map([[largeReportId, "large"]]);
    const allAttempts: string[] = [];
    const executor: WorkerExecutor = async () => {
      const job = readActiveOcrJob();
      const label = labels.get(job.reportId);
      assert.ok(label);
      allAttempts.push(`${label}:${job.pageNumber}`);
      return successfulOcrResponse(label, job.pageNumber);
    };

    for (
      let index = 0;
      index < fixture.lateArrival.largePagesProcessedBeforeArrival;
      index += 1
    ) {
      assert.equal(await processNextJob(executor), true);
    }

    const singleReportId = createQueuedImageReport({
      label: "single",
      pageCount: 1,
      createdAt: "2026-08-07 02:10:00",
      seedBase: 0x70,
    });
    labels.set(singleReportId, "single");
    const orderStart = allAttempts.length;
    assert.equal(await processNextJob(executor), true);
    assert.equal(await processNextJob(executor), true);
    assert.deepEqual(
      allAttempts.slice(orderStart),
      fixture.lateArrival.expectedOrderAfterArrival,
    );

    const singleStatus = getDatabase()
      .prepare("SELECT status FROM reports WHERE id = ?")
      .get(singleReportId) as { status: string };
    assert.equal(singleStatus.status, "needs_review");
  });
});

test("keeps fair report turns and page order after an OCR worker timeout retry", async () => {
  await withGoldenDatabase(async () => {
    const firstReportId = createQueuedImageReport({
      label: "first",
      pageCount: fixture.timeoutRecovery.firstReportPages,
      createdAt: "2026-08-07 03:00:00",
      seedBase: 0x80,
    });
    const secondReportId = createQueuedImageReport({
      label: "second",
      pageCount: fixture.timeoutRecovery.secondReportPages,
      createdAt: "2026-08-07 03:01:00",
      seedBase: 0xa0,
    });
    const labels = new Map([
      [firstReportId, "first"],
      [secondReportId, "second"],
    ]);
    const actualAttemptOrder: string[] = [];
    let timeoutInjected = false;
    const executor: WorkerExecutor = async () => {
      const job = readActiveOcrJob();
      const label = labels.get(job.reportId);
      assert.ok(label);
      if (!timeoutInjected && label === "first" && job.pageNumber === 1) {
        timeoutInjected = true;
        actualAttemptOrder.push(
          `${label}:${job.pageNumber}#${job.attempts}:timeout`,
        );
        throw Object.assign(new Error("金标模拟 OCR Worker 静默超时"), {
          code: fixture.timeoutRecovery.timeoutCode,
        });
      }
      actualAttemptOrder.push(`${label}:${job.pageNumber}#${job.attempts}:ok`);
      return successfulOcrResponse(label, job.pageNumber);
    };

    await assert.rejects(
      () => processNextJob(executor),
      (error: unknown) =>
        (error as { code?: string })?.code ===
        fixture.timeoutRecovery.timeoutCode,
    );
    assert.equal(await processNextJob(executor), true);
    getDatabase()
      .prepare(
        `
        UPDATE processing_jobs
        SET next_retry_at = CURRENT_TIMESTAMP
        WHERE report_id = ? AND job_type = 'ocr' AND status = 'queued'
      `,
      )
      .run(firstReportId);

    for (let index = 2; index < fixture.timeoutRecovery.expectedAttemptOrder.length; index += 1) {
      assert.equal(await processNextJob(executor), true);
    }
    assert.deepEqual(
      actualAttemptOrder,
      fixture.timeoutRecovery.expectedAttemptOrder,
    );

    const retriedPage = getDatabase()
      .prepare(
        `
        SELECT j.attempts,
          (SELECT COUNT(*) FROM ocr_results result WHERE result.job_id = j.id) AS resultCount
        FROM processing_jobs j
        JOIN report_pages p ON p.id = j.page_id
        WHERE j.report_id = ? AND j.job_type = 'ocr' AND p.page_number = 1
      `,
      )
      .get(firstReportId) as { attempts: number; resultCount: number };
    assert.equal(
      retriedPage.attempts,
      fixture.timeoutRecovery.retriedPageAttempts,
    );
    assert.equal(
      retriedPage.resultCount,
      fixture.timeoutRecovery.retriedPageResultCount,
    );
  });
});
