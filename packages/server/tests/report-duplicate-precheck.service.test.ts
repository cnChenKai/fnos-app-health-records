import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { findLocalDuplicateEvidence } from "../services/report-duplicate-precheck.service.ts";
import { createUpload } from "../services/upload.service.ts";

const manager: RequestUser = {
  id: "duplicate-precheck-manager",
  displayName: "任务管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};

const baseLines = [
  "健康体检检验结果汇总",
  "白细胞计数 5.62 10^9/L 3.50-9.50",
  "红细胞计数 4.83 10^12/L 4.30-5.80",
  "血红蛋白 151 g/L 130-175",
  "血小板计数 226 10^9/L 125-350",
  "空腹血糖 5.18 mmol/L 3.90-6.10",
  "总胆固醇 4.26 mmol/L 0.00-5.20",
  "甘油三酯 1.12 mmol/L 0.00-1.70",
  "谷丙转氨酶 22 U/L 9-50",
  "肌酐 78 μmol/L 57-111"
];

async function withDatabase(run: () => void) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-duplicate-precheck-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(manager.id, manager.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('duplicate-member', '本人', 'self', ?)
    `).run(manager.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('duplicate-member', ?, 'manager', ?)
    `).run(manager.id, manager.id);
    run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function addOcrReport(byte: number, lines: string[]) {
  const upload = createUpload(manager, "duplicate-member", [{
    originalName: `report-${byte}.png`,
    data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, byte])
  }]);
  const row = getDatabase().prepare(`
    SELECT p.id AS pageId, j.id AS jobId
    FROM report_pages p
    JOIN processing_jobs j ON j.page_id = p.id AND j.job_type = 'ocr'
    WHERE p.report_id = ?
  `).get(upload.reportId) as { pageId: string; jobId: string };
  const payload = lines.map((text, index) => ({
    id: `line_${index + 1}`,
    text,
    confidence: 0.99,
    box: [0, index * 20, 520, index * 20 + 14]
  }));
  getDatabase().prepare(`
    INSERT INTO ocr_results (
      id, job_id, page_id, engine, model_version, lines_json, text_length
    ) VALUES (?, ?, ?, 'test-ocr', 'test-v1', ?, ?)
  `).run(`ocr-${byte}`, row.jobId, row.pageId, JSON.stringify(payload), lines.join("").length);
  getDatabase().prepare(`
    UPDATE processing_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP
    WHERE report_id = ?
  `).run(upload.reportId);
  getDatabase().prepare(`
    UPDATE reports SET status = 'ready', title = '健康体检报告' WHERE id = ?
  `).run(upload.reportId);
  return upload.reportId;
}

test("finds rescanned reports from local OCR before AI extraction", () => withDatabase(() => {
  const existing = addOcrReport(1, baseLines);
  const incoming = addOcrReport(2, baseLines);
  const matches = findLocalDuplicateEvidence(incoming);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].reportId, existing);
  assert.equal(matches[0].confidence, "high");
  assert.match(matches[0].reason, /OCR.*高度一致/);
}));

test("does not block AI for the same examination panel with different result values", () => withDatabase(() => {
  addOcrReport(3, baseLines);
  const changed = baseLines.map((line, index) => index === 0
    ? line
    : line.replace(/\s\d+(?:\.\d+)?\s/, ` ${(index * 1.37 + 2).toFixed(2)} `));
  const incoming = addOcrReport(4, changed);
  const matches = findLocalDuplicateEvidence(incoming);
  assert.equal(matches.some((match) => match.confidence === "high"), false);
}));
