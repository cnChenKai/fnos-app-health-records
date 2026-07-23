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
  duplicateCandidates: DuplicateReportCandidate[];
};

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};
