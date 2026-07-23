import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  createBackup,
  createReminder,
  confirmReportReady,
  deleteBackup,
  deleteReportPage,
  getReportDetail,
  getReportPageFile,
  getReportSummaryStats,
  getAiAuditSummary,
  getBackupDownload,
  listAppNotifications,
  listAuditLogs,
  listBackups,
  listDuplicateReportGroups,
  listReportOcrText,
  listReports,
  listReminders,
  listTrendSeries,
  listUserOperationAuditLogs,
  mergeDuplicateReport,
  restoreBackup as restoreFullBackup,
  restoreUploadedBackup,
  restoreReport,
  trashReport,
  updateReminderStatus,
  updateAppNotificationStatus,
  updateReportFields,
  updateReportPages,
  validateBackup
} from "../services/records.service.ts";
import { createUpload } from "../services/upload.service.ts";

const manager: RequestUser = {
  id: "records-manager",
  displayName: "档案管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};
const samplePhone = ["138", "0013", "8000"].join("");

function pngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
}

function anotherPngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03]);
}

test("lists reports with cursors and returns detail pages with original files", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const newer = createUpload(manager, "records-member", [{ originalName: "new.png", data: pngBytes() }]);
    const older = createUpload(manager, "records-member", [{ originalName: "old.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'ready',
        hospital_name_raw = '示例医院', report_issued_at = ?
      WHERE id = ?
    `).run("较新的报告", "2026-07-21", newer.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = 'ready',
        hospital_name_raw = '示例医院', report_issued_at = ?
      WHERE id = ?
    `).run("较早的报告", "2026-06-01", older.reportId);

    const firstPage = listReports(manager, 1, "records-member");
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0]?.title, "较新的报告");
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor);

    const secondPage = listReports(manager, 1, "records-member", firstPage.nextCursor || undefined);
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.items[0]?.title, "较早的报告");

    const detail = getReportDetail(manager, newer.reportId);
    assert.equal(detail.pages.length, 1);
    assert.equal(detail.hospitalName, "示例医院");

    const file = getReportPageFile(manager, newer.reportId, detail.pages[0].id, "original");
    assert.equal(file.mimeType, "image/png");
    assert.equal(existsSync(file.path), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("detects duplicate report candidates from extracted content instead of file hash", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const existing = createUpload(manager, "records-member", [{ originalName: "first.png", data: pngBytes() }]);
    const incoming = createUpload(manager, "records-member", [{ originalName: "second.png", data: anotherPngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'ready',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        visit_department = '检验科', identifiers_json = '{"reportNo":"LAB-20260721-001"}'
      WHERE id = ?
    `).run("血常规报告", existing.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'needs_review',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        visit_department = '检验科', identifiers_json = '{"reportNo":"LAB-20260721-001"}'
      WHERE id = ?
    `).run("血常规报告", incoming.reportId);

    const firstPage = getReportDetail(manager, existing.reportId).pages[0];
    const secondPage = getReportDetail(manager, incoming.reportId).pages[0];
    assert.notEqual(firstPage.fileSize, secondPage.fileSize);

    const detail = getReportDetail(manager, incoming.reportId);
    assert.equal(detail.duplicateCandidates.length, 1);
    assert.equal(detail.duplicateCandidates[0].id, existing.reportId);
    assert.equal(detail.duplicateCandidates[0].confidence, "high");
    assert.match(detail.duplicateCandidates[0].reason, /reportNo/);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("detects duplicate candidates without report numbers when core extracted content matches", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-core-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const existing = createUpload(manager, "records-member", [{ originalName: "first.png", data: pngBytes() }]);
    const incoming = createUpload(manager, "records-member", [{ originalName: "second.png", data: anotherPngBytes() }]);
    const bodyParts = JSON.stringify([{ raw: "甲状腺", name: "甲状腺", parent: null, laterality: "unspecified" }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = 'ready',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?,
        impression = '甲状腺双叶回声欠均匀，右叶可见低回声结节，建议结合临床随访复查。'
      WHERE id = ?
    `).run("甲状腺超声报告", bodyParts, existing.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = 'needs_review',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?,
        impression = '甲状腺双叶回声欠均匀，右叶可见低回声结节，建议结合临床随访复查。'
      WHERE id = ?
    `).run("甲状腺超声报告", bodyParts, incoming.reportId);

    const detail = getReportDetail(manager, incoming.reportId);
    assert.equal(detail.duplicateCandidates.length, 1);
    assert.equal(detail.duplicateCandidates[0].id, existing.reportId);
    assert.equal(detail.duplicateCandidates[0].confidence, "medium");
    assert.match(detail.duplicateCandidates[0].reason, /核心报告内容一致/);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("does not flag different reports as duplicates when only hospital date type and department match", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-loose-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const existing = createUpload(manager, "records-member", [{ originalName: "heart.png", data: pngBytes() }]);
    const incoming = createUpload(manager, "records-member", [{ originalName: "lung.png", data: anotherPngBytes() }]);
    const bodyParts = JSON.stringify([{ raw: "常规检查", name: "常规检查", parent: null, laterality: "unspecified" }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'functional', status = 'ready',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '功能检查科', body_parts_json = ?,
        impression = '窦性心律，心电轴不偏，未见明显 ST-T 异常。'
      WHERE id = ?
    `).run("心电图报告", bodyParts, existing.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'functional', status = 'needs_review',
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '功能检查科', body_parts_json = ?,
        impression = '肺通气功能大致正常，支气管舒张试验阴性。'
      WHERE id = ?
    `).run("肺功能报告", bodyParts, incoming.reportId);

    const detail = getReportDetail(manager, incoming.reportId);
    assert.equal(detail.duplicateCandidates.length, 0);
    assert.equal(listDuplicateReportGroups(manager, "records-member").length, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("does not flag same-day laboratory reports as duplicates when only a few common indicators overlap", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-observations-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const liver = createUpload(manager, "records-member", [{ originalName: "liver.png", data: pngBytes() }]);
    const kidney = createUpload(manager, "records-member", [{ originalName: "kidney.png", data: anotherPngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'ready',
        hospital_name_raw = '示例体检中心', report_issued_at = '2026-07-21',
        performing_department = '检验科'
      WHERE id = ?
    `).run("肝功能检验报告", liver.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = 'needs_review',
        hospital_name_raw = '示例体检中心', report_issued_at = '2026-07-21',
        performing_department = '检验科'
      WHERE id = ?
    `).run("肾功能检验报告", kidney.reportId);

    const insertObservation = db.prepare(`
      INSERT INTO observations (id, report_id, section_name, item_name, normalized_name, result_text, unit, abnormal_flag)
      VALUES (?, ?, '生化检验', ?, ?, ?, 'U/L', 'normal')
    `);
    const shared = [
      ["白蛋白", "白蛋白", "42"],
      ["总蛋白", "总蛋白", "70"],
      ["球蛋白", "球蛋白", "28"]
    ];
    const liverOnly = [
      ["丙氨酸氨基转移酶", "丙氨酸氨基转移酶", "21"],
      ["天门冬氨酸氨基转移酶", "天门冬氨酸氨基转移酶", "19"],
      ["总胆红素", "总胆红素", "12"],
      ["直接胆红素", "直接胆红素", "4"],
      ["碱性磷酸酶", "碱性磷酸酶", "65"]
    ];
    const kidneyOnly = [
      ["肌酐", "肌酐", "72"],
      ["尿素", "尿素", "5.2"],
      ["尿酸", "尿酸", "330"],
      ["胱抑素C", "胱抑素C", "0.82"],
      ["估算肾小球滤过率", "估算肾小球滤过率", "98"]
    ];
    [...shared, ...liverOnly].forEach(([itemName, normalizedName, resultText], index) => {
      insertObservation.run(`obs-liver-${index}`, liver.reportId, itemName, normalizedName, resultText);
    });
    [...shared, ...kidneyOnly].forEach(([itemName, normalizedName, resultText], index) => {
      insertObservation.run(`obs-kidney-${index}`, kidney.reportId, itemName, normalizedName, resultText);
    });

    const detail = getReportDetail(manager, kidney.reportId);
    assert.equal(detail.duplicateCandidates.length, 0);
    assert.equal(listDuplicateReportGroups(manager, "records-member").length, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("scans duplicate groups and merges source pages into the target report", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-duplicates-merge-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const target = createUpload(manager, "records-member", [{ originalName: "target.png", data: pngBytes() }]);
    const source = createUpload(manager, "records-member", [{ originalName: "source.png", data: anotherPngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = ?,
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?
      WHERE id = ?
    `);
    const bodyParts = JSON.stringify([{ raw: "甲状腺", name: "甲状腺", parent: null, laterality: "unspecified" }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = ?,
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?,
        impression = '甲状腺右叶结节，边界清，建议随访复查。'
      WHERE id = ?
    `).run("目标甲状腺超声报告", "ready", bodyParts, target.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'imaging', status = ?,
        hospital_name_raw = '示例医院', report_issued_at = '2026-07-21',
        performing_department = '超声科', body_parts_json = ?,
        impression = '甲状腺右叶结节，边界清，建议随访复查。'
      WHERE id = ?
    `).run("重复甲状腺超声报告", "needs_review", bodyParts, source.reportId);

    const groups = listDuplicateReportGroups(manager, "records-member");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].candidates.length, 1);

    const result = mergeDuplicateReport(manager, source.reportId, target.reportId);
    assert.equal(result.movedPages, 1);
    const targetDetail = getReportDetail(manager, target.reportId);
    assert.equal(targetDetail.pages.length, 2);
    assert.equal(targetDetail.status, "needs_review");
    assert.equal(listReports(manager, 30, { memberId: "records-member", trash: true }).items.some((item) => item.id === source.reportId), true);
    assert.equal(listDuplicateReportGroups(manager, "records-member").length, 0);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("moves a duplicate report to the 30 day recycle bin without deleting originals", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-trash-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const upload = createUpload(manager, "records-member", [{ originalName: "duplicate.png", data: pngBytes() }]);
    const page = getReportDetail(manager, upload.reportId).pages[0];
    const file = getReportPageFile(manager, upload.reportId, page.id, "original");
    assert.equal(existsSync(file.path), true);

    assert.deepEqual(trashReport(manager, upload.reportId), { id: upload.reportId, status: "trashed", purgeAfterDays: 30 });
    assert.equal(existsSync(file.path), true);
    assert.equal(listReports(manager, 30, "records-member").items.some((report) => report.id === upload.reportId), false);
    assert.throws(() => getReportDetail(manager, upload.reportId), /报告不存在/);

    const row = db.prepare("SELECT status, deleted_at AS deletedAt, purge_after AS purgeAfter FROM reports WHERE id = ?")
      .get(upload.reportId) as { status: string; deletedAt: string | null; purgeAfter: string | null };
    assert.equal(row.status, "trashed");
    assert.ok(row.deletedAt);
    assert.ok(row.purgeAfter);
    const activeJobs = db.prepare("SELECT COUNT(*) AS count FROM processing_jobs WHERE report_id = ? AND status IN ('queued', 'processing')")
      .get(upload.reportId) as { count: number };
    assert.equal(activeJobs.count, 0);
    const audit = db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'report.trash'")
      .get(upload.reportId) as { count: number };
    assert.equal(audit.count, 1);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("supports manual review edits, page edits, search filters, reminders, backups and audit", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-workflows-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const upload = createUpload(manager, "records-member", [
      { originalName: "first.png", data: pngBytes() },
      { originalName: "second.png", data: anotherPngBytes() }
    ]);
    const ocrJob = db.prepare("SELECT id FROM processing_jobs WHERE page_id = ? AND job_type = 'ocr' LIMIT 1")
      .get(upload.pages[0].id) as { id: string };
    db.prepare(`
      INSERT INTO ocr_results (id, job_id, page_id, engine, model_version, lines_json)
      VALUES ('ocr-search', NULL, ?, 'test', 'v1', ?)
    `.replace("NULL", "?")).run(ocrJob.id, upload.pages[0].id, JSON.stringify([{ text: "甲状腺彩超 复查" }]));

    const edited = updateReportFields(manager, upload.reportId, {
      title: "人工校对报告",
      reportType: "imaging",
      hospitalName: "校对医院",
      departmentName: "超声科",
      bodyPart: "甲状腺",
      reportIssuedAt: "2026-07-21",
      recommendation: "3个月后复查"
    });
    assert.equal(edited.title, "人工校对报告");
    assert.equal(edited.bodyPart, "甲状腺");
    assert.equal(listReports(manager, 30, { memberId: "records-member", query: "校对医院", reportType: "imaging" }).items.length, 1);
    assert.equal(listReports(manager, 30, { memberId: "records-member", ocrQuery: "甲状腺彩超" }).items.length, 1);

    const reversed = updateReportPages(manager, upload.reportId, {
      pages: [
        { id: upload.pages[1].id, rotation: 90 },
        { id: upload.pages[0].id, rotation: 0 }
      ]
    });
    assert.equal(reversed.pages[0].id, upload.pages[1].id);
    assert.equal(reversed.pages[0].rotation, 90);
    deleteReportPage(manager, upload.reportId, upload.pages[0].id);

	    const reminder = createReminder(manager, { memberId: "records-member", title: "手工复查", dueAt: "2026-10-21" });
	    assert.equal((listReminders(manager, "records-member") as Array<{ id: string }>).some((item) => item.id === reminder.id), true);
	    assert.deepEqual(updateReminderStatus(manager, reminder.id, "completed"), { id: reminder.id, status: "completed" });
	    db.prepare(`
	      INSERT INTO app_notifications (id, member_id, report_id, type, title, message, severity)
	      VALUES ('notice-records-done', 'records-member', ?, 'report_processed', '报告处理完成', '报告已完成识别', 'success')
	    `).run(upload.reportId);
	    const notices = listAppNotifications(manager, "records-member") as Array<{ id: string; status: string; type: string }>;
	    assert.equal(notices.some((item) => item.id === "notice-records-done" && item.type === "report_processed"), true);
	    assert.deepEqual(updateAppNotificationStatus(manager, "notice-records-done", "archived"), { id: "notice-records-done", status: "archived" });
	    assert.equal((listAppNotifications(manager, "records-member") as Array<{ id: string }>).some((item) => item.id === "notice-records-done"), false);

	    db.prepare("UPDATE reports SET status = 'needs_review' WHERE id = ?").run(upload.reportId);
    assert.deepEqual(confirmReportReady(manager, upload.reportId), { id: upload.reportId, status: "ready", reminderCreated: true });
    const reportReminders = listReminders(manager, "records-member") as Array<{
      source: string;
      reportId: string | null;
      reportTitle: string | null;
      reportHospitalName: string | null;
      reportIssuedAt: string | null;
    }>;
    assert.equal(reportReminders.some((item) => item.source === "report_suggestion"), true);
    assert.equal(reportReminders.some((item) => item.reportId === upload.reportId && item.reportTitle === "人工校对报告" && item.reportHospitalName === "校对医院" && item.reportIssuedAt === "2026-07-21"), true);

    const trashed = trashReport(manager, upload.reportId);
    assert.equal(trashed.status, "trashed");
    assert.equal(listReports(manager, 30, { memberId: "records-member", trash: true }).items.length, 1);
    assert.equal(restoreReport(manager, upload.reportId).status, "needs_review");

    db.prepare(`
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, attempts, pipeline_version, deduplication_key, created_at, finished_at
      ) VALUES ('ai-audit-job', ?, NULL, 'ai_extract', 'completed', 1, 'test', 'ai-audit-job-key', '2026-07-21 12:00:00', CURRENT_TIMESTAMP)
    `).run(upload.reportId);
    db.prepare(`
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, attempts, pipeline_version, deduplication_key, error_code, error_message, created_at, finished_at
      ) VALUES ('ai-audit-job-old', ?, NULL, 'ai_extract', 'failed', 2, 'test', 'ai-audit-job-old-key', 'AI_ERROR', '模型返回异常', '2026-07-20 12:00:00', CURRENT_TIMESTAMP)
    `).run(upload.reportId);
    db.prepare(`
      INSERT INTO report_extractions (
        id, report_id, job_id, provider, model, prompt_version, fields_json,
        evidence_json, confidence_json, raw_response_json, input_characters,
        prompt_tokens, completion_tokens, elapsed_ms
      ) VALUES ('ai-audit-extract', ?, 'ai-audit-job', 'test-provider', 'test-model', 'test',
        '{}', '{}', '{}', '{}', 1200, 80, 40, 900)
    `).run(upload.reportId);
    const aiAudit = getAiAuditSummary(manager);
    assert.equal(aiAudit.summary.callCount, 3);
    assert.equal(aiAudit.summary.successJobs, 1);
    assert.equal(aiAudit.summary.failedJobs, 1);
    assert.equal(aiAudit.summary.totalTokens, 120);
    const firstAiAuditPage = getAiAuditSummary(manager, 1);
    assert.equal(firstAiAuditPage.recent.length, 1);
    assert.equal(firstAiAuditPage.hasMore, true);
    assert.equal(firstAiAuditPage.nextCursor !== null, true);
    const secondAiAuditPage = getAiAuditSummary(manager, 1, firstAiAuditPage.nextCursor || undefined);
    assert.equal(secondAiAuditPage.recent[0].id, "ai-audit-job-old");
    assert.equal(secondAiAuditPage.hasMore, false);

    const backup = createBackup(manager);
    assert.equal(existsSync(backup.path), true);
    assert.equal((listAuditLogs(manager, 20) as Array<{ action: string }>).some((item) => item.action === "backup.create"), true);
    const auditPage = listUserOperationAuditLogs(manager, 3);
    assert.equal(auditPage.items.length, 3);
    assert.equal(auditPage.hasMore, true);
    assert.ok(auditPage.nextCursor);
    assert.equal(listUserOperationAuditLogs(manager, 3, auditPage.nextCursor || undefined).items.length > 0, true);
    const readableAudit = listUserOperationAuditLogs(manager, 20).items;
    assert.equal(readableAudit.some((item) => item.title === "创建完整备份"), true);
    const uploadAudit = readableAudit.find((item) => item.action === "report.upload");
    assert.ok(uploadAudit);
    assert.match(uploadAudit.description, /成员 本人/);
    assert.equal(uploadAudit.targetName, "人工校对报告");
    assert.doesNotMatch(uploadAudit.description, /member_[a-z0-9]+/);
    const pageDeleteAudit = readableAudit.find((item) => item.action === "report.page.delete");
    assert.ok(pageDeleteAudit);
    assert.equal(pageDeleteAudit.targetName, "人工校对报告 · 报告页面");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("creates, lists, downloads and restores a full app backup", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-full-backup-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const upload = createUpload(manager, "records-member", [{ originalName: "backup-source.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = '备份前报告', report_type = 'laboratory', status = 'ready',
        hospital_name_raw = '备份医院', report_issued_at = '2026-07-22'
      WHERE id = ?
    `).run(upload.reportId);
    const detailBefore = getReportDetail(manager, upload.reportId);
    const originalBefore = getReportPageFile(manager, upload.reportId, detailBefore.pages[0].id, "original");
    assert.equal(existsSync(originalBefore.path), true);

    const backup = createBackup(manager);
    assert.equal(existsSync(backup.path), true);
    assert.match(backup.filename, /^fnos-app-health-records-backup-\d{8}-\d{6}-\d{3}\.tar\.gz$/);
    assert.equal(listBackups(manager).some((item) => item.id === backup.id && item.reportCount === 1), true);
    const validation = validateBackup(manager, backup.id);
    assert.equal(validation.valid, true);
    assert.equal(validation.checksumAvailable, true);
    assert.ok(validation.fileCount > 0);
    assert.equal(validation.checkedCount, validation.fileCount);
    const extractRoot = mkdtempSync(join(tmpdir(), "health-records-backup-manifest-"));
    try {
      execFileSync("tar", ["-xzf", backup.path, "-C", extractRoot], { stdio: "pipe" });
      const manifest = JSON.parse(readFileSync(join(extractRoot, "manifest.json"), "utf8")) as { files: Array<{ path: string; sha256: string }> };
      assert.ok(manifest.files.some((item) => item.path === "db/health-records.sqlite" && /^[a-f0-9]{64}$/.test(item.sha256)));
      writeFileSync(join(extractRoot, "db", "health-records.sqlite"), "tampered backup");
      const tamperedArchive = join(storageDir, "tampered-backup.tar.gz");
      execFileSync("tar", ["-czf", tamperedArchive, "-C", extractRoot, "."], { stdio: "pipe" });
      assert.throws(() => restoreUploadedBackup(manager, tamperedArchive), /备份校验失败/);
    } finally {
      rmSync(extractRoot, { recursive: true, force: true });
    }
    const download = getBackupDownload(manager, backup.id);
    assert.equal(download.filename, backup.filename);
    assert.equal(existsSync(download.path), true);

    db.prepare("UPDATE reports SET title = '被误改的报告' WHERE id = ?").run(upload.reportId);
    rmSync(join(storageDir, "reports"), { recursive: true, force: true });
    assert.equal(existsSync(originalBefore.path), false);

    const restored = restoreFullBackup(manager, backup.id);
    assert.equal(restored.restored, true);
    assert.ok(restored.safetyBackupId);
    const detailAfter = getReportDetail(manager, upload.reportId);
    assert.equal(detailAfter.title, "备份前报告");
    const originalAfter = getReportPageFile(manager, upload.reportId, detailAfter.pages[0].id, "original");
    assert.equal(existsSync(originalAfter.path), true);
    assert.equal(listBackups(manager).some((item) => item.id === restored.safetyBackupId && item.reason === "pre_restore"), true);
    assert.equal((listAuditLogs(manager, 20) as Array<{ action: string }>).some((item) => item.action === "backup.restore"), true);
    const safetyBackup = getBackupDownload(manager, restored.safetyBackupId);
    assert.equal(existsSync(safetyBackup.path), true);
    assert.deepEqual(deleteBackup(manager, restored.safetyBackupId), { id: restored.safetyBackupId, deleted: true });
    assert.equal(existsSync(safetyBackup.path), false);
    assert.equal(listBackups(manager).some((item) => item.id === restored.safetyBackupId), false);
    assert.equal((listAuditLogs(manager, 20) as Array<{ action: string }>).some((item) => item.action === "backup.delete"), true);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("confirms a reviewed report and returns redacted OCR text", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-review-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const upload = createUpload(manager, "records-member", [{ originalName: "ocr.png", data: pngBytes() }]);
    const page = db.prepare("SELECT id FROM report_pages WHERE report_id = ?").get(upload.reportId) as { id: string };
    const job = db.prepare("SELECT id FROM processing_jobs WHERE report_id = ? AND job_type = 'ocr'")
      .get(upload.reportId) as { id: string };
    db.prepare(`
      INSERT INTO ocr_results (id, job_id, page_id, engine, model_version, lines_json, elapsed_ms)
      VALUES ('ocr-test', ?, ?, 'test-ocr', 'v1', ?, 8)
    `).run(job.id, page.id, JSON.stringify([
      { text: "示例医院 检验报告" },
      { text: `联系电话 ${samplePhone}` },
      { text: "空腹血糖 5.2 mmol/L" }
    ]));
    db.prepare("UPDATE reports SET status = 'needs_review' WHERE id = ?").run(upload.reportId);

    const ocr = listReportOcrText(manager, upload.reportId) as Array<{ text: string; lineCount: number }>;
    assert.equal(ocr.length, 1);
    assert.equal(ocr[0].lineCount, 2);
    assert.match(ocr[0].text, /示例医院|空腹血糖/);
    assert.doesNotMatch(ocr[0].text, new RegExp(`${samplePhone}|联系电话`));

    assert.deepEqual(confirmReportReady(manager, upload.reportId), { id: upload.reportId, status: "ready" });
    const status = db.prepare("SELECT status FROM reports WHERE id = ?").get(upload.reportId) as { status: string };
    assert.equal(status.status, "ready");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("returns concrete trend values from reviewed and archived reports", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-trends-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const first = createUpload(manager, "records-member", [{ originalName: "first.png", data: pngBytes() }]);
    const second = createUpload(manager, "records-member", [{ originalName: "second.png", data: pngBytes() }]);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = ?, hospital_name_raw = '示例医院', report_issued_at = ?
      WHERE id = ?
    `).run("第一次血糖", "ready", "2026-06-01", first.reportId);
    db.prepare(`
      UPDATE reports SET title = ?, report_type = 'laboratory', status = ?, hospital_name_raw = '示例医院', report_issued_at = ?
      WHERE id = ?
    `).run("第二次血糖", "needs_review", "2026-07-21", second.reportId);
	    const insertObservation = db.prepare(`
	      INSERT INTO observations (
	        id, report_id, section_name, item_name, normalized_name, result_text, numeric_value, unit,
	        reference_text, abnormal_flag, evidence_json
	      ) VALUES (?, ?, '生化检验', ?, ?, ?, ?, ?, '3.9-6.1', ?, ?)
	    `);
	    insertObservation.run("obs-first", first.reportId, "空腹血糖", "空腹血糖", "5.2 mmol/L", null, "MMOL/L", "normal", JSON.stringify([{ pageNumber: 1, quote: "空腹血糖 5.2 mmol/L" }]));
	    insertObservation.run("obs-second", second.reportId, "血糖", "血糖", "6.8", 6.8, "mmol/L", "high", JSON.stringify([{ pageNumber: 1, quote: "血糖 6.8 mmol/L" }]));

	    const trends = listTrendSeries(manager, "records-member") as Array<{
	      name: string;
	      unit: string;
	      pointCount: number;
	      latestValue: number;
	      delta: number;
	      points: Array<{
	        reportId: string;
	        numericValue: number;
	        reportStatus: string;
	        abnormalFlag: string;
	        evidenceQuote: string | null;
	        sourcePage: { id: string; pageNumber: number; originalName: string } | null;
	      }>;
	    }>;
	    assert.equal(trends.length, 1);
	    assert.equal(trends[0].name, "空腹血糖");
	    assert.equal(trends[0].unit, "mmol/L");
	    assert.equal(trends[0].pointCount, 2);
	    assert.equal(trends[0].latestValue, 6.8);
	    assert.equal(Number(trends[0].delta.toFixed(1)), 1.6);
	    assert.deepEqual(trends[0].points.map((point) => point.numericValue), [5.2, 6.8]);
	    assert.equal(trends[0].points[1].reportStatus, "needs_review");
	    assert.equal(trends[0].points[1].abnormalFlag, "high");
	    assert.equal(trends[0].points[1].evidenceQuote, "血糖 6.8 mmol/L");
	    assert.equal(trends[0].points[1].sourcePage?.pageNumber, 1);
	    assert.equal(trends[0].points[1].sourcePage?.originalName, "second.png");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("summarizes report counts for the current member archive board", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-records-summary-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('records-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('records-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);

    const ready = createUpload(manager, "records-member", [{ originalName: "ready.png", data: pngBytes() }]);
    const review = createUpload(manager, "records-member", [{ originalName: "review.png", data: pngBytes() }]);
    const processing = createUpload(manager, "records-member", [{ originalName: "processing.png", data: pngBytes() }]);
    db.prepare("UPDATE reports SET status = 'ready', report_issued_at = '2026-06-01' WHERE id = ?").run(ready.reportId);
    db.prepare("UPDATE reports SET status = 'needs_review', report_issued_at = '2026-07-21' WHERE id = ?").run(review.reportId);
    db.prepare("UPDATE reports SET status = 'processing' WHERE id = ?").run(processing.reportId);
    db.prepare(`
      INSERT INTO observations (id, report_id, item_name, normalized_name, result_text, numeric_value, unit, abnormal_flag)
      VALUES ('summary-obs-1', ?, '血糖', '血糖', '6.8', 6.8, 'mmol/L', 'high')
    `).run(review.reportId);

    const stats = getReportSummaryStats(manager, "records-member");
    assert.deepEqual(stats, {
      totalReports: 3,
      readyReports: 1,
      needsReviewReports: 1,
      processingReports: 1,
      failedReports: 0,
      totalPages: 3,
      observationCount: 1,
      abnormalObservationCount: 1,
      latestReportIssuedAt: "2026-07-21"
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
