export type ReportStatus =
  | "uploading"
  | "queued"
  | "processing"
  | "needs_review"
  | "ready"
  | "failed"
  | "trashed";

export type ReportType =
  | "checkup"
  | "laboratory"
  | "imaging"
  | "functional"
  | "pathology"
  | "outpatient"
  | "inpatient"
  | "prescription"
  | "billing"
  | "vaccination"
  | "other";

export type MemberPermission = "viewer" | "manager";

export type EvidenceRef = {
  pageId: string;
  lineIds: string[];
  sourceText: string;
  confidence: number | null;
};

export type Observation = {
  id: string;
  reportId: string;
  sectionName: string | null;
  itemCode: string | null;
  itemName: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceText: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  evidence: EvidenceRef | null;
  canonicalName: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  canonicalExplanation: string | null;
  normalizationQuality: "high" | "medium" | "low" | "excluded" | null;
  normalizationConfidence: number | null;
  normalizationReason: string | null;
  normalizationExcludedReason: string | null;
};

export type MorphologyMeasurement = {
  key: string;
  value: number;
  unit: string | null;
};

export type MorphologyFinding = {
  id: string;
  reportId: string;
  examDate: string | null;
  sectionName: string | null;
  organ: string | null;
  region: string | null;
  laterality: "left" | "right" | "bilateral" | "midline" | "unspecified";
  findingType: string;
  findingName: string;
  presence: "present" | "absent" | "uncertain";
  findingCount: number | null;
  size: {
    length: number | null;
    width: number | null;
    height: number | null;
    unit: string | null;
  };
  measurements: MorphologyMeasurement[];
  morphology: string | null;
  attributes: Record<string, string>;
  classification: {
    system: string | null;
    value: string | null;
    text: string | null;
  } | null;
  comparisonText: string | null;
  rawText: string;
  evidence: Array<{ pageNumber: number; quote: string }>;
  confidence: number | null;
  trackingGroupId: string | null;
  matchConfidence: number | null;
  source: "ai" | "manual" | "legacy_migration";
  manualFields: string[];
};

export type ClinicalEvidence = Array<{ pageNumber: number; quote: string }>;
export type ClinicalFactSource = "ai" | "manual" | "legacy_migration";

