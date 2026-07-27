import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  enqueueIndicatorNormalizationTask,
  getIndicatorNormalizationTask,
  runIndicatorNormalizationTasks
} from "../services/indicator-normalization-task.service.ts";

const manager: RequestUser = {
  id: "normalization-task-manager",
  displayName: "维护管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};

test("runs indicator normalization as a persistent asynchronous maintenance task", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-normalization-task-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('normalization-task-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('normalization-task-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    const insertReport = db.prepare(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
      VALUES (?, 'normalization-task-member', ?, 'laboratory', ?, 'ready', ?)
    `);
    insertReport.run("normalization-task-report-1", manager.id, "血脂检查", "2026-01-01");
    insertReport.run("normalization-task-report-2", manager.id, "血糖检查", "2026-02-01");
    const insertObservation = db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name,
        result_text, numeric_value, unit, abnormal_flag
      ) VALUES (?, ?, '生化检验', ?, ?, ?, ?, ?, 'normal')
    `);
    insertObservation.run(
      "normalization-task-observation-1",
      "normalization-task-report-1",
      "总胆固醇",
      "总胆固醇",
      "4.2",
      4.2,
      "mmol/L"
    );
    insertObservation.run(
      "normalization-task-observation-2",
      "normalization-task-report-2",
      "空腹血糖",
      "空腹血糖",
      "5.1",
      5.1,
      "mmol/L"
    );

    const queued = enqueueIndicatorNormalizationTask(manager);
    assert.equal(queued.reused, false);
    assert.equal(queued.mode, "incremental");
    assert.equal(["queued", "running"].includes(queued.status), true);

    const reused = enqueueIndicatorNormalizationTask(manager, { full: true });
    assert.equal(reused.reused, true);
    assert.equal(reused.id, queued.id);
    assert.equal(reused.mode, "incremental");

    await runIndicatorNormalizationTasks();

    const completed = getIndicatorNormalizationTask(manager, queued.id);
    assert.ok(completed);
    assert.equal(completed.status, "completed");
    assert.equal(completed.totalReports, 2);
    assert.equal(completed.processedReports, 2);
    assert.equal(completed.progressPercent, 100);
    assert.equal(completed.result?.scanned, 2);
    assert.equal(completed.result?.normalized, 2);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM observation_normalizations").get() as { count: number }).count,
      2
    );
    const audit = db.prepare(`
      SELECT detail_json AS detailJson FROM audit_logs
      WHERE action = 'maintenance.normalize_indicators'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get() as { detailJson: string };
    assert.equal(JSON.parse(audit.detailJson).taskId, queued.id);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
