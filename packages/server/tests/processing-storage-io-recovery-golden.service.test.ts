import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  enqueueFileGarbage,
  runFileGarbageCollection,
  scanOrphanStorageFiles,
} from "../services/file-gc.service.ts";
import {
  processNextJob,
  type WorkerExecutor,
} from "../services/job-runner.service.ts";
import { createUpload } from "../services/upload.service.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/p3-storage-io-recovery-golden.json", import.meta.url),
    "utf8",
  ),
) as {
  expected: {
    uploadDatabaseRowsAfterFailure: number;
    uploadReportDirectoriesAfterFailure: number;
    sourceMissingRetryAttempts: number;
    sourceMismatchRetryAttempts: number;
    partialThumbnailFilesAfterFailure: number;
    orphanFilesQueued: number;
    orphanFilesDeleted: number;
    referencedFilesRetained: number;
  };
};

const manager: RequestUser = {
  id: "p3-storage-manager",
  displayName: "存储恢复金标管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true,
};
const memberId = "p3-storage-member";
const blockedMemberId = "p3-storage-blocked-member";

function pngBytes(suffix: number) {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    suffix,
  ]);
}

function reportDirectoryCount(storageDir: string, targetMemberId: string) {
  const directory = join(storageDir, "reports", targetMemberId);
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  ).length;
}

function jobRow(reportId: string, jobType: "thumbnail" | "ocr") {
  return getDatabase()
    .prepare(
      `
      SELECT id, status, attempts, error_code AS errorCode
      FROM processing_jobs
      WHERE report_id = ? AND job_type = ?
    `,
    )
    .get(reportId, jobType) as {
    id: string;
    status: string;
    attempts: number;
    errorCode: string | null;
  };
}

function pageRow(reportId: string) {
  return getDatabase()
    .prepare(
      `
      SELECT id, storage_path AS storagePath, thumbnail_path AS thumbnailPath
      FROM report_pages WHERE report_id = ? ORDER BY page_number LIMIT 1
    `,
    )
    .get(reportId) as {
    id: string;
    storagePath: string;
    thumbnailPath: string | null;
  };
}

function countUploadRows(member: string) {
  const db = getDatabase();
  const report = db
    .prepare("SELECT COUNT(*) AS count FROM reports WHERE member_id = ?")
    .get(member) as { count: number };
  const pages = db
    .prepare(
      `
      SELECT COUNT(*) AS count FROM report_pages p
      JOIN reports r ON r.id = p.report_id WHERE r.member_id = ?
    `,
    )
    .get(member) as { count: number };
  const jobs = db
    .prepare(
      `
      SELECT COUNT(*) AS count FROM processing_jobs j
      JOIN reports r ON r.id = j.report_id WHERE r.member_id = ?
    `,
    )
    .get(member) as { count: number };
  return report.count + pages.count + jobs.count;
}

