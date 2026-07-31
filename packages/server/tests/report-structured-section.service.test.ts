import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { normalizeAiExtraction, persistAiExtraction } from "../services/ai-extraction.service.ts";
import { getReportDetail } from "../services/records.service.ts";
import {
  createReportStructuredSection,
  deleteReportStructuredSection,
  updateReportStructuredSection
} from "../services/report-structured-section.service.ts";

test("keeps manually edited and deleted report sections protected across AI reruns", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-structured-sections-"));
  process.env.STORAGE_DIR = storageDir;
  const owner: RequestUser = {
    id: "owner", displayName: "管理员", provider: "development", authenticated: true, isGatewayAdmin: true
  };
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('owner', '管理员');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '本人', 'owner');
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member', 'owner', 'manager', 'owner');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('report', 'member', 'owner', 'pathology', '病理报告', 'needs_review');
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, pipeline_version, deduplication_key
      ) VALUES ('ai-rerun', 'report', 'ai_extract', 'processing', 'test', 'ai-rerun');
      INSERT INTO report_structured_sections (
        id, report_id, section_key, section_title, content_text, evidence_json
      ) VALUES
        ('section-edit', 'report', 'pathology_immunohistochemistry', '免疫组化', 'Ki-67约5%',
         '[{"pageNumber":2,"quote":"免疫组化：Ki-67约5%"}]'),
        ('section-delete', 'report', 'pathology_gross_findings', '肉眼所见', '灰白组织一块',
         '[{"pageNumber":1,"quote":"肉眼所见：灰白组织一块"}]');
    `);

    updateReportStructuredSection(owner, "section-edit", {
      title: "免疫组化结果",
      content: "Ki-67 阳性细胞约 5%"
    });
    deleteReportStructuredSection(owner, "section-delete");
    createReportStructuredSection(owner, "report", {
      sectionKey: "pathology_stage",
      title: "病理分期",
      content: "人工录入：原报告未明确分期"
    });

    const normalized = normalizeAiExtraction({
      reportType: "pathology",
      reportSections: [
        {
          sectionKey: "pathology_immunohistochemistry",
          title: "免疫组化",
          content: "Ki-67约5%",
          p: 2,
          q: "免疫组化：Ki-67约5%"
        },
        {
          sectionKey: "pathology_gross_findings",
          title: "肉眼所见",
          content: "灰白组织一块",
          p: 1,
          q: "肉眼所见：灰白组织一块"
        },
        {
          sectionKey: "pathology_microscopic_findings",
          title: "镜下所见",
          content: "腺体排列密集",
          p: 3,
          q: "镜下所见：腺体排列密集"
        }
      ]
    });
    persistAiExtraction("report", "ai-rerun", {
      provider: "test",
      model: "test",
      promptVersion: "test",
      ...normalized,
      rawResponseJson: "{}",
      promptTokens: 10,
      completionTokens: 5,
      elapsedMs: 1
    }, 100);

    const detail = getReportDetail(owner, "report");
    assert.deepEqual(
      detail.structuredSections.map((section) => [section.sectionKey, section.title, section.content]),
      [
        ["pathology_microscopic_findings", "镜下所见", "腺体排列密集"],
        ["pathology_immunohistochemistry", "免疫组化结果", "Ki-67 阳性细胞约 5%"],
        ["pathology_stage", "病理分期", "人工录入：原报告未明确分期"]
      ]
    );
    assert.equal(detail.structuredSections.find((section) =>
      section.sectionKey === "pathology_immunohistochemistry")?.source, "manual");
    const deleted = db.prepare(`
      SELECT is_deleted AS isDeleted, source FROM report_structured_sections WHERE id = 'section-delete'
    `).get() as { isDeleted: number; source: string };
    assert.deepEqual({ ...deleted }, { isDeleted: 1, source: "manual" });
    const audits = db.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs WHERE target_type = 'report_structured_section'
    `).get() as { count: number };
    assert.equal(audits.count, 3);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
