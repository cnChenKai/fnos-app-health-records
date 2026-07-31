import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  createClinicalFact,
  deleteClinicalFact,
  updateClinicalFact
} from "../services/clinical-fact.service.ts";
import { getReportDetail } from "../services/records.service.ts";
import { normalizeAiExtraction, persistAiExtraction } from "../services/ai-extraction.service.ts";

test("keeps manually edited and deleted clinical facts protected across AI reruns", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-clinical-facts-"));
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
      VALUES ('report', 'member', 'owner', 'inpatient', '出院记录', 'needs_review');
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, pipeline_version, deduplication_key
      ) VALUES ('ai-rerun', 'report', 'ai_extract', 'processing', 'test', 'ai-rerun');
      INSERT INTO report_diagnoses (
        id, report_id, diagnosis_type, diagnosis_text, evidence_json
      ) VALUES (
        'diagnosis-ai', 'report', 'discharge', '肺部感染',
        '[{"pageNumber":1,"quote":"出院诊断：肺部感染"}]'
      );
      INSERT INTO report_medications (
        id, report_id, medication_context, medication_name, evidence_json
      ) VALUES (
        'medication-ai', 'report', 'discharge', '阿莫西林胶囊',
        '[{"pageNumber":1,"quote":"出院用药：阿莫西林胶囊"}]'
      );
    `);

    updateClinicalFact(owner, "diagnosis", "diagnosis-ai", {
      diagnosisText: "社区获得性肺炎"
    });
    deleteClinicalFact(owner, "medication", "medication-ai");
    createClinicalFact(owner, "report", "procedure", {
      procedureType: "treatment",
      procedureName: "雾化吸入治疗"
    });
    createClinicalFact(owner, "report", "billingSummary", {
      invoiceNumber: "INV-001",
      totalAmount: 128,
      insuranceAmount: 80,
      selfPayAmount: 48,
      currency: "CNY"
    });

    const normalized = normalizeAiExtraction({
      reportType: "inpatient",
      diagnoses: [{
        diagnosisType: "discharge",
        diagnosisText: "肺部感染",
        p: 1,
        q: "出院诊断：肺部感染"
      }],
      medications: [{
        context: "discharge",
        medicationName: "阿莫西林胶囊",
        p: 1,
        q: "出院用药：阿莫西林胶囊"
      }],
      procedures: [{
        procedureType: "treatment",
        procedureName: "雾化吸入治疗",
        p: 1,
        q: "住院期间予雾化吸入治疗"
      }],
      vaccinations: [{
        vaccineName: "流感疫苗",
        doseNumber: "第1剂",
        p: 1,
        q: "流感疫苗 第1剂"
      }],
      billingSummary: {
        invoiceNumber: "AI-INV",
        totalAmount: 999,
        currency: "CNY",
        p: 1,
        q: "费用合计 999元"
      }
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
    assert.deepEqual(detail.diagnoses.map((item) => item.diagnosisText), ["社区获得性肺炎"]);
    assert.equal(detail.diagnoses[0].source, "manual");
    assert.deepEqual(detail.diagnoses[0].manualFields, ["*"]);
    assert.equal(detail.medications.length, 0);
    assert.deepEqual(detail.procedures.map((item) => item.procedureName), ["雾化吸入治疗"]);
    assert.deepEqual(detail.vaccinations.map((item) => item.vaccineName), ["流感疫苗"]);
    assert.equal(detail.billingSummary?.invoiceNumber, "INV-001");
    assert.equal(detail.billingSummary?.totalAmount, 128);
    const deleted = db.prepare(`
      SELECT is_deleted AS isDeleted, source, manual_fields_json AS manualFieldsJson
      FROM report_medications WHERE id = 'medication-ai'
    `).get() as { isDeleted: number; source: string; manualFieldsJson: string };
    assert.deepEqual({ ...deleted }, {
      isDeleted: 1,
      source: "manual",
      manualFieldsJson: '["*","deleted"]'
    });
    const audits = db.prepare(`
      SELECT action FROM audit_logs WHERE target_type = 'clinical_fact' ORDER BY created_at, id
    `).all() as Array<{ action: string }>;
    assert.deepEqual(new Set(audits.map((item) => item.action)), new Set([
      "clinical_fact.update", "clinical_fact.delete", "clinical_fact.create"
    ]));
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
