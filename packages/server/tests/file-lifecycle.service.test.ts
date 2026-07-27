import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { runFileGarbageCollection } from "../services/file-gc.service.ts";
import {
  deleteReportPage,
  getReportDetail,
  getReportPageFile,
  purgeExpiredReports,
  trashReport
} from "../services/records.service.ts";
import { createUpload } from "../services/upload.service.ts";

const manager: RequestUser = {
  id: "file-lifecycle-manager",
  displayName: "文件管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};

function pngBytes(suffix: number) {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, suffix]);
}

test("keeps a shared original until its final page is purged and removes page thumbnails", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-file-lifecycle-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('file-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('file-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const upload = createUpload(manager, "file-member", [
      { originalName: "shared-1.png", data: pngBytes(1) },
      { originalName: "shared-2.png", data: pngBytes(2) }
    ]);
    const detail = getReportDetail(manager, upload.reportId);
    const firstOriginal = getReportPageFile(manager, upload.reportId, detail.pages[0].id, "original").path;
    const secondOriginal = getReportPageFile(manager, upload.reportId, detail.pages[1].id, "original").path;
    const sharedRelativePath = (db.prepare("SELECT storage_path AS storagePath FROM report_pages WHERE id = ?")
      .get(detail.pages[0].id) as { storagePath: string }).storagePath;
    const firstThumbnail = join(storageDir, "thumbnails", upload.reportId, `${detail.pages[0].id}.jpg`);
    const secondThumbnail = join(storageDir, "thumbnails", upload.reportId, `${detail.pages[1].id}.jpg`);
    mkdirSync(dirname(firstThumbnail), { recursive: true });
    writeFileSync(firstThumbnail, "first thumbnail");
    writeFileSync(secondThumbnail, "second thumbnail");
    db.prepare(`
      UPDATE report_pages SET storage_path = ?, thumbnail_path = ? WHERE id = ?
    `).run(sharedRelativePath, `thumbnails/${upload.reportId}/${detail.pages[0].id}.jpg`, detail.pages[0].id);
    db.prepare(`
      UPDATE report_pages SET storage_path = ?, thumbnail_path = ? WHERE id = ?
    `).run(sharedRelativePath, `thumbnails/${upload.reportId}/${detail.pages[1].id}.jpg`, detail.pages[1].id);
    rmSync(secondOriginal, { force: true });

    deleteReportPage(manager, upload.reportId, detail.pages[0].id);
    db.prepare("UPDATE file_gc_queue SET not_before = datetime('now', '-1 minute')").run();
    const firstGc = runFileGarbageCollection();
    assert.equal(firstGc.deleted, 1);
    assert.equal(firstGc.retained, 1);
    assert.equal(existsSync(firstThumbnail), false);
    assert.equal(existsSync(firstOriginal), true);

    trashReport(manager, upload.reportId);
    db.prepare("UPDATE reports SET purge_after = datetime('now', '-1 minute') WHERE id = ?").run(upload.reportId);
    const cleanup = purgeExpiredReports();
    assert.equal(cleanup.deleted, 1);
    db.prepare("UPDATE file_gc_queue SET not_before = datetime('now', '-1 minute') WHERE completed_at IS NULL").run();
    const finalGc = runFileGarbageCollection();
    assert.equal(finalGc.deleted, 2);
    assert.equal(existsSync(firstOriginal), false);
    assert.equal(existsSync(secondThumbnail), false);
    const remainingReport = db.prepare("SELECT COUNT(*) AS count FROM reports WHERE id = ?")
      .get(upload.reportId) as { count: number };
    assert.equal(remainingReport.count, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
