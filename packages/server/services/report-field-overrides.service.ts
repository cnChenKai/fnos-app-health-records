import { getDatabase } from "../database/client";
import { createId } from "../utils/identifier";

export type ReportFieldKey =
  | "title"
  | "reportType"
  | "reportSubtype"
  | "hospitalName"
  | "hospitalBranch"
  | "city"
  | "visitType"
  | "departmentName"
  | "orderingDepartment"
  | "performingDepartment"
  | "reportingDepartment"
  | "inpatientWard"
  | "bodyParts"
  | "identifiers"
  | "reportIssuedAt"
  | "examinedAt"
  | "orderedAt"
  | "sampledAt"
  | "receivedAt"
  | "reviewedAt"
  | "admittedAt"
  | "dischargedAt"
  | "clinicians"
  | "clinicalDiagnosis"
  | "purpose"
  | "chiefComplaint"
  | "findings"
  | "impression"
  | "summary"
  | "recommendation";

export type ReportFieldDefinition = {
  key: ReportFieldKey;
  column: string;
  resetValue: string | null;
};

export const reportFieldDefinitions: ReportFieldDefinition[] = [
  { key: "title", column: "title", resetValue: "待识别报告" },
  { key: "reportType", column: "report_type", resetValue: "other" },
  { key: "reportSubtype", column: "report_subtype", resetValue: null },
  { key: "hospitalName", column: "hospital_name_raw", resetValue: null },
  { key: "hospitalBranch", column: "hospital_branch", resetValue: null },
  { key: "city", column: "city", resetValue: null },
  { key: "visitType", column: "visit_type", resetValue: null },
  { key: "departmentName", column: "visit_department", resetValue: null },
  { key: "orderingDepartment", column: "ordering_department", resetValue: null },
  { key: "performingDepartment", column: "performing_department", resetValue: null },
  { key: "reportingDepartment", column: "reporting_department", resetValue: null },
  { key: "inpatientWard", column: "inpatient_ward", resetValue: null },
  { key: "bodyParts", column: "body_parts_json", resetValue: "[]" },
  { key: "identifiers", column: "identifiers_json", resetValue: "{}" },
  { key: "reportIssuedAt", column: "report_issued_at", resetValue: null },
  { key: "examinedAt", column: "examined_at", resetValue: null },
  { key: "orderedAt", column: "ordered_at", resetValue: null },
  { key: "sampledAt", column: "sampled_at", resetValue: null },
  { key: "receivedAt", column: "received_at", resetValue: null },
  { key: "reviewedAt", column: "reviewed_at", resetValue: null },
  { key: "admittedAt", column: "admitted_at", resetValue: null },
  { key: "dischargedAt", column: "discharged_at", resetValue: null },
  { key: "clinicians", column: "clinicians_json", resetValue: "{}" },
  { key: "clinicalDiagnosis", column: "clinical_diagnosis", resetValue: null },
  { key: "purpose", column: "purpose", resetValue: null },
  { key: "chiefComplaint", column: "chief_complaint", resetValue: null },
  { key: "findings", column: "findings", resetValue: null },
  { key: "impression", column: "impression", resetValue: null },
  { key: "summary", column: "summary", resetValue: null },
  { key: "recommendation", column: "recommendation", resetValue: null }
];

export const reportFieldByKey = new Map(reportFieldDefinitions.map((definition) => [definition.key, definition]));
export const reportFieldKeyByColumn = new Map(reportFieldDefinitions.map((definition) => [definition.column, definition.key]));

export function listManualReportFieldKeys(reportId: string) {
  const rows = getDatabase().prepare("SELECT field_key AS fieldKey FROM report_field_overrides WHERE report_id = ?")
    .all(reportId) as Array<{ fieldKey: ReportFieldKey }>;
  return new Set(rows.map((row) => row.fieldKey));
}

export function listManualReportFieldOverrides(reportId: string) {
  return getDatabase().prepare(`
    SELECT field_key AS fieldKey, value_json AS valueJson, updated_by AS updatedBy, updated_at AS updatedAt
    FROM report_field_overrides
    WHERE report_id = ?
    ORDER BY updated_at DESC, field_key
  `).all(reportId).map((row) => {
    const item = row as { fieldKey: ReportFieldKey; valueJson: string; updatedBy: string | null; updatedAt: string };
    let value: unknown = null;
    try { value = JSON.parse(item.valueJson); } catch { value = null; }
    return { fieldKey: item.fieldKey, value, updatedBy: item.updatedBy, updatedAt: item.updatedAt };
  });
}

export function upsertManualReportFieldOverrides(input: {
  reportId: string;
  userId: string;
  fields: Array<{ fieldKey: ReportFieldKey; value: unknown }>;
}) {
  if (!input.fields.length) return 0;
  const statement = getDatabase().prepare(`
    INSERT INTO report_field_overrides (id, report_id, field_key, value_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(report_id, field_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `);
  let changed = 0;
  for (const field of input.fields) {
    if (!reportFieldByKey.has(field.fieldKey)) continue;
    const result = statement.run(
      createId("override"),
      input.reportId,
      field.fieldKey,
      JSON.stringify(field.value ?? null),
      input.userId
    );
    changed += Number(result.changes || 0);
  }
  return changed;
}