export type ReportDiagnosis = {
  id: string;
  reportId: string;
  sectionName: string | null;
  diagnosisType: "outpatient" | "admission" | "discharge" | "pathology" | "other";
  diagnosisText: string;
  diagnosisCode: string | null;
  codeSystem: string | null;
  isPrimary: boolean;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type ReportMedication = {
  id: string;
  reportId: string;
  sectionName: string | null;
  context: "prescription" | "outpatient" | "inpatient" | "discharge" | "other";
  medicationName: string;
  genericName: string | null;
  specification: string | null;
  dosageForm: string | null;
  dose: string | null;
  doseUnit: string | null;
  frequency: string | null;
  route: string | null;
  duration: string | null;
  quantity: string | null;
  quantityUnit: string | null;
  instructions: string | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type ReportProcedure = {
  id: string;
  reportId: string;
  sectionName: string | null;
  procedureType: "examination" | "treatment" | "surgery" | "other";
  procedureName: string;
  procedureCode: string | null;
  bodyPart: string | null;
  performedAt: string | null;
  resultText: string | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type VaccinationRecord = {
  id: string;
  reportId: string;
  vaccineName: string;
  doseNumber: string | null;
  manufacturer: string | null;
  lotNumber: string | null;
  administeredAt: string | null;
  administrationSite: string | null;
  nextDueAt: string | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type BillingSummary = {
  id: string;
  reportId: string;
  invoiceNumber: string | null;
  totalAmount: number | null;
  insuranceAmount: number | null;
  selfPayAmount: number | null;
  currency: string;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type BillingItem = {
  id: string;
  reportId: string;
  category: string | null;
  itemName: string;
  amount: number | null;
  quantity: number | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export const reportStructuredSectionKeys = [
  "checkup_package",
  "checkup_positive_findings",
  "checkup_abnormal_summary",
  "checkup_final_conclusion",
  "checkup_original_recommendation",
  "laboratory_specimen",
  "laboratory_method",
  "imaging_modality",
  "imaging_contrast",
  "functional_method",
  "functional_description",
  "pathology_specimen",
  "pathology_gross_findings",
  "pathology_microscopic_findings",
  "pathology_immunohistochemistry",
  "pathology_grade",
  "pathology_stage",
  "outpatient_history",
  "outpatient_physical_examination",
  "outpatient_disposition",
  "outpatient_advice",
  "inpatient_course",
  "inpatient_discharge_instructions"
] as const;

export type ReportStructuredSectionKey = typeof reportStructuredSectionKeys[number];

/**
 * These section families describe the document itself, not any matching words
 * inside a composite report. A checkup table row named "体格检查" must not turn
 * into an outpatient-record section merely because the label is the same.
 */
export function isAiReportStructuredSectionCompatible(
  reportType: string | null | undefined,
  sectionKey: ReportStructuredSectionKey
) {
  if (sectionKey.startsWith("checkup_")) return reportType === "checkup";
  if (sectionKey.startsWith("outpatient_")) return reportType === "outpatient";
  if (sectionKey.startsWith("inpatient_")) return reportType === "inpatient";
  return true;
}

export type ReportStructuredSection = {
  id: string;
  reportId: string;
  sectionKey: ReportStructuredSectionKey;
  title: string;
  content: string;
  contentData: Record<string, unknown> | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type ReportPage = {
  id: string;
  reportId: string;
  pageNumber: number;
  originalName: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  rotation: number;
  sourcePageNumber: number | null;
  sourcePageCount: number | null;
  hasThumbnail: boolean;
};

export type ReportSummary = {
  id: string;
  memberId: string;
  title: string;
  reportType: ReportType;
  status: ReportStatus;
  hospitalName: string | null;
  hospitalBranch: string | null;
  departmentName: string | null;
  bodyPart: string | null;
  reportIssuedAt: string | null;
  abnormalCount: number;
  pageCount: number;
};

export type DuplicateReportCandidate = ReportSummary & {
  confidence: "high" | "medium";
  matchedFields: string[];
  reason: string;
};

export type DuplicateReportGroup = {
  report: ReportSummary;
  candidates: DuplicateReportCandidate[];
};

export type ReportDetail = ReportSummary & {
  hospitalBranch: string | null;
  city: string | null;
  visitType: string | null;
  visitDepartment: string | null;
  orderingDepartment: string | null;
  performingDepartment: string | null;
  reportingDepartment: string | null;
  inpatientWard: string | null;
  bodyParts: Array<{ raw: string; name: string; parent: string | null; laterality: string }>;
  identifiers: Record<string, string>;
  examinedAt: string | null;
  orderedAt: string | null;
  sampledAt: string | null;
  receivedAt: string | null;
  reviewedAt: string | null;
  admittedAt: string | null;
  dischargedAt: string | null;
  clinicians: Record<string, string>;
  clinicalDiagnosis: string | null;
  purpose: string | null;
  chiefComplaint: string | null;
  summary: string | null;
  findings: string | null;
  impression: string | null;
  recommendation: string | null;
  pages: ReportPage[];
  observations: Observation[];
  morphologyFindings: MorphologyFinding[];
  diagnoses: ReportDiagnosis[];
  medications: ReportMedication[];
  procedures: ReportProcedure[];
  vaccinations: VaccinationRecord[];
  billingSummary: BillingSummary | null;
  billingItems: BillingItem[];
  structuredSections: ReportStructuredSection[];
  duplicateCandidates: DuplicateReportCandidate[];
  manualFieldKeys: string[];
};

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};
