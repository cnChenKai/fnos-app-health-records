export type ApiResponse<T> = { ok: boolean; data: T; statusMessage?: string; error?: { message?: string } };

export type Session = {
  id: string;
  displayName: string;
  provider: "fnos_gateway" | "local" | "development";
  authenticated: boolean;
  isGatewayAdmin: boolean;
};

export type HealthMember = {
  id: string;
  displayName: string;
  relationship: string;
  birthDate: string | null;
  sex: string | null;
  avatarPath: string | null;
  permission: "viewer" | "manager";
};

export type BackupSummary = {
  id: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
  appVersion: string;
  schemaVersion: number;
  reportCount: number;
  memberCount: number;
  includes: string[];
  reason: "manual" | "pre_restore";
  fileCount?: number;
};

export type BackupValidationResult = {
  valid: boolean;
  checksumAvailable: boolean;
  fileCount: number;
  checkedCount: number;
  missingFiles: string[];
  mismatchedFiles: Array<{
    path: string;
    expectedSha256?: string;
    actualSha256?: string;
    expectedSizeBytes?: number;
    actualSizeBytes?: number;
  }>;
  extraFiles: string[];
  warnings: string[];
  errors: string[];
  manifest: {
    id: string | null;
    appName: string | null;
    appTitle: string | null;
    appVersion: string | null;
    schemaVersion: number | null;
    createdAt: string | null;
    reason: string | null;
    reportCount: number | null;
    memberCount: number | null;
  } | null;
};

export type AccessUser = {
  id: string;
  displayName: string;
  isAdmin: number;
  providers: string | null;
};

export type MemberAccess = {
  userId: string;
  displayName: string;
  permission: "viewer" | "manager";
  providers: string | null;
};

export type ReportSummary = {
  id: string;
  memberId: string;
  title: string;
  reportType: string;
  status: string;
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

export type ReportSummaryStats = {
  totalReports: number;
  readyReports: number;
  needsReviewReports: number;
  processingReports: number;
  failedReports: number;
  totalPages: number;
  observationCount: number;
  abnormalObservationCount: number;
  latestReportIssuedAt: string | null;
};

export type OverviewSummary = {
  stats: ReportSummaryStats;
  pendingReminders: Reminder[];
  recentReadyReports: ReportSummary[];
  unfiledReports: ReportSummary[];
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
  hasThumbnail: boolean | number;
};

export type ProcessingJob = {
  id: string;
  pageId: string | null;
  pageNumber: number | null;
  originalName: string | null;
  jobType: "pdf_extract" | "thumbnail" | "ocr" | "ai_extract";
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  ocrEngine: string | null;
  ocrModelVersion: string | null;
  ocrElapsedMs: number | null;
  aiProvider: string | null;
  aiModel: string | null;
  aiElapsedMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
};

export type ProcessingJobEvent = {
  id: string;
  jobId: string;
  reportId: string;
  eventType: "queued" | "started" | "completed" | "retry_scheduled" | "failed" | "manual_retry" | "cancelled";
  status: string;
  attempt: number;
  message: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type OcrPageText = {
  pageId: string;
  pageNumber: number;
  originalName: string;
  engine: string | null;
  modelVersion: string | null;
  elapsedMs: number | null;
  qualityScore: number | null;
  qualityLevel: "good" | "weak" | "poor" | null;
  qualityReason: string | null;
  lineCount: number;
  text: string;
};

export type Observation = {
  id: string;
  reportId: string;
  sectionName: string | null;
  itemCode?: string | null;
  itemName: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceText: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  canonicalName: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  canonicalExplanation: string | null;
  normalizationQuality: "high" | "medium" | "low" | "excluded" | null;
  normalizationConfidence: number | null;
  normalizationReason: string | null;
  normalizationExcludedReason: string | null;
};

export type TrendExcludedPoint = {
  observationId: string;
  reportId: string;
  reportTitle: string;
  reportIssuedAt: string | null;
  hospitalName: string | null;
  itemName: string;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  reason: string;
  quality: "low" | "excluded";
  evidenceQuote: string | null;
  sourcePage: {
    id: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  } | null;
};

export type TrendPoint = {
  observationId: string;
  reportId: string;
  reportTitle: string;
  reportStatus: string;
  reportIssuedAt: string | null;
  hospitalName: string | null;
  itemName: string;
  resultText: string;
  numericValue: number;
  referenceText: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  evidenceQuote: string | null;
  normalizationQuality: "high" | "medium" | "low" | "excluded" | null;
  normalizationConfidence: number | null;
  normalizationReason: string | null;
  sourcePage: {
    id: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  } | null;
};

export type TrendSeries = {
  name: string;
  unit: string | null;
  sectionName: string | null;
  quality: "high" | "medium" | "low" | "excluded" | "raw";
  confidence: number | null;
  explanation: string | null;
  matchReasons: string[];
  sourceNames: string[];
  excludedPoints: TrendExcludedPoint[];
  pointCount: number;
  firstDate: string | null;
  lastDate: string | null;
  latestValue: number | null;
  previousValue: number | null;
  delta: number | null;
  minValue: number | null;
  maxValue: number | null;
  points: TrendPoint[];
};

export type IndicatorNormalizationIssue = {
  rawName: string;
  normalizedName: string | null;
  unit: string | null;
  sectionName: string | null;
  hospitalName: string | null;
  status: "unknown" | "low" | "excluded";
  reason: string;
  count: number;
  latestReportIssuedAt: string | null;
};

export type ReportDetail = ReportSummary & {
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

export type CursorPage<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };

export type Reminder = {
  id: string;
  memberId: string;
  reportId: string | null;
  title: string;
  dueAt: string;
  status: "pending" | "completed" | "dismissed";
  source: "manual" | "report_suggestion";
  reportTitle: string | null;
  reportHospitalName: string | null;
  reportIssuedAt: string | null;
};

export type AppNotification = {
  id: string;
  memberId: string;
  reportId: string | null;
  type: "report_processed" | "report_failed";
  title: string;
  message: string | null;
  severity: "info" | "success" | "warning" | "error";
  status: "unread" | "read" | "archived";
  createdAt: string;
  readAt: string | null;
  reportTitle: string | null;
};

export type AuditLog = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  actorName: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type UserOperationAuditLog = {
  id: string;
  action: string;
  title: string;
  description: string;
  targetLabel: string;
  targetId: string | null;
  targetName: string | null;
  actorName: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
};

export type AiAuditSummary = {
  summary: {
    jobCount: number;
    callCount: number;
    successJobs: number;
    failedJobs: number;
    queuedJobs: number;
    processingJobs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    avgElapsedMs: number;
  };
  recent: Array<{
    id: string;
    source: "report_extraction" | "indicator_normalization" | string;
    reportId: string | null;
    reportTitle: string;
    memberId: string | null;
    status: string;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    provider: string | null;
    model: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    elapsedMs: number | null;
    inputCharacters: number | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
};