test("recovers storage I/O failures without orphaning rows, files, or duplicate results", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-p3-storage-io-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)",
    ).run(manager.id, manager.displayName);
    for (const [id, name] of [
      [memberId, "匿名成员"],
      [blockedMemberId, "存储故障成员"],
    ] as const) {
      db.prepare(
        `
        INSERT INTO health_members (id, display_name, relationship, created_by)
        VALUES (?, ?, 'self', ?)
      `,
      ).run(id, name, manager.id);
      db.prepare(
        `
        INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
        VALUES (?, ?, 'manager', ?)
      `,
      ).run(id, manager.id, manager.id);
    }

    db.exec(`
      CREATE TEMP TRIGGER fail_storage_golden_upload
      BEFORE INSERT ON reports
      BEGIN
        SELECT RAISE(ABORT, 'TEST_UPLOAD_DB_FAILURE');
      END;
    `);
    assert.throws(
      () =>
        createUpload(manager, memberId, [
          { originalName: "匿名第一页.png", data: pngBytes(1) },
          { originalName: "匿名第二页.png", data: pngBytes(2) },
        ]),
      /TEST_UPLOAD_DB_FAILURE/,
    );
    db.exec("DROP TRIGGER fail_storage_golden_upload");
    assert.equal(
      countUploadRows(memberId),
      fixture.expected.uploadDatabaseRowsAfterFailure,
    );
    assert.equal(
      reportDirectoryCount(storageDir, memberId),
      fixture.expected.uploadReportDirectoriesAfterFailure,
    );

    mkdirSync(join(storageDir, "reports"), { recursive: true });
    writeFileSync(join(storageDir, "reports", blockedMemberId), "not-a-directory");
    assert.throws(
      () =>
        createUpload(manager, blockedMemberId, [
          { originalName: "不可写路径.png", data: pngBytes(3) },
        ]),
      (error: unknown) =>
        ["EEXIST", "ENOTDIR"].includes(
          String((error as NodeJS.ErrnoException)?.code || ""),
        ),
    );
    assert.equal(
      countUploadRows(blockedMemberId),
      fixture.expected.uploadDatabaseRowsAfterFailure,
    );
    rmSync(join(storageDir, "reports", blockedMemberId), { force: true });

    const upload = createUpload(manager, memberId, [
      { originalName: "原件恢复.png", data: pngBytes(4) },
    ]);
    const page = pageRow(upload.reportId);
    const originalPath = join(storageDir, page.storagePath);
    const originalBytes = readFileSync(originalPath);
    db.prepare(
      "UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ? AND job_type = 'thumbnail'",
    ).run(upload.reportId);

    let workerCalls = 0;
    const ocrWorker: WorkerExecutor = async () => {
      workerCalls += 1;
      return {
        ok: true,
        engine: "storage-golden-ocr",
        modelVersion: "storage-v1",
        lines: [
          {
            id: "storage_line_1",
            text: "匿名检查项目 5.0 mmol/L",
            confidence: 0.99,
            box: [0, 0, 120, 12],
          },
        ],
        elapsedMs: 3,
      };
    };

    rmSync(originalPath, { force: true });
    await assert.rejects(
      () => processNextJob(ocrWorker),
      (error: unknown) =>
        (error as { code?: string })?.code === "SOURCE_FILE_MISSING",
    );
    assert.equal(workerCalls, 0);
    let ocrJob = jobRow(upload.reportId, "ocr");
    assert.equal(ocrJob.status, "queued");
    assert.equal(ocrJob.errorCode, "SOURCE_FILE_MISSING");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM ocr_results WHERE job_id = ?")
        .get(ocrJob.id) as { count: number }).count,
      0,
    );

    writeFileSync(originalPath, originalBytes, { mode: 0o600 });
    db.prepare(
      "UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(ocrJob.id);
    assert.equal(await processNextJob(ocrWorker), true);
    ocrJob = jobRow(upload.reportId, "ocr");
    assert.equal(ocrJob.status, "completed");
    assert.equal(
      ocrJob.attempts,
      fixture.expected.sourceMissingRetryAttempts,
    );
    assert.equal(workerCalls, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM ocr_results WHERE job_id = ?")
        .get(ocrJob.id) as { count: number }).count,
      1,
    );

    const thumbnailJob = jobRow(upload.reportId, "thumbnail");
    db.prepare(
      `
      UPDATE processing_jobs
      SET status = 'queued', attempts = 0, next_retry_at = CURRENT_TIMESTAMP,
        error_code = NULL, error_message = NULL, finished_at = NULL
      WHERE id = ?
    `,
    ).run(thumbnailJob.id);
    writeFileSync(originalPath, originalBytes.subarray(0, originalBytes.length - 1));
    let thumbnailWorkerCalls = 0;
    const thumbnailWorker: WorkerExecutor = async (request) => {
      thumbnailWorkerCalls += 1;
      assert.ok(request.outputPath);
      writeFileSync(request.outputPath, "valid-thumbnail");
      return { ok: true, width: 240, height: 320, elapsedMs: 2 };
    };
    await assert.rejects(
      () => processNextJob(thumbnailWorker),
      (error: unknown) =>
        (error as { code?: string })?.code === "SOURCE_FILE_SIZE_MISMATCH",
    );
    assert.equal(thumbnailWorkerCalls, 0);
    let retriedThumbnailJob = jobRow(upload.reportId, "thumbnail");
    assert.equal(retriedThumbnailJob.status, "queued");
    assert.equal(retriedThumbnailJob.errorCode, "SOURCE_FILE_SIZE_MISMATCH");

    writeFileSync(originalPath, originalBytes, { mode: 0o600 });
    db.prepare(
      "UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(retriedThumbnailJob.id);
    assert.equal(await processNextJob(thumbnailWorker), true);
    retriedThumbnailJob = jobRow(upload.reportId, "thumbnail");
    assert.equal(retriedThumbnailJob.status, "completed");
    assert.equal(
      retriedThumbnailJob.attempts,
      fixture.expected.sourceMismatchRetryAttempts,
    );
    assert.equal(thumbnailWorkerCalls, 1);
    const completedPage = pageRow(upload.reportId);
    assert.ok(completedPage.thumbnailPath);
    assert.equal(
      existsSync(join(storageDir, completedPage.thumbnailPath)),
      true,
    );

    const interruptedUpload = createUpload(manager, memberId, [
      { originalName: "缩略图中断.png", data: pngBytes(5) },
    ]);
    db.prepare(
      "UPDATE processing_jobs SET status = 'cancelled' WHERE report_id = ? AND job_type = 'ocr'",
    ).run(interruptedUpload.reportId);
    const interruptedPage = pageRow(interruptedUpload.reportId);
    const interruptedThumbnailPath = join(
      storageDir,
      "thumbnails",
      interruptedUpload.reportId,
      `${interruptedPage.id}.jpg`,
    );
    await assert.rejects(
      () =>
        processNextJob(async (request) => {
          assert.ok(request.outputPath);
          mkdirSync(dirname(request.outputPath), { recursive: true });
          writeFileSync(request.outputPath, "partial-thumbnail");
          throw Object.assign(new Error("模拟缩略图写入中断"), {
            code: "THUMBNAIL_WRITE_INTERRUPTED",
          });
        }),
      (error: unknown) =>
        (error as { code?: string })?.code === "THUMBNAIL_WRITE_INTERRUPTED",
    );
    assert.equal(
      Number(existsSync(interruptedThumbnailPath)),
      fixture.expected.partialThumbnailFilesAfterFailure,
    );
    assert.equal(pageRow(interruptedUpload.reportId).thumbnailPath, null);

    const interruptedThumbnailJob = jobRow(
      interruptedUpload.reportId,
      "thumbnail",
    );
    db.prepare(
      "UPDATE processing_jobs SET next_retry_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(interruptedThumbnailJob.id);
    assert.equal(
      await processNextJob(async (request) => {
        assert.ok(request.outputPath);
        writeFileSync(request.outputPath, "cancelled-partial-thumbnail");
        db.prepare(
          "UPDATE processing_jobs SET status = 'cancelled', locked_at = NULL, lease_expires_at = NULL WHERE id = ?",
        ).run(interruptedThumbnailJob.id);
        return { ok: true, width: 240, height: 320, elapsedMs: 2 };
      }),
      true,
    );
    assert.equal(
      Number(existsSync(interruptedThumbnailPath)),
      fixture.expected.partialThumbnailFilesAfterFailure,
    );
    assert.equal(pageRow(interruptedUpload.reportId).thumbnailPath, null);
    assert.equal(
      jobRow(interruptedUpload.reportId, "thumbnail").status,
      "cancelled",
    );

    const orphanOriginal = join(
      storageDir,
      "reports",
      "orphan-report",
      "orphan.png",
    );
    const orphanThumbnail = join(
      storageDir,
      "thumbnails",
      "orphan-report",
      "orphan.jpg",
    );
    mkdirSync(dirname(orphanOriginal), { recursive: true });
    mkdirSync(dirname(orphanThumbnail), { recursive: true });
    writeFileSync(orphanOriginal, "orphan-original");
    writeFileSync(orphanThumbnail, "orphan-thumbnail");
    const oldTimestamp = new Date(Date.now() - 60_000);
    utimesSync(orphanOriginal, oldTimestamp, oldTimestamp);
    utimesSync(orphanThumbnail, oldTimestamp, oldTimestamp);

    const scan = scanOrphanStorageFiles(0);
    assert.equal(scan.queued, fixture.expected.orphanFilesQueued);
    enqueueFileGarbage(
      [{ storagePath: completedPage.storagePath, fileKind: "original" }],
      "storage_golden_reference_guard",
      db,
      0,
    );
    const gc = runFileGarbageCollection();
    assert.equal(gc.deleted, fixture.expected.orphanFilesDeleted);
    assert.equal(gc.retained, fixture.expected.referencedFilesRetained);
    assert.equal(gc.failed, 0);
    assert.equal(existsSync(orphanOriginal), false);
    assert.equal(existsSync(orphanThumbnail), false);
    assert.equal(existsSync(originalPath), true);

    const completedGcRows = db
      .prepare(
        `
        SELECT storage_path AS storagePath, completed_at AS completedAt
        FROM file_gc_queue WHERE reason IN ('orphan_scan', 'storage_golden_reference_guard')
      `,
      )
      .all() as Array<{ storagePath: string; completedAt: string | null }>;
    assert.equal(completedGcRows.length, 3);
    assert.equal(completedGcRows.every((row) => Boolean(row.completedAt)), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
