import { checkpointDatabase, closeDatabase, getDatabase, getDatabasePath, getDatabaseStatus } from "../database/client";
import { createError } from "h3";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { RequestUser } from "../domain/request-user";
import type {
  CursorPage,
  DuplicateReportCandidate,
  DuplicateReportGroup,
  BillingItem,
  BillingSummary,
  MorphologyFinding,
  Observation,
  ReportDiagnosis,
  ReportDetail,
  ReportMedication,
  ReportPage,
  ReportProcedure,
  ReportStructuredSection,
  ReportSummary,
  VaccinationRecord
} from "../domain/health-record";
import { isAiReportStructuredSectionCompatible } from "../domain/health-record";
import { getAppConfig } from "../utils/runtime-config";
import { createId } from "../utils/identifier";
import { schemaVersion } from "../database/schema";
import { assertMemberAccess, assertMemberManage } from "./member.service";
import { requestWorker } from "./ocr-worker-client";
import { isGenericReportTitle } from "./ai-extraction.service";
import { trendPlacementFor, type TrendPlacement } from "../domain/indicator-dictionary/trend-taxonomy";
import { convertUnit, ensureBuiltinIndicatorCatalog } from "./indicator-normalization.service";
import { getJobRunnerStatus, isReportJobActive, startJobRunner, stopJobRunner } from "./job-runner.service";
import { enqueueFileGarbage } from "./file-gc.service";
import { rebindRestoredGatewayAdministrator } from "./restore-identity.service";
import {
  listManualReportFieldKeys,
  reportFieldDefinitions,
  upsertManualReportFieldOverrides,
  type ReportFieldKey
} from "./report-field-overrides.service";
import { findLocalDuplicateEvidence } from "./report-duplicate-precheck.service";
import { reportStructuredSectionLabels } from "./report-structured-section.service";

type ReportCursor = { issuedAt: string | null; id: string };
export type ReportFilters = {
  memberId?: string;
  cursor?: string;
  query?: string;
  reportType?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  ocrQuery?: string;
  trash?: boolean;
};

const displayDepartmentSql = `
  COALESCE(
    r.performing_department,
    r.visit_department,
    r.reporting_department,
    r.ordering_department,
    CASE WHEN r.report_type = 'checkup' THEN '综合体检' END
  )
`;

function decodeCursor(value?: string): ReportCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator < 0) return null;
    const issuedAt = decoded.slice(0, separator) || null;
    const id = decoded.slice(separator + 1);
    return id ? { issuedAt, id } : null;
  } catch {
    return null;
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function storagePath(relativePath: string) {
  const root = resolve(getAppConfig().storageDir);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw createError({ statusCode: 400, statusMessage: "文件路径无效" });
  }
  return target;
}

function redactSensitiveText(value: string) {
  if (/(身份证|证件号码|联系电话|手机号码|手机号|家庭住址|通讯地址|现住址)/i.test(value)) return "";
  return value
    .replace(/(^|\D)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)/g, "$1[已过滤身份证号]")
    .replace(/(^|\D)1[3-9]\d{9}(?!\d)/g, "$1[已过滤手机号]");
}

function normalizeContentKey(value: string | null | undefined) {
  return (value || "")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, "")
    .replace(/[（）()[\]【】{}<>《》:：,，.。;；、/\\|_-]/g, "")
    .trim();
}

function hospitalNamesEquivalent(current: string | null | undefined, candidate: string | null | undefined) {
  const left = normalizeContentKey(current);
  const right = normalizeContentKey(candidate);
  if (!left || !right) return false;
  if (left === right) return true;

  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  /* 仅识别“地区/院区前缀 + 完整机构名”这类保守包含关系。
     短品牌名或“人民医院”等泛称不能单独作为同一机构依据。 */
  return shorter.length >= 6
    && shorter.length / longer.length >= 0.55
    && longer.includes(shorter);
}

function datePart(value: string | null | undefined) {
  return (value || "").slice(0, 10);
}

function firstBodyPart(value: string | null | undefined) {
  const parts = parseJson<Array<{ name?: string; raw?: string }>>(value, []);
  return parts[0]?.name || parts[0]?.raw || null;
}

function sharedIdentifierMatches(
  current: Record<string, string>,
  candidate: Record<string, string>
) {
  return Object.entries(current)
    .filter(([, value]) => normalizeContentKey(value).length >= 3)
    .flatMap(([key, value]) => {
      const candidateValue = candidate[key];
      if (!candidateValue) return [];
      return normalizeContentKey(value) === normalizeContentKey(candidateValue) ? [key] : [];
    });
}

function textSimilarityMatched(current: string | null | undefined, candidate: string | null | undefined) {
  const left = normalizeContentKey(current);
  const right = normalizeContentKey(candidate);
  if (left.length < 12 || right.length < 12) return false;
  return left === right || left.includes(right.slice(0, Math.min(40, right.length))) || right.includes(left.slice(0, Math.min(40, left.length)));
}

function isInformativeDuplicateTitle(value: string | null | undefined) {
  const title = (value || "").trim();
  const normalized = normalizeContentKey(title);
  if (normalized.length < 6) return false;
  if (["待识别报告", "报告", "检查报告", "检查报告单", "检验报告", "检验报告单", "体检报告", "体检报告单"].includes(title)) return false;
  return !isGenericReportTitle(title);
}

function titleSimilarityMatched(current: string | null | undefined, candidate: string | null | undefined) {
  if (!isInformativeDuplicateTitle(current) || !isInformativeDuplicateTitle(candidate)) return false;
  const left = normalizeContentKey(current);
  const right = normalizeContentKey(candidate);
  if (left === right) return true;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return shorter.length >= 8 && longer.includes(shorter);
}

function reportFileSignature(reportId: string) {
  const pages = getDatabase().prepare(`
    SELECT sha256, source_page_number AS sourcePageNumber, source_page_count AS sourcePageCount
    FROM report_pages
    WHERE report_id = ?
    ORDER BY page_number, id
  `).all(reportId) as Array<{
    sha256: string;
    sourcePageNumber: number | null;
    sourcePageCount: number | null;
  }>;
  if (!pages.length || pages.some((page) => !page.sha256)) return null;
  return pages
    .map((page) => `${page.sha256}:${page.sourcePageNumber || 0}:${page.sourcePageCount || 0}`)
    .sort()
    .join("|");
}

function observationSignature(reportId: string) {
  return new Set(getDatabase().prepare(`
    SELECT
      CASE
        WHEN n.quality IN ('high', 'medium') AND n.canonical_key IS NOT NULL THEN n.canonical_key
        ELSE COALESCE(NULLIF(TRIM(o.normalized_name), ''), o.item_name)
      END AS name,
      o.result_text AS resultText,
      CASE
        WHEN n.quality IN ('high', 'medium') THEN COALESCE(n.canonical_value, o.numeric_value)
        ELSE o.numeric_value
      END AS numericValue
    FROM observations o
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE o.report_id = ?
    ORDER BY o.section_name, o.item_name, o.id
    LIMIT 200
  `).all(reportId).flatMap((row) => {
    const item = row as { name: string; resultText: string; numericValue: number | null };
    const name = normalizeContentKey(item.name);
    const parsedNumber = item.numericValue ?? parseNumericResultText(item.resultText);
    const result = parsedNumber === null ? normalizeContentKey(item.resultText) : String(parsedNumber);
    if (!name || !result) return [];
    return [`${name}:${result}`];
  }));
}

function sharedObservationStats(currentReportId: string, candidateReportId: string) {
  const current = observationSignature(currentReportId);
  if (!current.size) {
    return { shared: 0, currentSize: 0, candidateSize: 0, overlapRatio: 0, largerOverlapRatio: 0 };
  }
  const candidate = observationSignature(candidateReportId);
  let count = 0;
  for (const item of candidate) {
    if (current.has(item)) count += 1;
  }
  return {
    shared: count,
    currentSize: current.size,
    candidateSize: candidate.size,
    overlapRatio: count / Math.max(1, Math.min(current.size, candidate.size)),
    largerOverlapRatio: count / Math.max(1, Math.max(current.size, candidate.size))
  };
}

function hasStrongObservationOverlap(stats: ReturnType<typeof sharedObservationStats>) {
  if (stats.shared >= 10) return true;
  if (stats.shared >= 6 && stats.overlapRatio >= 0.75 && stats.largerOverlapRatio >= 0.3) return true;
  return stats.shared >= 3 && stats.overlapRatio >= 0.9 && stats.largerOverlapRatio >= 0.5;
}

type DuplicateSourceRow = ReportSummary & {
  city: string | null;
  visitType: string | null;
  orderingDepartment: string | null;
  performingDepartment: string | null;
  reportingDepartment: string | null;
  bodyPartsJson: string;
  identifiersJson: string;
  examinedAt: string | null;
  sampledAt: string | null;
  receivedAt: string | null;
  reviewedAt: string | null;
  findings: string | null;
  impression: string | null;
  summary: string | null;
};

function findDuplicateCandidates(current: DuplicateSourceRow): DuplicateReportCandidate[] {
  const currentIdentifiers = parseJson<Record<string, string>>(current.identifiersJson, {});
  const currentHospital = normalizeContentKey(current.hospitalName);
  const currentBranch = normalizeContentKey(current.hospitalBranch);
  const currentDate = datePart(current.reportIssuedAt || current.examinedAt || current.sampledAt || current.receivedAt || current.reviewedAt);
  const currentDepartment = normalizeContentKey(
    current.performingDepartment || current.departmentName || current.reportingDepartment || current.orderingDepartment
  );
  const currentBodyPart = normalizeContentKey(current.bodyPart || firstBodyPart(current.bodyPartsJson));
  const currentFileSignature = reportFileSignature(current.id);
  const localEvidence = new Map(
    findLocalDuplicateEvidence(current.id).map((candidate) => [candidate.reportId, candidate])
  );

  if (
    !currentFileSignature
    && !currentHospital
    && !currentDate
    && !Object.keys(currentIdentifiers).length
    && !localEvidence.size
  ) return [];

  const rows = getDatabase().prepare(`
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch,
      ${displayDepartmentSql} AS departmentName,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      r.report_issued_at AS reportIssuedAt,
      (SELECT COUNT(*) FROM observations o WHERE o.report_id = r.id AND o.abnormal_flag IN ('high', 'low', 'abnormal')) AS abnormalCount,
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount,
      r.city, r.visit_type AS visitType, r.ordering_department AS orderingDepartment,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment,
      r.body_parts_json AS bodyPartsJson, r.identifiers_json AS identifiersJson,
      r.examined_at AS examinedAt, r.sampled_at AS sampledAt, r.received_at AS receivedAt,
      r.reviewed_at AS reviewedAt, r.findings, r.impression, r.summary
    FROM reports r
    WHERE r.member_id = ? AND r.id <> ? AND r.status <> 'trashed'
      AND (r.status IN ('needs_review', 'ready') OR r.report_issued_at IS NOT NULL OR r.identifiers_json <> '{}')
    ORDER BY r.updated_at DESC
    LIMIT 80
  `).all(current.memberId, current.id) as DuplicateSourceRow[];

  const candidates: DuplicateReportCandidate[] = [];
  for (const candidate of rows) {
    const candidateIdentifiers = parseJson<Record<string, string>>(candidate.identifiersJson, {});
    const identifierMatches = sharedIdentifierMatches(currentIdentifiers, candidateIdentifiers);
    const candidateHospital = normalizeContentKey(candidate.hospitalName);
    const candidateBranch = normalizeContentKey(candidate.hospitalBranch);
    const candidateDate = datePart(candidate.reportIssuedAt || candidate.examinedAt || candidate.sampledAt || candidate.receivedAt || candidate.reviewedAt);
    const candidateDepartment = normalizeContentKey(
      candidate.performingDepartment || candidate.departmentName || candidate.reportingDepartment || candidate.orderingDepartment
    );
    const candidateBodyPart = normalizeContentKey(candidate.bodyPart || firstBodyPart(candidate.bodyPartsJson));
    const matchedFields: string[] = [];

    const hasSameOriginal = Boolean(
      currentFileSignature && currentFileSignature === reportFileSignature(candidate.id)
    );
    if (hasSameOriginal) matchedFields.push("原始文件");
    if (titleSimilarityMatched(current.title, candidate.title)) matchedFields.push("标题");
    if (current.reportType === candidate.reportType) matchedFields.push("报告类型");
    const hasEquivalentHospital = hospitalNamesEquivalent(current.hospitalName, candidate.hospitalName);
    if (currentHospital && candidateHospital && currentHospital === candidateHospital) matchedFields.push("医院");
    else if (hasEquivalentHospital) matchedFields.push("医院名称近似");
    if (currentBranch && candidateBranch && currentBranch === candidateBranch) matchedFields.push("院区");
    if (currentDate && candidateDate && currentDate === candidateDate) matchedFields.push("报告/检查日期");
    if (currentDepartment && candidateDepartment && currentDepartment === candidateDepartment) matchedFields.push("科室");
    if (currentBodyPart && candidateBodyPart && currentBodyPart === candidateBodyPart) matchedFields.push("检查部位");
    if (textSimilarityMatched(current.impression, candidate.impression)) matchedFields.push("结论");
    else if (textSimilarityMatched(current.summary, candidate.summary)) matchedFields.push("摘要");
    else if (textSimilarityMatched(current.findings, candidate.findings)) matchedFields.push("检查所见");
    const observationStats = sharedObservationStats(current.id, candidate.id);
    const observationMatches = observationStats.shared;
    if (observationMatches > 0) matchedFields.push(`指标${observationMatches}项`);
    const localMatch = localEvidence.get(candidate.id);
    if (localMatch) matchedFields.push(...localMatch.matchedFields);

    if (hasSameOriginal) {
      candidates.push({
        ...candidate,
        confidence: "high" as const,
        matchedFields,
        reason: "上传原件内容完全一致"
      });
      continue;
    }
    const hasSameHospitalAndDate = hasEquivalentHospital && matchedFields.includes("报告/检查日期");
    const hasSameCore = matchedFields.includes("报告类型") && hasSameHospitalAndDate;
    if (identifierMatches.length && (hasSameHospitalAndDate || matchedFields.includes("报告类型"))) {
      candidates.push({
        ...candidate,
        confidence: "high" as const,
        matchedFields: [...new Set([...matchedFields, ...identifierMatches.map((key) => `编号:${key}`)])],
        reason: `医疗编号一致（${identifierMatches.join("、")}）`
      });
      continue;
    }
    if (localMatch) {
      candidates.push({
        ...candidate,
        confidence: localMatch.confidence,
        matchedFields: [...new Set(matchedFields)],
        reason: localMatch.reason
      });
      continue;
    }
    const hasStrongTextAnchor = matchedFields.some((field) => ["结论", "摘要", "检查所见"].includes(field));
    const hasStrongObservationAnchor = hasStrongObservationOverlap(observationStats);
    const hasTitleAndClinicalAnchor = matchedFields.includes("标题")
      && (matchedFields.includes("检查部位") || hasStrongObservationAnchor);
    const hasContentAnchor = hasStrongTextAnchor || hasStrongObservationAnchor || hasTitleAndClinicalAnchor;
    if (hasSameCore && hasContentAnchor) {
      candidates.push({
        ...candidate,
        confidence: "medium" as const,
        matchedFields,
        reason: hasStrongTextAnchor || hasStrongObservationAnchor
          ? `${matchedFields.includes("医院名称近似") ? "机构名称近似，" : ""}医院、日期、类型及核心报告内容一致`
          : `${matchedFields.includes("医院名称近似") ? "机构名称近似，" : ""}医院、日期、类型、标题及临床字段一致`
      });
    }
  }
  return candidates.slice(0, 5);
}

function duplicateSourceRowsForMember(user: RequestUser, memberId: string) {
  assertMemberAccess(user, memberId);
  return getDatabase().prepare(`
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch,
      ${displayDepartmentSql} AS departmentName,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      r.report_issued_at AS reportIssuedAt,
      (SELECT COUNT(*) FROM observations o WHERE o.report_id = r.id AND o.abnormal_flag IN ('high', 'low', 'abnormal')) AS abnormalCount,
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount,
      r.city, r.visit_type AS visitType, r.ordering_department AS orderingDepartment,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment,
      r.body_parts_json AS bodyPartsJson, r.identifiers_json AS identifiersJson,
      r.examined_at AS examinedAt, r.sampled_at AS sampledAt, r.received_at AS receivedAt,
      r.reviewed_at AS reviewedAt, r.findings, r.impression, r.summary
    FROM reports r
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE r.member_id = ? AND r.status <> 'trashed'
      AND (r.status IN ('needs_review', 'ready') OR r.report_issued_at IS NOT NULL OR r.identifiers_json <> '{}')
    ORDER BY r.report_issued_at DESC, r.updated_at DESC
    LIMIT 300
  `).all(user.id, memberId) as DuplicateSourceRow[];
}

const allowedReportTypes = new Set([
  "checkup", "laboratory", "imaging", "functional", "pathology", "outpatient",
  "inpatient", "prescription", "billing", "vaccination", "other"
]);
const allowedReportStatuses = new Set(["needs_review", "ready", "failed", "queued", "processing"]);
const pdfPreviewMaxSize = 2800;
const pdfPreviewQuality = 92;
const pdfPreviewRenderScale = 3;

function pdfPreviewRelativePath(reportId: string, pageId: string) {
  return join("previews", reportId, `${pageId}.jpg`);
}

function textInput(value: unknown, max = 500) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function dateInput(value: unknown) {
  const text = textInput(value, 24);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(text)) {
    throw createError({ statusCode: 400, statusMessage: "日期格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss" });
  }
  return text.replace("T", " ");
}

function reportPageRows(reportId: string) {
  return getDatabase().prepare(`
    SELECT id, storage_path AS storagePath, thumbnail_path AS thumbnailPath, page_number AS pageNumber
    FROM report_pages WHERE report_id = ? ORDER BY page_number
  `).all(reportId) as Array<{ id: string; storagePath: string; thumbnailPath: string | null; pageNumber: number }>;
}

export function listMembers(user: RequestUser) {
  if (!user.authenticated) return [];
  return getDatabase().prepare(`
    SELECT hm.id, hm.display_name AS displayName, hm.relationship, hm.birth_date AS birthDate,
      hm.sex, hm.avatar_path AS avatarPath, mp.permission
    FROM health_members hm
    JOIN member_permissions mp ON mp.member_id = hm.id AND mp.user_id = ?
    WHERE hm.deleted_at IS NULL
    ORDER BY CASE hm.relationship WHEN 'self' THEN 0 ELSE 1 END, hm.created_at
  `).all(user.id);
}

export function listReports(user: RequestUser, limit = 30, memberIdOrFilters?: string | ReportFilters, cursorValue?: string): CursorPage<ReportSummary> {
  if (!user.authenticated) return { items: [], nextCursor: null, hasMore: false };
  const filters: ReportFilters = typeof memberIdOrFilters === "object"
    ? memberIdOrFilters
    : { memberId: memberIdOrFilters, cursor: cursorValue };
  const memberId = filters.memberId;
  if (memberId) assertMemberAccess(user, memberId);
  const safeLimit = Math.min(50, Math.max(1, Math.round(limit)));
  const cursor = decodeCursor(filters.cursor);
  const cursorId = cursor?.id ?? null;
  const cursorIssuedAt = cursor?.issuedAt ?? null;

  const where = ["(? IS NULL OR r.member_id = ?)"];
  const params: Array<string | number | null> = [user.id, memberId || null, memberId || null];
  if (filters.trash) where.push("r.status = 'trashed'");
  else where.push("r.status <> 'trashed'");
  if (filters.status && filters.status !== "all") {
    if (filters.status === "unfiled") {
      where.push("r.status <> 'ready'");
    } else {
      where.push("r.status = ?");
      params.push(filters.status);
    }
  }
  if (filters.reportType && filters.reportType !== "all") {
    where.push("r.report_type = ?");
    params.push(filters.reportType);
  }
  if (filters.dateFrom) {
    where.push("COALESCE(r.report_issued_at, r.created_at) >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push("COALESCE(r.report_issued_at, r.created_at) <= ?");
    params.push(filters.dateTo);
  }
  const query = normalizeContentKey(filters.query);
  if (query) {
    where.push(`(
      lower(COALESCE(r.title, '')) LIKE ?
      OR lower(COALESCE(r.hospital_name_raw, '')) LIKE ?
      OR lower(COALESCE(r.hospital_branch, '')) LIKE ?
      OR lower(COALESCE(r.visit_department, '')) LIKE ?
      OR lower(COALESCE(r.performing_department, '')) LIKE ?
      OR lower(COALESCE(r.reporting_department, '')) LIKE ?
      OR lower(COALESCE(r.body_parts_json, '')) LIKE ?
    )`);
    const like = `%${query}%`;
    params.push(like, like, like, like, like, like, like);
  }
  const ocrQuery = (filters.ocrQuery || "").trim();
  if (ocrQuery) {
    where.push(`EXISTS (
      SELECT 1 FROM report_pages fp
      JOIN ocr_results fo ON fo.page_id = fp.id
      WHERE fp.report_id = r.id AND fo.lines_json LIKE ?
    )`);
    params.push(`%${ocrQuery}%`);
  }
  where.push(`(
    ? IS NULL
    OR (
      ? IS NOT NULL
      AND (r.report_issued_at < ? OR r.report_issued_at IS NULL OR (r.report_issued_at = ? AND r.id < ?))
    )
    OR (
      ? IS NULL
      AND r.report_issued_at IS NULL
      AND r.id < ?
    )
  )`);
  params.push(cursorId, cursorIssuedAt, cursorIssuedAt, cursorIssuedAt, cursorId, cursorIssuedAt, cursorId);
  params.push(safeLimit + 1);

  const rows = getDatabase().prepare(`
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch,
      ${displayDepartmentSql} AS departmentName,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      r.report_issued_at AS reportIssuedAt,
      (SELECT COUNT(*) FROM observations o WHERE o.report_id = r.id AND o.abnormal_flag IN ('high', 'low', 'abnormal')) AS abnormalCount,
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount
    FROM reports r
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE ${where.join(" AND ")}
    ORDER BY r.report_issued_at DESC, r.id DESC
    LIMIT ?
  `).all(...params) as ReportSummary[];
  const hasMore = rows.length > safeLimit;
  const items = hasMore ? rows.slice(0, safeLimit) : rows;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? Buffer.from(`${last.reportIssuedAt || ""}|${last.id}`).toString("base64url") : null
  };
}

export function getReportSummaryStats(user: RequestUser, memberId?: string) {
  if (!user.authenticated) {
    return {
      totalReports: 0,
      readyReports: 0,
      needsReviewReports: 0,
      processingReports: 0,
      failedReports: 0,
      totalPages: 0,
      observationCount: 0,
      abnormalObservationCount: 0,
      latestReportIssuedAt: null
    };
  }
  if (memberId) assertMemberAccess(user, memberId);
  const row = getDatabase().prepare(`
    SELECT
      COUNT(DISTINCT r.id) AS totalReports,
      COUNT(DISTINCT CASE WHEN r.status = 'ready' THEN r.id END) AS readyReports,
      COUNT(DISTINCT CASE WHEN r.status = 'needs_review' THEN r.id END) AS needsReviewReports,
      COUNT(DISTINCT CASE WHEN r.status IN ('queued', 'processing', 'uploading') THEN r.id END) AS processingReports,
      COUNT(DISTINCT CASE WHEN r.status = 'failed' THEN r.id END) AS failedReports,
      COUNT(DISTINCT p.id) AS totalPages,
      COUNT(DISTINCT o.id) AS observationCount,
      COUNT(DISTINCT CASE WHEN o.abnormal_flag IN ('high', 'low', 'abnormal') THEN o.id END) AS abnormalObservationCount,
      MAX(r.report_issued_at) AS latestReportIssuedAt
    FROM reports r
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    LEFT JOIN report_pages p ON p.report_id = r.id
    LEFT JOIN observations o ON o.report_id = r.id
    WHERE r.status <> 'trashed' AND (? IS NULL OR r.member_id = ?)
  `).get(user.id, memberId || null, memberId || null) as {
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
  return {
    totalReports: Number(row.totalReports || 0),
    readyReports: Number(row.readyReports || 0),
    needsReviewReports: Number(row.needsReviewReports || 0),
    processingReports: Number(row.processingReports || 0),
    failedReports: Number(row.failedReports || 0),
    totalPages: Number(row.totalPages || 0),
    observationCount: Number(row.observationCount || 0),
    abnormalObservationCount: Number(row.abnormalObservationCount || 0),
    latestReportIssuedAt: row.latestReportIssuedAt
  };
}

export function getOverview(user: RequestUser, memberId?: string) {
  if (!user.authenticated) {
    return {
      stats: getReportSummaryStats(user, memberId),
      pendingReminders: [],
      recentReadyReports: [],
      unfiledReports: []
    };
  }
  if (memberId) assertMemberAccess(user, memberId);
  const pendingStatuses = ["needs_review", "processing", "queued", "failed"];
  const stats = getReportSummaryStats(user, memberId);
  const pendingReminders = listReminders(user, memberId)
    .filter((item) => (item as { status: string }).status === "pending")
    .slice(0, 3);
  const recentReadyReports = listReports(user, 3, { memberId, status: "ready" }).items;
  const seen = new Set<string>();
  const unfiledReports = pendingStatuses
    .flatMap((status) => listReports(user, 3, { memberId, status }).items)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((left, right) => {
      const dateCompare = String(right.reportIssuedAt || "").localeCompare(String(left.reportIssuedAt || ""));
      return dateCompare || right.id.localeCompare(left.id);
    })
    .slice(0, 3);
  return { stats, pendingReminders, recentReadyReports, unfiledReports };
}

export function getReportDetail(user: RequestUser, reportId: string): ReportDetail {
  const row = getDatabase().prepare(`
    SELECT r.id, r.member_id AS memberId, r.title, r.report_type AS reportType, r.status,
      r.hospital_name_raw AS hospitalName, r.hospital_branch AS hospitalBranch, r.city,
      r.visit_type AS visitType,
      ${displayDepartmentSql} AS departmentName,
      r.visit_department AS visitDepartment,
      r.ordering_department AS orderingDepartment, r.performing_department AS performingDepartment,
      r.reporting_department AS reportingDepartment, r.inpatient_ward AS inpatientWard,
      json_extract(r.body_parts_json, '$[0].name') AS bodyPart,
      r.body_parts_json AS bodyPartsJson, r.identifiers_json AS identifiersJson,
      r.report_issued_at AS reportIssuedAt, r.examined_at AS examinedAt,
      r.ordered_at AS orderedAt, r.sampled_at AS sampledAt, r.received_at AS receivedAt,
      r.reviewed_at AS reviewedAt, r.admitted_at AS admittedAt, r.discharged_at AS dischargedAt,
      r.clinicians_json AS cliniciansJson, r.clinical_diagnosis AS clinicalDiagnosis,
      r.purpose, r.chief_complaint AS chiefComplaint, r.findings, r.impression, r.summary,
      r.recommendation,
      (SELECT COUNT(*) FROM observations o WHERE o.report_id = r.id AND o.abnormal_flag IN ('high', 'low', 'abnormal')) AS abnormalCount,
      (SELECT COUNT(*) FROM report_pages p WHERE p.report_id = r.id) AS pageCount
    FROM reports r
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE r.id = ? AND r.status <> 'trashed'
  `).get(user.id, reportId) as (DuplicateSourceRow & {
    city: string | null;
    visitType: string | null;
    visitDepartment: string | null;
    orderingDepartment: string | null;
    performingDepartment: string | null;
    reportingDepartment: string | null;
    inpatientWard: string | null;
    bodyPartsJson: string;
    identifiersJson: string;
    examinedAt: string | null;
    orderedAt: string | null;
    sampledAt: string | null;
    receivedAt: string | null;
    reviewedAt: string | null;
    admittedAt: string | null;
    dischargedAt: string | null;
    cliniciansJson: string;
    clinicalDiagnosis: string | null;
    purpose: string | null;
    chiefComplaint: string | null;
    recommendation: string | null;
  }) | undefined;
  if (!row) {
    const exists = getDatabase().prepare("SELECT member_id AS memberId FROM reports WHERE id = ?").get(reportId) as { memberId: string } | undefined;
    if (exists) assertMemberAccess(user, exists.memberId);
    throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  }
  const pages = getDatabase().prepare(`
    SELECT id, report_id AS reportId, page_number AS pageNumber, original_name AS originalName,
      mime_type AS mimeType, file_size AS fileSize, width, height, rotation,
      source_page_number AS sourcePageNumber, source_page_count AS sourcePageCount,
      thumbnail_path IS NOT NULL AS hasThumbnail
    FROM report_pages WHERE report_id = ? ORDER BY page_number
  `).all(reportId) as unknown as ReportPage[];
  const observations = getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_text AS referenceText,
      o.abnormal_flag AS abnormalFlag, o.evidence_json AS evidenceJson,
      n.canonical_name AS canonicalName, n.canonical_value AS canonicalValue,
      n.canonical_unit AS canonicalUnit, n.quality AS normalizationQuality,
      n.confidence AS normalizationConfidence, n.match_reason AS normalizationReason,
      n.excluded_reason AS normalizationExcludedReason,
      c.explanation AS canonicalExplanation
    FROM observations o
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    LEFT JOIN indicator_catalog c ON c.id = n.indicator_id
    WHERE o.report_id = ? ORDER BY o.section_name, o.id LIMIT 200
  `).all(reportId).map((item) => {
    const row = item as Observation & { evidenceJson: string };
    const evidence = parseJson<Array<{ quote?: string }> | null>(row.evidenceJson, null);
    return {
      ...row,
      abnormalFlag: displayAbnormalFlag(row.abnormalFlag, row.resultText, ...(Array.isArray(evidence) ? evidence : []).map((entry) => entry.quote || null)),
      evidence,
      evidenceJson: undefined
    };
  }) as Observation[];
  const morphologyFindings = getDatabase().prepare(`
    SELECT id, report_id AS reportId, section_name AS sectionName, organ, region, laterality,
      finding_type AS findingType, finding_name AS findingName, presence,
      finding_count AS findingCount, size_length AS sizeLength, size_width AS sizeWidth,
      size_height AS sizeHeight, size_unit AS sizeUnit, measurements_json AS measurementsJson,
      morphology_text AS morphology, attributes_json AS attributesJson,
      classification_system AS classificationSystem,
      classification_value AS classificationValue,
      classification_text AS classificationText, comparison_text AS comparisonText,
      raw_text AS rawText, evidence_json AS evidenceJson, confidence,
      tracking_group_id AS trackingGroupId, match_confidence AS matchConfidence,
      source, manual_fields_json AS manualFieldsJson
    FROM morphology_findings
    WHERE report_id = ?
    ORDER BY section_name, organ, finding_type, id
    LIMIT 200
  `).all(reportId).map((item) => {
    const finding = item as {
      id: string;
      reportId: string;
      sectionName: string | null;
      organ: string | null;
      region: string | null;
      laterality: MorphologyFinding["laterality"];
      findingType: string;
      findingName: string;
      presence: MorphologyFinding["presence"];
      findingCount: number | null;
      sizeLength: number | null;
      sizeWidth: number | null;
      sizeHeight: number | null;
      sizeUnit: string | null;
      measurementsJson: string;
      morphology: string | null;
      attributesJson: string;
      classificationSystem: string | null;
      classificationValue: string | null;
      classificationText: string | null;
      comparisonText: string | null;
      rawText: string;
      evidenceJson: string;
      confidence: number | null;
      trackingGroupId: string | null;
      matchConfidence: number | null;
      source: MorphologyFinding["source"];
      manualFieldsJson: string;
    };
    const hasClassification = Boolean(
      finding.classificationSystem || finding.classificationValue || finding.classificationText
    );
    return {
      id: finding.id,
      reportId: finding.reportId,
      examDate: row.examinedAt || row.reportIssuedAt,
      sectionName: finding.sectionName,
      organ: finding.organ,
      region: finding.region,
      laterality: finding.laterality,
      findingType: finding.findingType,
      findingName: finding.findingName,
      presence: finding.presence,
      findingCount: finding.findingCount,
      size: {
        length: finding.sizeLength,
        width: finding.sizeWidth,
        height: finding.sizeHeight,
        unit: finding.sizeUnit
      },
      measurements: parseJson(finding.measurementsJson, []),
      morphology: finding.morphology,
      attributes: parseJson(finding.attributesJson, {}),
      classification: hasClassification ? {
        system: finding.classificationSystem,
        value: finding.classificationValue,
        text: finding.classificationText
      } : null,
      comparisonText: finding.comparisonText,
      rawText: finding.rawText,
      evidence: parseJson(finding.evidenceJson, []),
      confidence: finding.confidence,
      trackingGroupId: finding.trackingGroupId,
      matchConfidence: finding.matchConfidence,
      source: finding.source,
      manualFields: parseJson(finding.manualFieldsJson, [])
    };
  }) as MorphologyFinding[];
  const diagnoses = getDatabase().prepare(`
    SELECT id, report_id AS reportId, section_name AS sectionName,
      diagnosis_type AS diagnosisType, diagnosis_text AS diagnosisText,
      diagnosis_code AS diagnosisCode, code_system AS codeSystem,
      is_primary AS isPrimary, evidence_json AS evidenceJson, source,
      manual_fields_json AS manualFieldsJson
    FROM report_diagnoses WHERE report_id = ? AND is_deleted = 0
    ORDER BY is_primary DESC, diagnosis_type, id
  `).all(reportId).map((item) => {
    const fact = item as unknown as Omit<ReportDiagnosis, "isPrimary" | "evidence" | "manualFields"> & {
      isPrimary: number;
      evidenceJson: string;
      manualFieldsJson: string;
    };
    return {
      ...fact,
      isPrimary: Boolean(fact.isPrimary),
      evidence: parseJson(fact.evidenceJson, []),
      manualFields: parseJson(fact.manualFieldsJson, []),
      evidenceJson: undefined,
      manualFieldsJson: undefined
    };
  }) as ReportDiagnosis[];
  const medications = getDatabase().prepare(`
    SELECT id, report_id AS reportId, section_name AS sectionName,
      medication_context AS context, medication_name AS medicationName,
      generic_name AS genericName, specification, dosage_form AS dosageForm,
      dose, dose_unit AS doseUnit, frequency, route, duration, quantity,
      quantity_unit AS quantityUnit, instructions, evidence_json AS evidenceJson,
      source, manual_fields_json AS manualFieldsJson
    FROM report_medications WHERE report_id = ? AND is_deleted = 0
    ORDER BY medication_context, section_name, id
  `).all(reportId).map((item) => {
    const fact = item as Omit<ReportMedication, "evidence" | "manualFields"> & {
      evidenceJson: string;
      manualFieldsJson: string;
    };
    return {
      ...fact,
      evidence: parseJson(fact.evidenceJson, []),
      manualFields: parseJson(fact.manualFieldsJson, []),
      evidenceJson: undefined,
      manualFieldsJson: undefined
    };
  }) as ReportMedication[];
  const procedures = getDatabase().prepare(`
    SELECT id, report_id AS reportId, section_name AS sectionName,
      procedure_type AS procedureType, procedure_name AS procedureName,
      procedure_code AS procedureCode, body_part AS bodyPart,
      performed_at AS performedAt, result_text AS resultText,
      evidence_json AS evidenceJson, source, manual_fields_json AS manualFieldsJson
    FROM report_procedures WHERE report_id = ? AND is_deleted = 0
    ORDER BY performed_at, procedure_type, id
  `).all(reportId).map((item) => {
    const fact = item as Omit<ReportProcedure, "evidence" | "manualFields"> & {
      evidenceJson: string;
      manualFieldsJson: string;
    };
    return {
      ...fact,
      evidence: parseJson(fact.evidenceJson, []),
      manualFields: parseJson(fact.manualFieldsJson, []),
      evidenceJson: undefined,
      manualFieldsJson: undefined
    };
  }) as ReportProcedure[];
  const vaccinations = getDatabase().prepare(`
    SELECT id, report_id AS reportId, vaccine_name AS vaccineName,
      dose_number AS doseNumber, manufacturer, lot_number AS lotNumber,
      administered_at AS administeredAt, administration_site AS administrationSite,
      next_due_at AS nextDueAt, evidence_json AS evidenceJson, source,
      manual_fields_json AS manualFieldsJson
    FROM vaccination_records WHERE report_id = ? AND is_deleted = 0
    ORDER BY administered_at, id
  `).all(reportId).map((item) => {
    const fact = item as Omit<VaccinationRecord, "evidence" | "manualFields"> & {
      evidenceJson: string;
      manualFieldsJson: string;
    };
    return {
      ...fact,
      evidence: parseJson(fact.evidenceJson, []),
      manualFields: parseJson(fact.manualFieldsJson, []),
      evidenceJson: undefined,
      manualFieldsJson: undefined
    };
  }) as VaccinationRecord[];
  const billingSummaryRow = getDatabase().prepare(`
    SELECT id, report_id AS reportId, invoice_number AS invoiceNumber,
      total_amount AS totalAmount, insurance_amount AS insuranceAmount,
      self_pay_amount AS selfPayAmount, currency, evidence_json AS evidenceJson,
      source, manual_fields_json AS manualFieldsJson
    FROM billing_summaries WHERE report_id = ? AND is_deleted = 0
  `).get(reportId) as (Omit<BillingSummary, "evidence" | "manualFields"> & {
    evidenceJson: string;
    manualFieldsJson: string;
  }) | undefined;
  const billingSummary = billingSummaryRow
    ? {
        ...billingSummaryRow,
        evidence: parseJson(billingSummaryRow.evidenceJson, []),
        manualFields: parseJson(billingSummaryRow.manualFieldsJson, []),
        evidenceJson: undefined,
        manualFieldsJson: undefined
      }
    : null;
  const billingItems = getDatabase().prepare(`
    SELECT id, report_id AS reportId, category, item_name AS itemName,
      amount, quantity, evidence_json AS evidenceJson
      , source, manual_fields_json AS manualFieldsJson
    FROM billing_items WHERE report_id = ? AND is_deleted = 0
    ORDER BY category, id
  `).all(reportId).map((item) => {
    const fact = item as Omit<BillingItem, "evidence" | "manualFields"> & {
      evidenceJson: string;
      manualFieldsJson: string;
    };
    return {
      ...fact,
      evidence: parseJson(fact.evidenceJson, []),
      manualFields: parseJson(fact.manualFieldsJson, []),
      evidenceJson: undefined,
      manualFieldsJson: undefined
    };
  }) as BillingItem[];
  const structuredSectionOrder = [
    "checkup_package", "checkup_positive_findings", "checkup_abnormal_summary",
    "checkup_final_conclusion", "checkup_original_recommendation",
    "laboratory_specimen", "laboratory_method",
    "imaging_modality", "imaging_contrast",
    "functional_method", "functional_description",
    "pathology_specimen", "pathology_gross_findings", "pathology_microscopic_findings",
    "pathology_immunohistochemistry", "pathology_grade", "pathology_stage",
    "outpatient_history", "outpatient_physical_examination", "outpatient_disposition", "outpatient_advice",
    "inpatient_course", "inpatient_discharge_instructions"
  ];
  const structuredSections = getDatabase().prepare(`
    SELECT id, report_id AS reportId, section_key AS sectionKey,
      section_title AS title, content_text AS content, content_json AS contentJson,
      evidence_json AS evidenceJson, source, manual_fields_json AS manualFieldsJson
    FROM report_structured_sections
    WHERE report_id = ? AND is_deleted = 0
  `).all(reportId).map((item) => {
    const section = item as Omit<ReportStructuredSection, "contentData" | "evidence" | "manualFields"> & {
      contentJson: string | null;
      evidenceJson: string;
      manualFieldsJson: string;
    };
    return {
      ...section,
      contentData: parseJson<Record<string, unknown> | null>(section.contentJson, null),
      evidence: parseJson(section.evidenceJson, []),
      manualFields: parseJson(section.manualFieldsJson, []),
      contentJson: undefined,
      evidenceJson: undefined,
      manualFieldsJson: undefined
    };
  }).filter((section) => section.source === "manual"
    || isAiReportStructuredSectionCompatible(row.reportType, section.sectionKey)
  ).sort((left, right) => {
    const leftIndex = structuredSectionOrder.indexOf(left.sectionKey);
    const rightIndex = structuredSectionOrder.indexOf(right.sectionKey);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex)
      || left.title.localeCompare(right.title, "zh-CN");
  }) as ReportStructuredSection[];
  return {
    ...row,
    bodyParts: parseJson(row.bodyPartsJson, []),
    identifiers: parseJson(row.identifiersJson, {}),
    clinicians: parseJson(row.cliniciansJson, {}),
    pages,
    observations,
    morphologyFindings,
    diagnoses,
    medications,
    procedures,
    vaccinations,
    billingSummary,
    billingItems,
    structuredSections,
    manualFieldKeys: [...listManualReportFieldKeys(reportId)],
    duplicateCandidates: findDuplicateCandidates(row)
  };
}

/* 异常标记读取兜底：存量数据 AI 漏标时，从结果文本和证据原文的箭头/高低标记推导（只基于原文，不做参考范围推断） */
function displayAbnormalFlag<T extends "high" | "low" | "abnormal" | "normal" | null>(flag: T, ...chunks: Array<string | null>): T {
  if (flag) return flag;
  const text = chunks.filter(Boolean).join(" ");
  if (!text) return flag;
  if (/[↑▲⬆]|偏高/.test(text)) return "high" as T;
  if (/[↓▼⬇]|偏低/.test(text)) return "low" as T;
  return flag;
}

export function getReportPageFile(user: RequestUser, reportId: string, pageId: string, variant: "original" | "thumbnail") {
  const row = getDatabase().prepare(`
    SELECT r.member_id AS memberId, p.original_name AS originalName, p.mime_type AS mimeType,
      p.storage_path AS storagePath, p.thumbnail_path AS thumbnailPath
    FROM report_pages p
    JOIN reports r ON r.id = p.report_id
    WHERE p.id = ? AND p.report_id = ? AND r.status <> 'trashed'
  `).get(pageId, reportId) as {
    memberId: string;
    originalName: string;
    mimeType: string;
    storagePath: string;
    thumbnailPath: string | null;
  } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "报告原件不存在" });
  assertMemberAccess(user, row.memberId);
  const relativePath = variant === "thumbnail" ? row.thumbnailPath : row.storagePath;
  if (!relativePath) throw createError({ statusCode: 404, statusMessage: "页面缩略图不存在" });
  const path = storagePath(relativePath);
  if (!existsSync(path)) throw createError({ statusCode: 404, statusMessage: "报告文件不存在" });
  return {
    path,
    mimeType: variant === "thumbnail" ? "image/jpeg" : row.mimeType,
    filename: row.originalName
  };
}

export async function getReportPagePreviewFile(user: RequestUser, reportId: string, pageId: string) {
  const row = getDatabase().prepare(`
    SELECT r.member_id AS memberId, p.id AS pageId, p.original_name AS originalName,
      p.mime_type AS mimeType, p.storage_path AS storagePath, p.thumbnail_path AS thumbnailPath,
      p.source_page_number AS sourcePageNumber, p.page_number AS pageNumber, p.rotation
    FROM report_pages p
    JOIN reports r ON r.id = p.report_id
    WHERE p.id = ? AND p.report_id = ? AND r.status <> 'trashed'
  `).get(pageId, reportId) as {
    memberId: string;
    pageId: string;
    originalName: string;
    mimeType: string;
    storagePath: string;
    thumbnailPath: string | null;
    sourcePageNumber: number | null;
    pageNumber: number;
    rotation: number;
  } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "报告页面不存在" });
  assertMemberAccess(user, row.memberId);

  if (row.mimeType !== "application/pdf") {
    return getReportPageFile(user, reportId, pageId, "original");
  }

  const previewRelativePath = pdfPreviewRelativePath(reportId, pageId);
  const previewPath = storagePath(previewRelativePath);
  if (existsSync(previewPath)) {
    return { path: previewPath, mimeType: "image/jpeg", filename: `${row.originalName}-第${row.pageNumber}页.jpg` };
  }

  const originalPath = storagePath(row.storagePath);
  try {
    await requestWorker({
      action: "thumbnail",
      imagePath: originalPath,
      outputPath: previewPath,
      pageNumber: row.sourcePageNumber || row.pageNumber,
      rotation: row.rotation,
      maxSize: pdfPreviewMaxSize,
      quality: pdfPreviewQuality,
      renderScale: pdfPreviewRenderScale
    });
    if (existsSync(previewPath)) {
      return { path: previewPath, mimeType: "image/jpeg", filename: `${row.originalName}-第${row.pageNumber}页.jpg` };
    }
  } catch {
    // 如果运行环境暂不可用，降级到已生成的缩略图，避免看图模式因整份 PDF 加载而卡住。
  }

  if (row.thumbnailPath) {
    const thumbnailPath = storagePath(row.thumbnailPath);
    if (existsSync(thumbnailPath)) {
      return { path: thumbnailPath, mimeType: "image/jpeg", filename: `${row.originalName}-第${row.pageNumber}页-preview.jpg` };
    }
  }
  throw createError({ statusCode: 503, statusMessage: "当前页预览图尚未生成" });
}

export function listReportOcrText(user: RequestUser, reportId: string) {
  const report = getDatabase().prepare("SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'")
    .get(reportId) as { memberId: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberAccess(user, report.memberId);
  return getDatabase().prepare(`
    SELECT p.id AS pageId, p.page_number AS pageNumber, p.original_name AS originalName,
      o.engine, o.model_version AS modelVersion, o.elapsed_ms AS elapsedMs, o.lines_json AS linesJson,
      o.quality_score AS qualityScore, o.quality_level AS qualityLevel, o.quality_reason AS qualityReason
    FROM report_pages p
    LEFT JOIN ocr_results o ON o.page_id = p.id
    WHERE p.report_id = ?
    ORDER BY p.page_number
  `).all(reportId).map((row) => {
    const item = row as {
      pageId: string;
      pageNumber: number;
      originalName: string;
      engine: string | null;
      modelVersion: string | null;
      elapsedMs: number | null;
      linesJson: string | null;
      qualityScore: number | null;
      qualityLevel: "good" | "weak" | "poor" | null;
      qualityReason: string | null;
    };
    const lines = parseJson<Array<Record<string, unknown>>>(item.linesJson, [])
      .map((line) => typeof line.text === "string" ? redactSensitiveText(line.text).trim() : "")
      .filter(Boolean);
    return {
      pageId: item.pageId,
      pageNumber: item.pageNumber,
      originalName: item.originalName,
      engine: item.engine,
      modelVersion: item.modelVersion,
      elapsedMs: item.elapsedMs,
      qualityScore: item.qualityScore,
      qualityLevel: item.qualityLevel,
      qualityReason: item.qualityReason,
      lineCount: lines.length,
      text: lines.join("\n")
    };
  });
}

export function confirmReportReady(user: RequestUser, reportId: string) {
  const report = getDatabase().prepare("SELECT member_id AS memberId, status FROM reports WHERE id = ? AND status <> 'trashed'")
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  if (report.status === "ready") return { id: reportId, status: "ready" };
  if (report.status !== "needs_review") {
    throw createError({ statusCode: 409, statusMessage: "只有待确认报告可以归档" });
  }
  const db = getDatabase();
  db.prepare("UPDATE reports SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reportId);
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'report.confirm_ready', 'report', ?, ?)
  `).run(createId("audit"), user.id, reportId, JSON.stringify({ memberId: report.memberId }));
  const reminder = createReportSuggestionReminder(user, reportId);
  return { id: reportId, status: "ready", ...(reminder ? { reminderCreated: true } : {}) };
}

export function trashReport(user: RequestUser, reportId: string) {
  const report = getDatabase().prepare("SELECT member_id AS memberId, status FROM reports WHERE id = ? AND status <> 'trashed'")
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const db = getDatabase();
  db.prepare(`
    UPDATE reports
    SET status = 'trashed',
      deleted_at = CURRENT_TIMESTAMP,
      purge_after = datetime('now', '+30 days'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reportId);
  db.prepare(`
    UPDATE processing_jobs
    SET status = 'cancelled',
      finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
    WHERE report_id = ? AND status IN ('queued', 'processing')
  `).run(reportId);
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'report.trash', 'report', ?, ?)
  `).run(createId("audit"), user.id, reportId, JSON.stringify({ memberId: report.memberId, previousStatus: report.status }));
  return { id: reportId, status: "trashed" as const, purgeAfterDays: 30 };
}

export function restoreReport(user: RequestUser, reportId: string) {
  const report = getDatabase().prepare("SELECT member_id AS memberId, status FROM reports WHERE id = ?")
    .get(reportId) as { memberId: string; status: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  if (report.status !== "trashed") return { id: reportId, status: report.status };
  getDatabase().prepare(`
    UPDATE reports SET status = 'needs_review', deleted_at = NULL, purge_after = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reportId);
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'report.restore', 'report', ?, ?)
  `).run(createId("audit"), user.id, reportId, JSON.stringify({ memberId: report.memberId }));
  return { id: reportId, status: "needs_review" as const };
}

export function permanentlyDeleteReport(user: RequestUser, reportId: string) {
  const report = getDatabase().prepare("SELECT member_id AS memberId, title, status FROM reports WHERE id = ?")
    .get(reportId) as { memberId: string; title: string; status: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  if (report.status !== "trashed") throw createError({ statusCode: 409, statusMessage: "只有回收站报告可以永久删除" });
  return purgeTrashedReport(reportId, user.id, false);
}

function purgeTrashedReport(reportId: string, actorUserId: string | null, automatic: boolean) {
  const report = getDatabase().prepare("SELECT member_id AS memberId, title, status FROM reports WHERE id = ?")
    .get(reportId) as { memberId: string; title: string; status: string } | undefined;
  if (!report || report.status !== "trashed") {
    throw createError({ statusCode: 409, statusMessage: "只有回收站报告可以永久删除" });
  }
  if (isReportJobActive(reportId)) {
    throw createError({ statusCode: 409, statusMessage: "报告任务仍在结束处理中，请稍后再永久删除" });
  }
  const pages = reportPageRows(reportId);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.purge', 'report', ?, ?)
    `).run(createId("audit"), actorUserId, reportId, JSON.stringify({
      memberId: report.memberId,
      reportTitle: report.title,
      pageCount: pages.length,
      automatic
    }));
    db.prepare("DELETE FROM reports WHERE id = ?").run(reportId);
    enqueueFileGarbage(pages.flatMap((page) => [
      { storagePath: page.storagePath, fileKind: "original" as const },
      { storagePath: page.thumbnailPath, fileKind: "thumbnail" as const }
    ]), automatic ? "recycle_bin_expired" : "report_purge", db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { id: reportId, deleted: true };
}

export function purgeExpiredReports(limit = 50) {
  const rows = getDatabase().prepare(`
    SELECT id FROM reports
    WHERE status = 'trashed' AND purge_after IS NOT NULL AND purge_after <= CURRENT_TIMESTAMP
    ORDER BY purge_after, id
    LIMIT ?
  `).all(Math.min(200, Math.max(1, Math.round(limit)))) as Array<{ id: string }>;
  let deleted = 0;
  const errors: Array<{ reportId: string; message: string }> = [];
  for (const row of rows) {
    try {
      purgeTrashedReport(row.id, null, true);
      deleted += 1;
    } catch (error) {
      errors.push({
        reportId: row.id,
        message: error instanceof Error ? error.message : "自动清理失败"
      });
    }
  }
  return { checked: rows.length, deleted, failed: errors.length, errors };
}

export function listDuplicateReportGroups(user: RequestUser, memberId: string): DuplicateReportGroup[] {
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "请选择成员" });
  const rows = duplicateSourceRowsForMember(user, memberId);
  const seenPairs = new Set<string>();
  const groups: DuplicateReportGroup[] = [];
  for (const report of rows) {
    const candidates = findDuplicateCandidates(report).filter((candidate) => {
      const key = [report.id, candidate.id].sort().join(":");
      if (seenPairs.has(key)) return false;
      seenPairs.add(key);
      return true;
    });
    if (candidates.length) groups.push({ report, candidates });
  }
  return groups;
}

export function mergeDuplicateReport(user: RequestUser, sourceReportId: string, targetReportId: string) {
  if (sourceReportId === targetReportId) throw createError({ statusCode: 400, statusMessage: "不能合并到同一份报告" });
  const rows = getDatabase().prepare(`
    SELECT id, member_id AS memberId, status, title FROM reports
    WHERE id IN (?, ?) AND status <> 'trashed'
  `).all(sourceReportId, targetReportId) as Array<{ id: string; memberId: string; status: string; title: string }>;
  const source = rows.find((row) => row.id === sourceReportId);
  const target = rows.find((row) => row.id === targetReportId);
  if (!source || !target) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  if (source.memberId !== target.memberId) throw createError({ statusCode: 409, statusMessage: "只能合并同一成员的报告" });
  assertMemberManage(user, source.memberId);
  const active = getDatabase().prepare(`
    SELECT report_id AS reportId FROM processing_jobs
    WHERE report_id IN (?, ?) AND status IN ('queued', 'processing')
    LIMIT 1
  `).get(sourceReportId, targetReportId) as { reportId: string } | undefined;
  if (active || isReportJobActive(sourceReportId) || isReportJobActive(targetReportId)) {
    throw createError({ statusCode: 409, statusMessage: "报告仍有识别任务在处理，请完成或取消后再合并" });
  }

  const sourcePages = reportPageRows(sourceReportId);
  if (!sourcePages.length) throw createError({ statusCode: 409, statusMessage: "源报告没有可合并的原件页" });
  const targetMaxPage = getDatabase().prepare("SELECT COALESCE(MAX(page_number), 0) AS maxPage FROM report_pages WHERE report_id = ?")
    .get(targetReportId) as { maxPage: number };
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    sourcePages.forEach((page, index) => {
      db.prepare("UPDATE report_pages SET report_id = ?, page_number = ? WHERE id = ?")
        .run(targetReportId, Number(targetMaxPage.maxPage || 0) + index + 1, page.id);
      db.prepare("UPDATE processing_jobs SET report_id = ? WHERE page_id = ?").run(targetReportId, page.id);
      db.prepare("UPDATE processing_job_events SET report_id = ? WHERE job_id IN (SELECT id FROM processing_jobs WHERE page_id = ?)")
        .run(targetReportId, page.id);
    });
    db.prepare(`
      UPDATE reports
      SET status = 'trashed', deleted_at = CURRENT_TIMESTAMP, purge_after = datetime('now', '+30 days'), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(sourceReportId);
    db.prepare(`
      UPDATE processing_jobs
      SET status = 'cancelled', finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
      WHERE report_id = ? AND page_id IS NULL AND status IN ('queued', 'processing')
    `).run(sourceReportId);
    db.prepare("UPDATE reports SET status = 'needs_review', source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(targetReportId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.merge_duplicate', 'report', ?, ?)
    `).run(createId("audit"), user.id, targetReportId, JSON.stringify({
      memberId: source.memberId,
      sourceReportId,
      targetReportId,
      movedPages: sourcePages.length
    }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { sourceReportId, targetReportId, movedPages: sourcePages.length, sourceStatus: "trashed", targetStatus: "needs_review" };
}

export function updateReportFields(user: RequestUser, reportId: string, input: Record<string, unknown>) {
  const db = getDatabase();
  const report = db.prepare(`
    SELECT member_id AS memberId, status, ${reportFieldDefinitions.map((field) => field.column).join(", ")}
    FROM reports
    WHERE id = ? AND status <> 'trashed'
  `).get(reportId) as ({ memberId: string; status: string } & Record<string, string | null>) | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const reportType = textInput(input.reportType, 40);
  if (reportType && !allowedReportTypes.has(reportType)) throw createError({ statusCode: 400, statusMessage: "报告类型无效" });
  const bodyPart = textInput(input.bodyPart, 120);
  const bodyPartsValue = bodyPart ? JSON.stringify([{ raw: bodyPart, name: bodyPart, parent: null, laterality: "unspecified" }]) : "[]";
  const updates = [
    { fieldKey: "title", column: "title", value: textInput(input.title, 180), overrideValue: textInput(input.title, 180) },
    { fieldKey: "reportType", column: "report_type", value: reportType, overrideValue: reportType },
    { fieldKey: "hospitalName", column: "hospital_name_raw", value: textInput(input.hospitalName, 180), overrideValue: textInput(input.hospitalName, 180) },
    { fieldKey: "hospitalBranch", column: "hospital_branch", value: textInput(input.hospitalBranch, 120), overrideValue: textInput(input.hospitalBranch, 120) },
    { fieldKey: "city", column: "city", value: textInput(input.city, 80), overrideValue: textInput(input.city, 80) },
    { fieldKey: "visitType", column: "visit_type", value: textInput(input.visitType, 80), overrideValue: textInput(input.visitType, 80) },
    { fieldKey: "departmentName", column: "visit_department", value: textInput(input.departmentName, 120), overrideValue: textInput(input.departmentName, 120) },
    { fieldKey: "orderingDepartment", column: "ordering_department", value: textInput(input.orderingDepartment, 120), overrideValue: textInput(input.orderingDepartment, 120) },
    { fieldKey: "performingDepartment", column: "performing_department", value: textInput(input.performingDepartment, 120), overrideValue: textInput(input.performingDepartment, 120) },
    { fieldKey: "reportingDepartment", column: "reporting_department", value: textInput(input.reportingDepartment, 120), overrideValue: textInput(input.reportingDepartment, 120) },
    { fieldKey: "reportIssuedAt", column: "report_issued_at", value: dateInput(input.reportIssuedAt), overrideValue: dateInput(input.reportIssuedAt) },
    { fieldKey: "examinedAt", column: "examined_at", value: dateInput(input.examinedAt), overrideValue: dateInput(input.examinedAt) },
    { fieldKey: "clinicalDiagnosis", column: "clinical_diagnosis", value: textInput(input.clinicalDiagnosis, 500), overrideValue: textInput(input.clinicalDiagnosis, 500) },
    { fieldKey: "purpose", column: "purpose", value: textInput(input.purpose, 500), overrideValue: textInput(input.purpose, 500) },
    { fieldKey: "findings", column: "findings", value: textInput(input.findings, 2000), overrideValue: textInput(input.findings, 2000) },
    { fieldKey: "impression", column: "impression", value: textInput(input.impression, 2000), overrideValue: textInput(input.impression, 2000) },
    { fieldKey: "summary", column: "summary", value: textInput(input.summary, 1000), overrideValue: textInput(input.summary, 1000) },
    { fieldKey: "recommendation", column: "recommendation", value: textInput(input.recommendation, 1000), overrideValue: textInput(input.recommendation, 1000) },
    { fieldKey: "bodyParts", column: "body_parts_json", value: bodyPartsValue, overrideValue: bodyPart ? [{ raw: bodyPart, name: bodyPart, parent: null, laterality: "unspecified" }] : [] }
  ] satisfies Array<{ fieldKey: ReportFieldKey; column: string; value: string | null; overrideValue: unknown }>;
  const changedManualFields = updates
    .filter((field) => (report[field.column] ?? null) !== (field.value ?? null))
    .map((field) => ({ fieldKey: field.fieldKey, value: field.overrideValue }));
  const setClauses = updates.map((field) => `${field.column} = ?`);
  const values = updates.map((field) => field.value);
  setClauses.push("source_version = source_version + 1", "updated_at = CURRENT_TIMESTAMP");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE reports SET ${setClauses.join(", ")} WHERE id = ?`).run(...values, reportId);
    upsertManualReportFieldOverrides({ reportId, userId: user.id, fields: changedManualFields });
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.manual_update', 'report', ?, ?)
    `).run(createId("audit"), user.id, reportId, JSON.stringify({
      memberId: report.memberId,
      fields: updates.map((field) => field.column),
      manualFieldKeys: changedManualFields.map((field) => field.fieldKey)
    }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getReportDetail(user, reportId);
}

function queuePageRefreshJobs(reportId: string, pageId: string) {
  const db = getDatabase();
  for (const jobType of ["thumbnail", "ocr"]) {
    const jobId = createId("job");
    db.prepare(`
      INSERT INTO processing_jobs (id, report_id, page_id, job_type, pipeline_version, deduplication_key)
      VALUES (?, ?, ?, ?, 'manual-page-v1', ?)
    `).run(jobId, reportId, pageId, jobType, `${reportId}:${pageId}:${jobType}:manual:${jobId}`);
    db.prepare(`
      INSERT INTO processing_job_events (id, job_id, report_id, event_type, status, attempt, detail_json)
      VALUES (?, ?, ?, 'queued', 'queued', 0, ?)
    `).run(createId("event"), jobId, reportId, JSON.stringify({ jobType, pageId, source: "manual_page_edit" }));
  }
}

export function updateReportPages(user: RequestUser, reportId: string, input: Record<string, unknown>) {
  const report = getDatabase().prepare("SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'")
    .get(reportId) as { memberId: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const pages = Array.isArray(input.pages) ? input.pages as Array<Record<string, unknown>> : [];
  if (!pages.length) throw createError({ statusCode: 400, statusMessage: "页面列表不能为空" });
  const existing = new Map(reportPageRows(reportId).map((page) => [page.id, page]));
  const seen = new Set<string>();
  const normalized = pages.map((page, index) => {
    const id = textInput(page.id, 80);
    if (!id || !existing.has(id) || seen.has(id)) throw createError({ statusCode: 400, statusMessage: "页面列表无效" });
    seen.add(id);
    const rotation = Number(page.rotation || 0);
    if (![0, 90, 180, 270].includes(rotation)) throw createError({ statusCode: 400, statusMessage: "页面旋转角度无效" });
    return { id, pageNumber: index + 1, rotation };
  });
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE report_pages SET page_number = -page_number WHERE report_id = ?").run(reportId);
    for (const page of normalized) {
      db.prepare("UPDATE report_pages SET page_number = ?, rotation = ? WHERE id = ? AND report_id = ?")
        .run(page.pageNumber, page.rotation, page.id, reportId);
      queuePageRefreshJobs(reportId, page.id);
    }
    db.prepare("UPDATE reports SET status = 'processing', source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reportId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.pages.update', 'report', ?, ?)
    `).run(createId("audit"), user.id, reportId, JSON.stringify({ memberId: report.memberId, pageCount: normalized.length }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getReportDetail(user, reportId);
}

export function deleteReportPage(user: RequestUser, reportId: string, pageId: string) {
  const report = getDatabase().prepare("SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'")
    .get(reportId) as { memberId: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  const pages = reportPageRows(reportId);
  if (pages.length <= 1) throw createError({ statusCode: 409, statusMessage: "至少需要保留一页原件" });
  const page = pages.find((item) => item.id === pageId);
  if (!page) throw createError({ statusCode: 404, statusMessage: "页面不存在" });
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM report_pages WHERE id = ? AND report_id = ?").run(pageId, reportId);
    const remaining = pages.filter((item) => item.id !== pageId);
    remaining.forEach((item, index) => db.prepare("UPDATE report_pages SET page_number = ? WHERE id = ?").run(index + 1, item.id));
    enqueueFileGarbage([
      { storagePath: page.storagePath, fileKind: "original" },
      { storagePath: page.thumbnailPath, fileKind: "thumbnail" }
    ], "report_page_delete", db);
    db.prepare("UPDATE reports SET source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reportId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'report.page.delete', 'report_page', ?, ?)
    `).run(createId("audit"), user.id, pageId, JSON.stringify({ reportId, memberId: report.memberId }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getReportDetail(user, reportId);
}

function parseNumericResultText(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").replace(/[<>≤≥]/g, " ");
  const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactTrendKey(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[（(].*?[）)]/g, "")
    .replace(/\s+/g, "")
    .replace(/[：:，,。.;；、_\-]/g, "");
}

const trendNameAliases = new Map<string, string>([
  ["wbc", "白细胞计数"],
  ["白细胞", "白细胞计数"],
  ["白细胞数", "白细胞计数"],
  ["白细胞计数", "白细胞计数"],
  ["rbc", "红细胞计数"],
  ["红细胞", "红细胞计数"],
  ["红细胞数", "红细胞计数"],
  ["红细胞计数", "红细胞计数"],
  ["hgb", "血红蛋白"],
  ["hb", "血红蛋白"],
  ["血红蛋白", "血红蛋白"],
  ["血色素", "血红蛋白"],
  ["plt", "血小板计数"],
  ["血小板", "血小板计数"],
  ["血小板数", "血小板计数"],
  ["血小板计数", "血小板计数"],
  ["glu", "空腹血糖"],
  ["glucose", "空腹血糖"],
  ["空腹血糖", "空腹血糖"],
  ["血糖", "空腹血糖"],
  ["tc", "总胆固醇"],
  ["总胆固醇", "总胆固醇"],
  ["胆固醇", "总胆固醇"],
  ["tg", "甘油三酯"],
  ["甘油三酯", "甘油三酯"],
  ["三酰甘油", "甘油三酯"],
  ["hdl", "高密度脂蛋白胆固醇"],
  ["hdl-c", "高密度脂蛋白胆固醇"],
  ["高密度脂蛋白", "高密度脂蛋白胆固醇"],
  ["高密度脂蛋白胆固醇", "高密度脂蛋白胆固醇"],
  ["ldl", "低密度脂蛋白胆固醇"],
  ["ldl-c", "低密度脂蛋白胆固醇"],
  ["低密度脂蛋白", "低密度脂蛋白胆固醇"],
  ["低密度脂蛋白胆固醇", "低密度脂蛋白胆固醇"],
  ["ua", "尿酸"],
  ["尿酸", "尿酸"],
  ["肌酐", "肌酐"],
  ["crea", "肌酐"],
  ["creatinine", "肌酐"],
  ["尿素氮", "尿素氮"],
  ["bun", "尿素氮"],
  ["alt", "丙氨酸氨基转移酶"],
  ["谷丙转氨酶", "丙氨酸氨基转移酶"],
  ["丙氨酸氨基转移酶", "丙氨酸氨基转移酶"],
  ["ast", "天门冬氨酸氨基转移酶"],
  ["谷草转氨酶", "天门冬氨酸氨基转移酶"],
  ["天门冬氨酸氨基转移酶", "天门冬氨酸氨基转移酶"],
  ["ggt", "γ-谷氨酰转肽酶"],
  ["γ谷氨酰转肽酶", "γ-谷氨酰转肽酶"],
  ["γ-谷氨酰转肽酶", "γ-谷氨酰转肽酶"],
  ["总胆红素", "总胆红素"],
  ["tbil", "总胆红素"]
].map(([key, value]) => [compactTrendKey(key), value]));

function normalizeTrendName(value: string) {
  const key = compactTrendKey(value);
  return trendNameAliases.get(key) || value.replace(/\s+/g, " ").trim();
}

function normalizeTrendUnit(value: string | null) {
  if (!value) return null;
  const unit = value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[／⁄]/g, "/")
    .replace(/[×xX*]/g, "×")
    .replace(/[μµ]/g, "μ");
  const lower = unit.toLocaleLowerCase();
  const aliases: Record<string, string> = {
    "mmol/l": "mmol/L",
    "μmol/l": "μmol/L",
    "umol/l": "μmol/L",
    "mg/dl": "mg/dL",
    "mg/l": "mg/L",
    "g/l": "g/L",
    "u/l": "U/L",
    "iu/l": "U/L",
    "iu/ml": "IU/mL",
    "kiu/l": "IU/mL",
    "10^9/l": "10^9/L",
    "10^12/l": "10^12/L",
    "×10^9/l": "10^9/L",
    "×10^12/l": "10^12/L"
  };
  return aliases[lower] || unit || null;
}

function inferTrendUnitFromResultText(value: string | null | undefined) {
  const normalized = (value || "")
    .normalize("NFKC")
    .trim()
    .replace(/(?:\s+[HL]|[↑↓]|偏高|偏低)\s*$/i, "");
  const match = normalized.match(/[-+]?\d+(?:\.\d+)?\s*([a-zA-Zμµ%][a-zA-Z0-9μµ%/^.×*·-]{0,23})$/);
  return match ? normalizeTrendUnit(match[1]) : null;
}

function firstObservationEvidence(value: string) {
  const entries = parseJson<Array<{ pageNumber?: unknown; quote?: unknown }>>(value, []);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const pageNumber = Math.max(1, Math.round(Number(entry.pageNumber || 0)));
    const quote = typeof entry.quote === "string" ? entry.quote.trim().slice(0, 300) : "";
    if (pageNumber) return { pageNumber, quote: quote || null };
  }
  return null;
}

function sourcePagesForTrendPoints(keys: Set<string>) {
  if (!keys.size) return new Map<string, {
    id: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  }>();
  const pairs = [...keys].flatMap((key) => {
    const separator = key.lastIndexOf(":");
    const reportId = key.slice(0, separator);
    const pageNumber = Number(key.slice(separator + 1));
    return reportId && Number.isFinite(pageNumber) ? [{ reportId, pageNumber }] : [];
  });
  if (!pairs.length) return new Map();
  const clauses = pairs.map(() => "(report_id = ? AND page_number = ?)").join(" OR ");
  const values = pairs.flatMap((pair) => [pair.reportId, pair.pageNumber]);
  const rows = getDatabase().prepare(`
    SELECT id, report_id AS reportId, page_number AS pageNumber, original_name AS originalName,
      mime_type AS mimeType, source_page_number AS sourcePageNumber
    FROM report_pages
    WHERE ${clauses}
  `).all(...values) as Array<{
    id: string;
    reportId: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  }>;
  return new Map(rows.map((row) => [`${row.reportId}:${row.pageNumber}`, {
    id: row.id,
    pageNumber: row.pageNumber,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sourcePageNumber: row.sourcePageNumber
  }]));
}

type TrendAttentionLevel = "abnormal" | "near_boundary";
type TrendAttentionBoundary = "upper" | "lower";

export function classifyTrendAttention(point: {
  numericValue: number;
  referenceLow: number | null;
  referenceHigh: number | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
}) {
  const rawLow = Number.isFinite(point.referenceLow) ? point.referenceLow : null;
  const rawHigh = Number.isFinite(point.referenceHigh) ? point.referenceHigh : null;
  const invalidRange = rawLow !== null && rawHigh !== null && rawHigh <= rawLow;
  const low = invalidRange ? null : rawLow;
  const high = invalidRange ? null : rawHigh;
  const below = low !== null && point.numericValue < low;
  const above = high !== null && point.numericValue > high;
  const explicitAbnormal = ["high", "low", "abnormal"].includes(point.abnormalFlag || "");
  if (explicitAbnormal) {
    const boundary: TrendAttentionBoundary | null = point.abnormalFlag === "high"
      ? "upper"
      : point.abnormalFlag === "low" ? "lower" : null;
    return {
      level: "abnormal" as TrendAttentionLevel,
      boundary,
      reason: point.abnormalFlag === "high"
        ? "原报告标记偏高"
        : point.abnormalFlag === "low" ? "原报告标记偏低" : "原报告标记异常",
      conflict: false
    };
  }
  if (invalidRange) {
    return { level: null, boundary: null, reason: null, conflict: true };
  }
  if (point.abnormalFlag === "normal" && (below || above)) {
    return {
      level: null,
      boundary: null,
      reason: null,
      conflict: true
    };
  }
  if (below || above) {
    return {
      level: "abnormal" as TrendAttentionLevel,
      boundary: above ? "upper" as TrendAttentionBoundary : "lower" as TrendAttentionBoundary,
      reason: above ? "数值高于报告参考上限" : "数值低于报告参考下限",
      conflict: false
    };
  }

  let boundary: TrendAttentionBoundary | null = null;
  if (low !== null && high !== null && high > low && point.numericValue >= low && point.numericValue <= high) {
    const span = high - low;
    const lowerDistance = (point.numericValue - low) / span;
    const upperDistance = (high - point.numericValue) / span;
    if (Math.min(lowerDistance, upperDistance) <= 0.1) {
      boundary = lowerDistance <= upperDistance ? "lower" : "upper";
    }
  } else if (high !== null && high !== 0 && point.numericValue <= high) {
    if ((high - point.numericValue) / Math.abs(high) <= 0.1) boundary = "upper";
  } else if (low !== null && low !== 0 && point.numericValue >= low) {
    if ((point.numericValue - low) / Math.abs(low) <= 0.1) boundary = "lower";
  }
  return boundary
    ? {
        level: "near_boundary" as TrendAttentionLevel,
        boundary,
        reason: boundary === "upper" ? "本次结果接近报告参考上限" : "本次结果接近报告参考下限",
        conflict: false
      }
    : { level: null, boundary: null, reason: null, conflict: false };
}

function trustedTrendAliases() {
  const rows = getDatabase().prepare(`
    SELECT c.canonical_key AS canonicalKey, a.alias_name AS aliasName
    FROM indicator_aliases a
    JOIN indicator_catalog c ON c.id = a.indicator_id
    WHERE a.enabled = 1
      AND a.source IN ('builtin', 'user')
      AND a.confidence >= 0.9
    ORDER BY c.canonical_key, a.alias_name
  `).all() as Array<{ canonicalKey: string; aliasName: string }>;
  const aliases = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!aliases.has(row.canonicalKey)) aliases.set(row.canonicalKey, new Set());
    aliases.get(row.canonicalKey)!.add(row.aliasName);
  }
  return aliases;
}

function placementVoteKey(value: TrendPlacement) {
  return `${value.groupKey}\u0000${value.subgroupKey || ""}`;
}

function activeTrendCatalog() {
  ensureBuiltinIndicatorCatalog();
  const rows = getDatabase().prepare(`
    SELECT catalog.canonical_key AS canonicalKey, catalog.category,
      catalog.explanation, catalog.item_order AS itemOrder,
      category.group_key AS groupKey, groups.name AS groupName,
      groups.item_order AS groupOrder, category.subgroup_key AS subgroupKey,
      subgroups.name AS subgroupName, subgroups.item_order AS subgroupOrder
    FROM indicator_catalog catalog
    JOIN indicator_taxonomy_categories category ON category.category_key = catalog.category_key
    JOIN indicator_taxonomy_groups groups ON groups.group_key = category.group_key
    LEFT JOIN indicator_taxonomy_subgroups subgroups ON subgroups.subgroup_key = category.subgroup_key
    WHERE catalog.source = 'builtin' AND catalog.trend_enabled = 1
  `).all() as Array<{
    canonicalKey: string;
    category: string;
    explanation: string | null;
    itemOrder: number | null;
    groupKey: string;
    groupName: string;
    groupOrder: number;
    subgroupKey: string | null;
    subgroupName: string | null;
    subgroupOrder: number | null;
  }>;
  return new Map(rows.map((row) => [row.canonicalKey, {
    category: row.category,
    explanation: row.explanation,
    itemOrder: row.itemOrder ?? 9999,
    placement: {
      groupKey: row.groupKey,
      groupName: row.groupName,
      groupOrder: row.groupOrder,
      subgroupKey: row.subgroupKey,
      subgroupName: row.subgroupName,
      subgroupOrder: row.subgroupOrder ?? 9999
    } satisfies TrendPlacement
  }]));
}

export function listTrendSeries(user: RequestUser, memberId?: string) {
  if (!user.authenticated) return [];
  if (memberId) assertMemberAccess(user, memberId);
  const trendCatalog = activeTrendCatalog();
  const pinnedKeys = memberId
    ? new Set((getDatabase().prepare(`
        SELECT indicator_key AS indicatorKey, unit_key AS unitKey
        FROM user_trend_pins
        WHERE user_id = ? AND member_id = ?
      `).all(user.id, memberId) as Array<{ indicatorKey: string; unitKey: string }>)
        .map((row) => `${row.indicatorKey}\u0000${row.unitKey}`))
    : new Set<string>();
  const rows = getDatabase().prepare(`
    SELECT
      o.id AS observationId,
      COALESCE(NULLIF(TRIM(o.normalized_name), ''), o.item_name) AS name,
      o.item_name AS itemName,
      o.section_name AS sectionName,
      o.unit,
      o.result_text AS resultText,
      o.numeric_value AS numericValue,
      o.reference_low AS referenceLow,
      o.reference_high AS referenceHigh,
      o.reference_text AS referenceText,
      o.abnormal_flag AS abnormalFlag,
      o.evidence_json AS evidenceJson,
      n.canonical_key AS canonicalKey,
      n.canonical_name AS canonicalName,
      n.canonical_value AS canonicalValue,
      n.canonical_unit AS canonicalUnit,
      n.canonical_category AS normalizationCategory,
      n.canonical_explanation AS normalizationExplanation,
      n.quality AS normalizationQuality,
      n.confidence AS normalizationConfidence,
      n.match_reason AS normalizationReason,
      n.excluded_reason AS normalizationExcludedReason,
      c.category AS catalogCategory,
      c.explanation AS catalogExplanation,
      r.id AS reportId,
      r.title AS reportTitle,
      r.report_type AS reportType,
      r.status AS reportStatus,
      r.report_issued_at AS reportIssuedAt,
      COALESCE(r.report_issued_at, r.created_at) AS sortDate,
      r.hospital_name_raw AS hospitalName
    FROM observations o
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    LEFT JOIN indicator_catalog c ON c.id = n.indicator_id
    JOIN reports r ON r.id = o.report_id
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE COALESCE(NULLIF(TRIM(o.normalized_name), ''), NULLIF(TRIM(o.item_name), '')) IS NOT NULL
      AND r.status IN ('needs_review', 'ready')
      AND (? IS NULL OR r.member_id = ?)
    ORDER BY COALESCE(r.report_issued_at, r.created_at), r.id, o.id
  `).all(user.id, memberId || null, memberId || null) as Array<{
    observationId: string;
    name: string;
    itemName: string;
    sectionName: string | null;
    unit: string | null;
    resultText: string;
    numericValue: number | null;
    referenceLow: number | null;
    referenceHigh: number | null;
    referenceText: string | null;
    abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
    evidenceJson: string;
    canonicalKey: string | null;
    canonicalName: string | null;
    canonicalValue: number | null;
    canonicalUnit: string | null;
    normalizationCategory: string | null;
    normalizationExplanation: string | null;
    normalizationQuality: "high" | "medium" | "low" | "excluded" | null;
    normalizationConfidence: number | null;
    normalizationReason: string | null;
    normalizationExcludedReason: string | null;
    catalogCategory: string | null;
    catalogExplanation: string | null;
    reportId: string;
    reportTitle: string;
    reportType: string;
    reportStatus: string;
    reportIssuedAt: string | null;
    sortDate: string | null;
    hospitalName: string | null;
  }>;

  const enrichedRows = rows.map((row) => {
    const numericValue = row.numericValue ?? parseNumericResultText(row.resultText);
    const usesCanonical = Boolean(row.canonicalKey && row.normalizationQuality && ["high", "medium"].includes(row.normalizationQuality));
    const evidence = firstObservationEvidence(row.evidenceJson);
    const rawTrendUnit = normalizeTrendUnit(row.unit) || inferTrendUnitFromResultText(row.resultText);
    return {
      ...row,
      abnormalFlag: displayAbnormalFlag(row.abnormalFlag, row.resultText, evidence?.quote || null),
      parsedNumericValue: numericValue,
      trendNumericValue: numericValue === null ? null : usesCanonical ? (row.canonicalValue ?? numericValue) : numericValue,
      trendName: usesCanonical ? row.canonicalName! : normalizeTrendName(row.name),
      trendUnit: usesCanonical ? row.canonicalUnit : rawTrendUnit,
      trendKey: usesCanonical ? row.canonicalKey! : normalizeTrendName(row.name),
      trendQuality: usesCanonical ? row.normalizationQuality! : "raw",
      trendConfidence: usesCanonical ? row.normalizationConfidence : null,
      trendReason: usesCanonical ? row.normalizationReason : "未归一化，按原始名称和单位保守展示",
      trendCategory: usesCanonical ? (row.normalizationCategory || row.catalogCategory) : null,
      trendExplanation: usesCanonical ? (row.normalizationExplanation || row.catalogExplanation) : null,
      trendReferenceLow: numericValue === null || row.referenceLow === null
        ? null
        : usesCanonical
          ? convertUnit(row.canonicalKey!, row.referenceLow, normalizeTrendUnit(row.unit), row.canonicalUnit)
          : row.referenceLow,
      trendReferenceHigh: numericValue === null || row.referenceHigh === null
        ? null
        : usesCanonical
          ? convertUnit(row.canonicalKey!, row.referenceHigh, normalizeTrendUnit(row.unit), row.canonicalUnit)
          : row.referenceHigh,
      evidencePageNumber: evidence?.pageNumber || null,
      evidenceQuote: evidence?.quote || null
    };
  });
  const pointsWithEvidence = enrichedRows.filter((row) => {
    if (row.trendNumericValue === null) return false;
    return !(row.canonicalKey && row.normalizationQuality && ["low", "excluded"].includes(row.normalizationQuality));
  });
  const excludedRows = enrichedRows.filter((row) =>
    Boolean(row.canonicalKey && row.canonicalName && row.normalizationQuality && ["low", "excluded"].includes(row.normalizationQuality))
  );
  const pageKeys = new Set(
    [...pointsWithEvidence, ...excludedRows]
      .filter((row) => row.evidencePageNumber)
      .map((row) => `${row.reportId}:${row.evidencePageNumber}`)
  );
  const sourcePages = sourcePagesForTrendPoints(pageKeys);
  const trustedAliases = trustedTrendAliases();
  const excludedByKey = new Map<string, Array<{
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
  }>>();
  for (const row of excludedRows) {
    const key = `${row.canonicalKey}\u0000${row.canonicalUnit || normalizeTrendUnit(row.unit) || ""}`;
    const sourcePage = row.evidencePageNumber
      ? sourcePages.get(`${row.reportId}:${row.evidencePageNumber}`) || null
      : null;
    if (!excludedByKey.has(key)) excludedByKey.set(key, []);
    excludedByKey.get(key)!.push({
      observationId: row.observationId,
      reportId: row.reportId,
      reportTitle: row.reportTitle,
      reportIssuedAt: row.reportIssuedAt,
      hospitalName: row.hospitalName,
      itemName: row.itemName,
      resultText: row.resultText,
      numericValue: row.parsedNumericValue,
      unit: row.unit,
      reason: row.normalizationExcludedReason || row.normalizationReason || "趋势质量不足，未纳入默认趋势",
      quality: row.normalizationQuality as "low" | "excluded",
      evidenceQuote: row.evidenceQuote,
      sourcePage
    });
  }
  const groups = new Map<string, {
    indicatorKey: string;
    name: string;
    unit: string | null;
    sectionName: string | null;
    quality: string;
    confidence: number | null;
    explanation: string | null;
    explanationConfidence: number;
    fixedPlacement: TrendPlacement | null;
    placementVotes: Map<string, { placement: TrendPlacement; count: number; maxConfidence: number }>;
    itemOrder: number;
    matchReasons: Set<string>;
    rawNames: Set<string>;
    excludedPoints: Array<{
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
    }>;
    points: Array<{
      observationId: string;
      reportId: string;
      reportTitle: string;
      reportType: string;
      reportStatus: string;
      reportIssuedAt: string | null;
      sortDate: string | null;
      hospitalName: string | null;
      itemName: string;
      resultText: string;
      numericValue: number;
      referenceLow: number | null;
      referenceHigh: number | null;
      referenceText: string | null;
      abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
      evidenceQuote: string | null;
      normalizationQuality: string | null;
      normalizationConfidence: number | null;
      normalizationReason: string | null;
      sourcePage: {
        id: string;
        pageNumber: number;
        originalName: string;
        mimeType: string;
        sourcePageNumber: number | null;
      } | null;
    }>;
  }>();
  for (const row of pointsWithEvidence) {
    const key = `${row.trendKey}\u0000${row.trendUnit || ""}`;
    const builtin = trendCatalog.get(row.trendKey) || null;
    const rowPlacement = trendPlacementFor({
      category: builtin?.category || row.trendCategory,
      sectionName: row.sectionName,
      reportType: row.reportType
    });
    if (!groups.has(key)) {
      groups.set(key, {
        indicatorKey: row.trendKey,
        name: row.trendName,
        unit: row.trendUnit,
        sectionName: row.sectionName,
        quality: row.trendQuality,
        confidence: row.trendConfidence,
        explanation: builtin?.explanation || row.trendExplanation,
        explanationConfidence: builtin ? 1 : Number(row.trendConfidence || 0),
        fixedPlacement: builtin?.placement || null,
        placementVotes: new Map(),
        itemOrder: builtin?.itemOrder ?? 9999,
        matchReasons: new Set(),
        rawNames: new Set(),
        excludedPoints: excludedByKey.get(key) || [],
        points: []
      });
    }
    const group = groups.get(key)!;
    const voteKey = placementVoteKey(rowPlacement);
    const existingVote = group.placementVotes.get(voteKey);
    if (existingVote) {
      existingVote.count += 1;
      existingVote.maxConfidence = Math.max(existingVote.maxConfidence, Number(row.trendConfidence || 0));
    } else {
      group.placementVotes.set(voteKey, {
        placement: rowPlacement,
        count: 1,
        maxConfidence: Number(row.trendConfidence || 0)
      });
    }
    if (!builtin && row.trendExplanation && Number(row.trendConfidence || 0) > group.explanationConfidence) {
      group.explanation = row.trendExplanation;
      group.explanationConfidence = Number(row.trendConfidence || 0);
    }
    if (row.trendReason) group.matchReasons.add(row.trendReason);
    group.rawNames.add(row.itemName);
    const sourcePage = row.evidencePageNumber
      ? sourcePages.get(`${row.reportId}:${row.evidencePageNumber}`) || null
      : null;
    group.points.push({
      observationId: row.observationId,
      reportId: row.reportId,
      reportTitle: row.reportTitle,
      reportType: row.reportType,
      reportStatus: row.reportStatus,
      reportIssuedAt: row.reportIssuedAt,
      sortDate: row.sortDate,
      hospitalName: row.hospitalName,
      itemName: row.itemName,
      resultText: row.resultText,
      numericValue: row.trendNumericValue!,
      referenceLow: row.trendReferenceLow,
      referenceHigh: row.trendReferenceHigh,
      referenceText: row.referenceText,
      abnormalFlag: row.abnormalFlag,
      evidenceQuote: row.evidenceQuote,
      normalizationQuality: row.normalizationQuality,
      normalizationConfidence: row.normalizationConfidence,
      normalizationReason: row.trendReason,
      sourcePage
    });
  }

  const reportOverlapCache = new Map<string, boolean>();
  const reportFileSignatureCache = new Map<string, string | null>();
  const cachedReportFileSignature = (reportId: string) => {
    if (reportFileSignatureCache.has(reportId)) return reportFileSignatureCache.get(reportId) || null;
    const signature = reportFileSignature(reportId);
    reportFileSignatureCache.set(reportId, signature);
    return signature;
  };
  const hasSameUploadedOriginal = (leftReportId: string, rightReportId: string) => {
    const left = cachedReportFileSignature(leftReportId);
    return Boolean(left && left === cachedReportFileSignature(rightReportId));
  };
  const hasStrongReportOverlap = (leftReportId: string, rightReportId: string) => {
    const key = [leftReportId, rightReportId].sort().join("\u0000");
    const cached = reportOverlapCache.get(key);
    if (cached !== undefined) return cached;
    const matched = hasStrongObservationOverlap(sharedObservationStats(leftReportId, rightReportId));
    reportOverlapCache.set(key, matched);
    return matched;
  };

  return Array.from(groups.values()).map((group) => {
    /* 去重保留优先级：已归档 > 归一化质量高 > 报告 ID 字典序 */
    const qualityRank = (quality: string | null) => ({ high: 0, medium: 1, low: 2 }[quality || ""] ?? 3);
    const sortedPoints = group.points.sort((left, right) =>
      String(left.sortDate || "").localeCompare(String(right.sortDate || ""))
      || (left.reportStatus === "ready" ? 0 : 1) - (right.reportStatus === "ready" ? 0 : 1)
      || qualityRank(left.normalizationQuality) - qualityRank(right.normalizationQuality)
      || left.reportId.localeCompare(right.reportId)
      || left.observationId.localeCompare(right.observationId)
    );
    /* 同一报告重复上传（归档/待确认多份并存）时只保留一份。
       医院原文相同沿用原有精确规则；名称仅近似时，必须再有同类型和报告级强指标重合，
       避免把同日、同机构、数值偶然相同的不同检查误删。 */
    const points = sortedPoints.filter((point, index) => !sortedPoints.some((other, otherIndex) =>
      otherIndex < index
      && other.reportId !== point.reportId
      && other.numericValue === point.numericValue
      && Boolean(datePart(point.reportIssuedAt))
      && datePart(other.reportIssuedAt) === datePart(point.reportIssuedAt)
      && (
        hasSameUploadedOriginal(other.reportId, point.reportId)
        ||
        (
          normalizeContentKey(other.hospitalName) === normalizeContentKey(point.hospitalName)
          && other.itemName === point.itemName
        )
        || (
          hospitalNamesEquivalent(other.hospitalName, point.hospitalName)
          && other.reportType === point.reportType
          && hasStrongReportOverlap(other.reportId, point.reportId)
        )
      )
    ));
    const values = points.map((point) => point.numericValue);
    const latest = points.at(-1) || null;
    const previous = points.length > 1 ? points.at(-2) || null : null;
    const placement = group.fixedPlacement || [...group.placementVotes.values()]
      .sort((left, right) =>
        right.count - left.count
        || right.maxConfidence - left.maxConfidence
        || left.placement.groupOrder - right.placement.groupOrder
        || left.placement.subgroupOrder - right.placement.subgroupOrder
      )[0]?.placement || trendPlacementFor({});
    const attention = latest
      ? classifyTrendAttention({
          numericValue: latest.numericValue,
          referenceLow: latest.referenceLow,
          referenceHigh: latest.referenceHigh,
          abnormalFlag: latest.abnormalFlag
        })
      : { level: null, boundary: null, reason: null, conflict: false };
    return {
      indicatorKey: group.indicatorKey,
      name: group.name,
      unit: group.unit,
      pinned: pinnedKeys.has(`${group.indicatorKey}\u0000${group.unit || ""}`),
      groupKey: placement.groupKey,
      groupName: placement.groupName,
      groupOrder: placement.groupOrder,
      subgroupKey: placement.subgroupKey,
      subgroupName: placement.subgroupName,
      subgroupOrder: placement.subgroupOrder,
      itemOrder: group.itemOrder,
      sectionName: group.sectionName,
      quality: group.quality,
      confidence: group.confidence,
      explanation: group.explanation,
      searchAliases: [...(trustedAliases.get(group.indicatorKey) || [])]
        .filter((alias) => alias !== group.name)
        .slice(0, 20),
      attentionLevel: attention.level,
      attentionReason: attention.reason,
      attentionBoundary: attention.boundary,
      attentionConflict: attention.conflict,
      matchReasons: [...group.matchReasons].slice(0, 3),
      sourceNames: [...group.rawNames].slice(0, 8),
      excludedPoints: group.excludedPoints
        .sort((left, right) => String(right.reportIssuedAt || "").localeCompare(String(left.reportIssuedAt || "")))
        .slice(0, 8),
      pointCount: points.length,
      firstDate: points[0]?.reportIssuedAt || null,
      lastDate: latest?.reportIssuedAt || null,
      latestValue: latest?.numericValue ?? null,
      previousValue: previous?.numericValue ?? null,
      delta: latest && previous ? latest.numericValue - previous.numericValue : null,
      minValue: values.length ? Math.min(...values) : null,
      maxValue: values.length ? Math.max(...values) : null,
      points: points.map(({ sortDate, reportType, ...point }) => point)
    };
  }).sort((left, right) =>
    Number(right.pinned) - Number(left.pinned)
    || left.groupOrder - right.groupOrder
    || left.subgroupOrder - right.subgroupOrder
    || left.itemOrder - right.itemOrder
    || left.name.localeCompare(right.name, "zh-CN")
    || String(left.unit || "").localeCompare(String(right.unit || ""), "zh-CN")
  );
}

export function updateTrendPin(
  user: RequestUser,
  input: { memberId?: unknown; indicatorKey?: unknown; unit?: unknown },
  pinned: boolean
) {
  const memberId = textInput(input.memberId, 80);
  const indicatorKey = textInput(input.indicatorKey, 180);
  const unitKey = textInput(input.unit, 60) || "";
  if (!memberId || !indicatorKey) {
    throw createError({ statusCode: 400, statusMessage: "指标置顶参数不完整" });
  }
  assertMemberAccess(user, memberId);
  if (pinned) {
    const exists = listTrendSeries(user, memberId).some((series) =>
      series.indicatorKey === indicatorKey && (series.unit || "") === unitKey
    );
    if (!exists) throw createError({ statusCode: 404, statusMessage: "指标趋势不存在或已发生变化" });
    getDatabase().prepare(`
      INSERT INTO user_trend_pins (user_id, member_id, indicator_key, unit_key)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, member_id, indicator_key, unit_key) DO UPDATE SET
        updated_at = CURRENT_TIMESTAMP
    `).run(user.id, memberId, indicatorKey, unitKey);
  } else {
    getDatabase().prepare(`
      DELETE FROM user_trend_pins
      WHERE user_id = ? AND member_id = ? AND indicator_key = ? AND unit_key = ?
    `).run(user.id, memberId, indicatorKey, unitKey);
  }
  return { memberId, indicatorKey, unit: unitKey || null, pinned };
}

export function listReminders(user: RequestUser, memberId?: string) {
  if (!user.authenticated) return [];
  if (memberId) assertMemberAccess(user, memberId);
  return getDatabase().prepare(`
    SELECT re.id, re.member_id AS memberId, CASE WHEN r.id IS NULL THEN NULL ELSE re.report_id END AS reportId, re.title,
      re.due_at AS dueAt, re.status, re.source,
      r.title AS reportTitle, r.hospital_name_raw AS reportHospitalName,
      r.report_issued_at AS reportIssuedAt
    FROM reminders re
    JOIN member_permissions mp ON mp.member_id = re.member_id AND mp.user_id = ?
    LEFT JOIN reports r ON r.id = re.report_id AND r.status <> 'trashed'
    WHERE (? IS NULL OR re.member_id = ?)
    ORDER BY re.status = 'pending' DESC, re.due_at
  `).all(user.id, memberId || null, memberId || null);
}

export function createReminder(user: RequestUser, input: Record<string, unknown>) {
  const memberId = textInput(input.memberId, 80);
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "请选择提醒所属成员" });
  assertMemberManage(user, memberId);
  const title = textInput(input.title, 180);
  const dueAt = dateInput(input.dueAt);
  if (!title || !dueAt) throw createError({ statusCode: 400, statusMessage: "请填写提醒标题和日期" });
  const reportId = textInput(input.reportId, 80);
  if (reportId) {
    const report = getDatabase().prepare("SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'")
      .get(reportId) as { memberId: string } | undefined;
    if (!report || report.memberId !== memberId) throw createError({ statusCode: 400, statusMessage: "关联报告无效" });
  }
  const id = createId("reminder");
  getDatabase().prepare(`
    INSERT INTO reminders (id, member_id, report_id, title, due_at, source, created_by)
    VALUES (?, ?, ?, ?, ?, 'manual', ?)
  `).run(id, memberId, reportId, title, dueAt, user.id);
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'reminder.create', 'reminder', ?, ?)
  `).run(createId("audit"), user.id, id, JSON.stringify({ memberId, reportId }));
  return { id, memberId, reportId, title, dueAt, status: "pending", source: "manual" };
}

export function updateReminderStatus(user: RequestUser, reminderId: string, status: string) {
  if (!["pending", "completed", "dismissed"].includes(status)) throw createError({ statusCode: 400, statusMessage: "提醒状态无效" });
  const reminder = getDatabase().prepare("SELECT member_id AS memberId FROM reminders WHERE id = ?")
    .get(reminderId) as { memberId: string } | undefined;
  if (!reminder) throw createError({ statusCode: 404, statusMessage: "提醒不存在" });
  assertMemberManage(user, reminder.memberId);
  getDatabase().prepare("UPDATE reminders SET status = ?, confirmed_at = CASE WHEN ? = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END WHERE id = ?")
    .run(status, status, reminderId);
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'reminder.status', 'reminder', ?, ?)
  `).run(createId("audit"), user.id, reminderId, JSON.stringify({ status, memberId: reminder.memberId }));
  return { id: reminderId, status };
}

export function listAppNotifications(user: RequestUser, memberId?: string) {
  if (!user.authenticated) return [];
  if (memberId) assertMemberAccess(user, memberId);
  return getDatabase().prepare(`
    SELECT n.id, n.member_id AS memberId, n.report_id AS reportId, n.type, n.title,
      n.message, n.severity, n.status, n.created_at AS createdAt, n.read_at AS readAt,
      r.title AS reportTitle
    FROM app_notifications n
    JOIN member_permissions mp ON mp.member_id = n.member_id AND mp.user_id = ?
    LEFT JOIN reports r ON r.id = n.report_id
    WHERE n.status <> 'archived'
      AND (? IS NULL OR n.member_id = ?)
    ORDER BY n.status = 'unread' DESC, n.created_at DESC, n.id DESC
    LIMIT 100
  `).all(user.id, memberId || null, memberId || null);
}

export function updateAppNotificationStatus(user: RequestUser, notificationId: string, status: string) {
  if (!["unread", "read", "archived"].includes(status)) throw createError({ statusCode: 400, statusMessage: "通知状态无效" });
  const notification = getDatabase().prepare("SELECT member_id AS memberId FROM app_notifications WHERE id = ?")
    .get(notificationId) as { memberId: string } | undefined;
  if (!notification) throw createError({ statusCode: 404, statusMessage: "通知不存在" });
  assertMemberAccess(user, notification.memberId);
  getDatabase().prepare(`
    UPDATE app_notifications
    SET status = ?, read_at = CASE WHEN ? = 'unread' THEN NULL ELSE COALESCE(read_at, CURRENT_TIMESTAMP) END
    WHERE id = ?
  `).run(status, status, notificationId);
  return { id: notificationId, status };
}

function recommendationDueDate(reportIssuedAt: string | null, recommendation: string) {
  const explicit = recommendation.match(/(20\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/);
  if (explicit) {
    const [, year, month, day] = explicit;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const months = recommendation.match(/(\d{1,2})\s*个?月(?:后|内)?/);
  const days = recommendation.match(/(\d{1,3})\s*天(?:后|内)?/);
  const base = new Date(`${datePart(reportIssuedAt) || new Date().toISOString().slice(0, 10)}T00:00:00`);
  if (months) base.setMonth(base.getMonth() + Number(months[1]));
  else if (days) base.setDate(base.getDate() + Number(days[1]));
  else base.setMonth(base.getMonth() + 3);
  return base.toISOString().slice(0, 10);
}

function createReportSuggestionReminder(user: RequestUser, reportId: string) {
  const report = getDatabase().prepare(`
    SELECT member_id AS memberId, title, recommendation, report_issued_at AS reportIssuedAt
    FROM reports WHERE id = ? AND status <> 'trashed'
  `).get(reportId) as { memberId: string; title: string; recommendation: string | null; reportIssuedAt: string | null } | undefined;
  if (!report?.recommendation) return null;
  const existing = getDatabase().prepare("SELECT id FROM reminders WHERE report_id = ? AND source = 'report_suggestion'")
    .get(reportId) as { id: string } | undefined;
  if (existing) return existing;
  const id = createId("reminder");
  getDatabase().prepare(`
    INSERT INTO reminders (id, member_id, report_id, title, due_at, source, created_by)
    VALUES (?, ?, ?, ?, ?, 'report_suggestion', ?)
  `).run(id, report.memberId, reportId, `${report.title}：复查提醒`, recommendationDueDate(report.reportIssuedAt, report.recommendation), user.id);
  return { id };
}

export function listAuditLogs(user: RequestUser, limit = 80) {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看审计日志" });
  const rows = getDatabase().prepare(`
    SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
      u.display_name AS actorName, a.detail_json AS detailJson, a.created_at AS createdAt
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ?
  `).all(Math.min(200, Math.max(1, Math.round(limit)))) as Array<{
    id: string; action: string; targetType: string | null; targetId: string | null;
    actorName: string | null; detailJson: string; createdAt: string;
  }>;
  return rows.map((item) => ({ ...item, detail: parseJson(item.detailJson, {}), detailJson: undefined }));
}

type AuditCursor = { createdAt: string; id: string };

function encodeAuditCursor(row: AuditCursor) {
  return Buffer.from(`${row.createdAt}|${row.id}`).toString("base64url");
}

function decodeAuditCursor(value?: string): AuditCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator < 0) return null;
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

const auditActionTitles: Record<string, string> = {
  "report.upload": "上传报告",
  "report.confirm_ready": "确认归档报告",
  "report.trash": "移入回收站",
  "report.restore": "恢复报告",
  "report.purge": "永久删除报告",
  "report.merge_duplicate": "合并重复报告",
  "report.reprocess_ocr_ai": "重新识别报告",
  "report.manual_update": "校对报告字段",
  "report.pages.update": "调整报告页面",
  "report.page.delete": "删除报告页面",
  "reminder.create": "创建提醒",
  "reminder.status": "更新提醒状态",
  "member.create": "新增家庭成员",
  "member.update": "更新成员资料",
  "member.delete": "删除成员",
  "member.permission.update": "更新成员授权",
  "member.permission.remove": "移除成员授权",
  "backup.create": "创建完整备份",
  "backup.restore": "恢复完整备份",
  "backup.identity_rebind": "接管恢复数据权限",
  "backup.delete": "删除完整备份",
  "maintenance.regenerate_report_titles": "批量清理报告标题",
  "maintenance.regenerate_pdf_previews": "重新生成 PDF 单页图",
  "maintenance.normalize_indicators": "重新归一化历史指标",
  "maintenance.rebuild_morphology_tracking": "重新关联历史形态发现",
  "morphology.update": "校对形态发现",
  "morphology.link": "关联形态变化",
  "morphology.separate": "建立独立形态变化",
  "morphology.ignore": "忽略形态误提取",
  "morphology.merge": "合并形态变化线",
  "morphology.split": "拆分形态变化线",
  "clinical_fact.create": "新增报告分类信息",
  "clinical_fact.update": "校对报告分类信息",
  "clinical_fact.delete": "删除报告分类信息",
  "report_structured_section.create": "新增报告专属内容",
  "report_structured_section.update": "校对报告专属内容",
  "report_structured_section.delete": "删除报告专属内容",
  "system.logs_clear": "清理系统日志",
  "system.diagnostics_export": "导出系统诊断包",
  "dictionary.update": "更新指标字典",
  "dictionary.rollback": "回滚指标字典",
};

const auditTargetLabels: Record<string, string> = {
  report: "报告",
  report_page: "报告页面",
  reminder: "提醒",
  health_member: "家庭成员",
  member: "家庭成员",
  backup: "备份",
  observation: "指标",
  morphology_finding: "形态发现",
  clinical_fact: "报告分类信息",
  report_structured_section: "报告专属内容",
  system_log: "系统日志",
  indicator_dictionary: "指标字典",
  user: "用户账号",
};

/** 审计 detail 中的状态值统一翻译成中文，覆盖提醒/通知/报告三类状态 */
const auditStatusLabels: Record<string, string> = {
  pending: "待处理",
  completed: "已完成",
  dismissed: "已忽略",
  unread: "未读",
  archived: "已归档",
  uploading: "上传中",
  queued: "排队中",
  processing: "处理中",
  needs_review: "待确认",
  ready: "已归档",
  failed: "识别失败",
  trashed: "回收站",
};

function shortAuditId(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function collectAuditReferenceIds(rows: Array<{ targetType: string | null; targetId: string | null; detailJson: string }>) {
  const userIds = new Set<string>();
  const memberIds = new Set<string>();
  const reportIds = new Set<string>();
  const pageIds = new Set<string>();
  const reminderIds = new Set<string>();
  const morphologyFindingIds = new Set<string>();
  const backupIds = new Set<string>();
  for (const row of rows) {
    const detail = parseJson<Record<string, unknown>>(row.detailJson, {});
    if (row.targetId) {
      if (row.targetType === "report") reportIds.add(row.targetId);
      else if (row.targetType === "report_page") pageIds.add(row.targetId);
      else if (row.targetType === "health_member" || row.targetType === "member") memberIds.add(row.targetId);
      else if (row.targetType === "reminder") reminderIds.add(row.targetId);
      else if (row.targetType === "morphology_finding") morphologyFindingIds.add(row.targetId);
      else if (row.targetType === "backup") backupIds.add(row.targetId);
      else if (row.targetType === "user") userIds.add(row.targetId);
    }
    if (typeof detail.userId === "string") userIds.add(detail.userId);
    for (const key of ["memberId"] as const) {
      if (typeof detail[key] === "string") memberIds.add(detail[key]);
    }
    for (const key of ["reportId", "sourceReportId", "targetReportId"] as const) {
      if (typeof detail[key] === "string") reportIds.add(detail[key]);
    }
    if (typeof detail.reminderId === "string") reminderIds.add(detail.reminderId);
  }
  return { userIds, memberIds, reportIds, pageIds, reminderIds, morphologyFindingIds, backupIds };
}

function rowsById<T extends { id: string }>(
  table: "users" | "health_members" | "reports" | "reminders" | "morphology_findings",
  ids: Set<string>,
  select: string
) {
  if (!ids.size) return new Map<string, T>();
  const placeholders = [...ids].map(() => "?").join(",");
  const rows = getDatabase().prepare(`SELECT ${select} FROM ${table} WHERE id IN (${placeholders})`).all(...ids) as T[];
  return new Map(rows.map((row) => [row.id, row]));
}

function reportPagesById(ids: Set<string>) {
  if (!ids.size) return new Map<string, { id: string; reportTitle: string; pageNumber: number }>();
  const placeholders = [...ids].map(() => "?").join(",");
  const rows = getDatabase().prepare(`
    SELECT p.id, r.title AS reportTitle, p.page_number AS pageNumber
    FROM report_pages p
    JOIN reports r ON r.id = p.report_id
    WHERE p.id IN (${placeholders})
  `).all(...ids) as Array<{ id: string; reportTitle: string; pageNumber: number }>;
  return new Map(rows.map((row) => [row.id, row]));
}

function userAuditDescription(
  action: string,
  detail: Record<string, unknown>,
  names: {
    users: Map<string, { id: string; displayName: string }>;
    members: Map<string, { id: string; displayName: string }>;
    reports: Map<string, { id: string; title: string }>;
    reminders: Map<string, { id: string; title: string }>;
  }
) {
  const memberName = (id: string) => names.members.get(id)?.displayName || shortAuditId(id);
  const reportName = (id: string) => names.reports.get(id)?.title || shortAuditId(id);
  const reminderName = (id: string) => names.reminders.get(id)?.title || shortAuditId(id);
  const parts: string[] = [];
  if (typeof detail.memberId === "string") parts.push(`成员 ${memberName(detail.memberId)}`);
  if (typeof detail.reportId === "string") parts.push(`报告 ${reportName(detail.reportId)}`);
  if (typeof detail.sourceReportId === "string") parts.push(`来源 ${reportName(detail.sourceReportId)}`);
  if (typeof detail.targetReportId === "string") parts.push(`目标 ${reportName(detail.targetReportId)}`);
  if (typeof detail.reminderId === "string") parts.push(`提醒 ${reminderName(detail.reminderId)}`);
  if (typeof detail.filename === "string") parts.push(`文件 ${detail.filename}`);
  if (typeof detail.fileCount === "number") parts.push(`${detail.fileCount} 个文件`);
  if (typeof detail.pageCount === "number") parts.push(`${detail.pageCount} 页`);
  if (typeof detail.queuedOcr === "number") parts.push(`重新 OCR ${detail.queuedOcr} 页`);
  if (typeof detail.movedPages === "number") parts.push(`合并 ${detail.movedPages} 页`);
  if (typeof detail.reportCount === "number") parts.push(`${detail.reportCount} 份报告`);
  if (typeof detail.memberCount === "number") parts.push(`${detail.memberCount} 位成员`);
  if (typeof detail.deletedFiles === "number") parts.push(`清理 ${detail.deletedFiles} 个日志文件`);
  if (typeof detail.freedBytes === "number") {
    const freed = detail.freedBytes < 1024 * 1024
      ? `${Math.round(detail.freedBytes / 1024)} KB`
      : `${(detail.freedBytes / 1024 / 1024).toFixed(1)} MB`;
    parts.push(`释放 ${freed}`);
  }
  if (typeof detail.safetyBackupId === "string") parts.push(`安全备份 ${shortAuditId(detail.safetyBackupId)}`);
  if (typeof detail.updated === "number") parts.push(`更新 ${detail.updated} 条`);
  if (action.startsWith("dictionary.")) {
    if (detail.layer === "core") parts.push("内置字典");
    else if (detail.layer === "remote") parts.push("远程字典");
    if (typeof detail.revision === "number") parts.push(`版本 ${detail.revision}`);
    if (typeof detail.indicators === "number") parts.push(`${detail.indicators} 个指标`);
    if (typeof detail.aliases === "number") parts.push(`${detail.aliases} 个别名`);
  }
  if (typeof detail.status === "string") parts.push(`状态 ${auditStatusLabels[detail.status] || "未知状态"}`);
  if (typeof detail.factType === "string") {
    const labels: Record<string, string> = {
      diagnosis: "诊断", medication: "用药", procedure: "诊疗操作",
      vaccination: "疫苗", billingSummary: "费用汇总", billingItem: "费用明细"
    };
    parts.push(labels[detail.factType] || "其他分类信息");
  }
  if (typeof detail.sectionKey === "string") {
    parts.push(reportStructuredSectionLabels[
      detail.sectionKey as keyof typeof reportStructuredSectionLabels
    ] || "其他专属内容");
  }
  if (Array.isArray(detail.fields) && detail.fields.length) parts.push(`字段 ${detail.fields.length} 项`);
  return parts.join(" · ") || auditActionTitles[action] || "未提供操作详情";
}

function userAuditTitle(action: string, detail: Record<string, unknown>) {
  if (action === "dictionary.update" && detail.layer === "core") return "同步内置指标字典";
  if (action === "dictionary.update" && detail.layer === "remote") return "更新远程指标字典";
  if (action === "dictionary.rollback") return "回滚远程指标字典";
  return auditActionTitles[action] || "未知操作";
}

export function listUserOperationAuditLogs(user: RequestUser, limit = 30, cursorValue?: string): CursorPage<{
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
}> {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看用户操作日志" });
  const safeLimit = Math.min(50, Math.max(1, Math.round(limit)));
  const cursor = decodeAuditCursor(cursorValue);
  const rows = getDatabase().prepare(`
    SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
      u.display_name AS actorName, a.detail_json AS detailJson, a.created_at AS createdAt
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE (
      ? IS NULL
      OR a.created_at < ?
      OR (a.created_at = ? AND a.id < ?)
    )
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ?
  `).all(cursor?.id ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, safeLimit + 1) as Array<{
    id: string; action: string; targetType: string | null; targetId: string | null;
    actorName: string | null; detailJson: string; createdAt: string;
  }>;
  const hasMore = rows.length > safeLimit;
  const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
  const refs = collectAuditReferenceIds(pageRows);
  const names = {
    users: rowsById<{ id: string; displayName: string }>("users", refs.userIds, "id, display_name AS displayName"),
    members: rowsById<{ id: string; displayName: string }>("health_members", refs.memberIds, "id, display_name AS displayName"),
    reports: rowsById<{ id: string; title: string }>("reports", refs.reportIds, "id, title"),
    pages: reportPagesById(refs.pageIds),
    reminders: rowsById<{ id: string; title: string }>("reminders", refs.reminderIds, "id, title"),
    morphologyFindings: rowsById<{ id: string; organ: string | null; findingName: string }>(
      "morphology_findings",
      refs.morphologyFindingIds,
      "id, organ, finding_name AS findingName"
    )
  };
  const targetName = (targetType: string | null, targetId: string | null, detail: Record<string, unknown>) => {
    if (!targetId) return null;
    if (targetType === "report") {
      return names.reports.get(targetId)?.title
        || (typeof detail.reportTitle === "string" ? detail.reportTitle : null)
        || "已删除报告";
    }
    if (targetType === "report_page") {
      const page = names.pages.get(targetId);
      if (page) return `${page.reportTitle} · 第 ${page.pageNumber} 页`;
      if (typeof detail.reportId === "string") return `${names.reports.get(detail.reportId)?.title || shortAuditId(detail.reportId)} · 报告页面`;
      return "报告页面";
    }
    if (targetType === "health_member" || targetType === "member") return names.members.get(targetId)?.displayName || "已删除成员";
    if (targetType === "reminder") return names.reminders.get(targetId)?.title || "已删除提醒";
    if (targetType === "user") return names.users.get(targetId)?.displayName || "未知用户";
    if (targetType === "backup") return "完整备份";
    if (targetType === "observation") return "指标记录";
    if (targetType === "morphology_finding") {
      const finding = names.morphologyFindings.get(targetId);
      return finding ? [finding.organ, finding.findingName].filter(Boolean).join(" · ") : "形态发现";
    }
    if (targetType === "indicator_dictionary") {
      const layer = detail.layer === "core" ? "内置字典" : detail.layer === "remote" ? "远程字典" : "指标字典";
      return typeof detail.revision === "number" ? `${layer}版本 ${detail.revision}` : layer;
    }
    if (targetType === "clinical_fact" && typeof detail.reportId === "string") {
      const labels: Record<string, string> = {
        diagnosis: "诊断", medication: "用药", procedure: "诊疗操作",
        vaccination: "疫苗", billingSummary: "费用汇总", billingItem: "费用明细"
      };
      const reportTitle = names.reports.get(detail.reportId)?.title || shortAuditId(detail.reportId);
      const factLabel = typeof detail.factType === "string" ? labels[detail.factType] || "其他分类信息" : "分类信息";
      return `${reportTitle} · ${factLabel}`;
    }
    if (targetType === "report_structured_section" && typeof detail.reportId === "string") {
      const reportTitle = names.reports.get(detail.reportId)?.title || shortAuditId(detail.reportId);
      const sectionLabel = typeof detail.sectionKey === "string"
        ? reportStructuredSectionLabels[detail.sectionKey as keyof typeof reportStructuredSectionLabels]
          || "其他专属内容"
        : "专属内容";
      return `${reportTitle} · ${sectionLabel}`;
    }
    return shortAuditId(targetId);
  };
  const items = pageRows.map((item) => {
    const detail = parseJson<Record<string, unknown>>(item.detailJson, {});
    return {
      id: item.id,
      action: item.action,
      title: userAuditTitle(item.action, detail),
      description: userAuditDescription(item.action, detail, names),
      targetLabel: item.targetType ? auditTargetLabels[item.targetType] || "其他对象" : "系统",
      targetId: item.targetId,
      targetName: targetName(item.targetType, item.targetId, detail),
      actorName: item.actorName,
      createdAt: item.createdAt,
      detail
    };
  });
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}

export function getAiAuditSummary(user: RequestUser, limit = 30, cursorValue?: string) {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看 AI 审计" });
  const safeLimit = Math.min(50, Math.max(1, Math.round(limit)));
  const cursor = decodeAuditCursor(cursorValue);
  const summary = getDatabase().prepare(`
    WITH ai_rows AS (
      SELECT j.id, 'report_extraction' AS source, j.status,
        COALESCE(NULLIF((SELECT COUNT(*) FROM ai_extraction_attempts aa WHERE aa.job_id = j.id), 0), j.attempts) AS attempts,
        e.prompt_tokens AS promptTokens, e.completion_tokens AS completionTokens, e.elapsed_ms AS elapsedMs
      FROM processing_jobs j
      LEFT JOIN report_extractions e ON e.job_id = j.id
      WHERE j.job_type = 'ai_extract'
      UNION ALL
      SELECT a.id, a.source, a.status, a.attempts,
        a.prompt_tokens AS promptTokens, a.completion_tokens AS completionTokens, a.elapsed_ms AS elapsedMs
      FROM ai_audit_events a
    )
    SELECT
      COUNT(*) AS jobCount,
      COALESCE(SUM(attempts), 0) AS callCount,
      SUM(status = 'completed') AS successJobs,
      SUM(status = 'failed') AS failedJobs,
      SUM(status = 'queued') AS queuedJobs,
      SUM(status = 'processing') AS processingJobs,
      COALESCE(SUM(promptTokens), 0) AS promptTokens,
      COALESCE(SUM(completionTokens), 0) AS completionTokens,
      COALESCE(AVG(elapsedMs), 0) AS avgElapsedMs
    FROM ai_rows
  `).get() as {
    jobCount: number; callCount: number; successJobs: number | null; failedJobs: number | null;
    queuedJobs: number | null; processingJobs: number | null; promptTokens: number; completionTokens: number;
    avgElapsedMs: number;
  };
  const rows = getDatabase().prepare(`
    WITH ai_rows AS (
      SELECT j.id, 'report_extraction' AS source, j.report_id AS reportId, r.title AS reportTitle, r.member_id AS memberId,
        j.status,
        COALESCE(NULLIF((SELECT COUNT(*) FROM ai_extraction_attempts aa WHERE aa.job_id = j.id), 0), j.attempts) AS attempts,
        j.error_code AS errorCode, j.error_message AS errorMessage,
        j.created_at AS createdAt, j.started_at AS startedAt, j.finished_at AS finishedAt,
        e.provider, e.model, e.prompt_tokens AS promptTokens, e.completion_tokens AS completionTokens,
        e.elapsed_ms AS elapsedMs, e.input_characters AS inputCharacters,
        (
          SELECT ur.document_content_type
          FROM ai_extraction_unit_routes ur
          JOIN ai_extraction_units uu ON uu.id = ur.unit_id
          WHERE uu.job_id = j.id
          ORDER BY uu.unit_index
          LIMIT 1
        ) AS documentContentType,
        (
          SELECT GROUP_CONCAT(DISTINCT ur.primary_content_type)
          FROM ai_extraction_unit_routes ur
          JOIN ai_extraction_units uu ON uu.id = ur.unit_id
          WHERE uu.job_id = j.id
        ) AS routedContentTypes
      FROM processing_jobs j
      JOIN reports r ON r.id = j.report_id
      LEFT JOIN report_extractions e ON e.job_id = j.id
      WHERE j.job_type = 'ai_extract'
      UNION ALL
      SELECT a.id, a.source, a.report_id AS reportId, COALESCE(r.title, a.target_title) AS reportTitle, r.member_id AS memberId,
        a.status, a.attempts, a.error_code AS errorCode, a.error_message AS errorMessage,
        a.created_at AS createdAt, a.created_at AS startedAt, a.created_at AS finishedAt,
        a.provider, a.model, a.prompt_tokens AS promptTokens, a.completion_tokens AS completionTokens,
        a.elapsed_ms AS elapsedMs, a.input_characters AS inputCharacters,
        NULL AS documentContentType, NULL AS routedContentTypes
      FROM ai_audit_events a
      LEFT JOIN reports r ON r.id = a.report_id
    )
    SELECT * FROM ai_rows
    WHERE (
      ? IS NULL
      OR createdAt < ?
      OR (createdAt = ? AND id < ?)
    )
    ORDER BY createdAt DESC, id DESC
    LIMIT ?
  `).all(cursor?.id ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, safeLimit + 1) as Array<{
    id: string; source: string; reportId: string | null; reportTitle: string; memberId: string | null; status: string; attempts: number;
    errorCode: string | null; errorMessage: string | null; createdAt: string; startedAt: string | null;
    finishedAt: string | null; provider: string | null; model: string | null; promptTokens: number | null;
    completionTokens: number | null; elapsedMs: number | null; inputCharacters: number | null;
    documentContentType: string | null; routedContentTypes: string | null;
  }>;
  const hasMore = rows.length > safeLimit;
  const recent = hasMore ? rows.slice(0, safeLimit) : rows;
  const last = recent.at(-1);
  return {
    summary: {
      jobCount: Number(summary.jobCount || 0),
      callCount: Number(summary.callCount || 0),
      successJobs: Number(summary.successJobs || 0),
      failedJobs: Number(summary.failedJobs || 0),
      queuedJobs: Number(summary.queuedJobs || 0),
      processingJobs: Number(summary.processingJobs || 0),
      promptTokens: Number(summary.promptTokens || 0),
      completionTokens: Number(summary.completionTokens || 0),
      totalTokens: Number(summary.promptTokens || 0) + Number(summary.completionTokens || 0),
      avgElapsedMs: Math.round(Number(summary.avgElapsedMs || 0))
    },
    recent,
    hasMore,
    nextCursor: hasMore && last ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}

export function buildMemberExportManifest(user: RequestUser, memberId: string) {
  assertMemberAccess(user, memberId);
  const reports = listReports(user, 50, { memberId }).items.map((report) => getReportDetail(user, report.id));
  return {
    exportedAt: new Date().toISOString(),
    memberId,
    reports: reports.map((report) => ({
      id: report.id,
      title: report.title,
      reportType: report.reportType,
      status: report.status,
      hospitalName: report.hospitalName,
      departmentName: report.departmentName,
      bodyPart: report.bodyPart,
      reportIssuedAt: report.reportIssuedAt,
      pages: report.pages,
      observations: report.observations,
      morphologyFindings: report.morphologyFindings,
      diagnoses: report.diagnoses,
      medications: report.medications,
      procedures: report.procedures,
      vaccinations: report.vaccinations,
      billingSummary: report.billingSummary,
      billingItems: report.billingItems,
      structuredSections: report.structuredSections
    }))
  };
}

export async function regeneratePdfPagePreviews(user: RequestUser) {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可重新生成 PDF 单页图" });
  const rows = getDatabase().prepare(`
    SELECT p.id AS pageId, p.report_id AS reportId, p.original_name AS originalName,
      p.storage_path AS storagePath, p.source_page_number AS sourcePageNumber,
      p.page_number AS pageNumber, p.rotation
    FROM report_pages p
    JOIN reports r ON r.id = p.report_id
    JOIN member_permissions mp ON mp.member_id = r.member_id AND mp.user_id = ?
    WHERE p.mime_type = 'application/pdf' AND r.status <> 'trashed'
    ORDER BY r.updated_at DESC, p.report_id, p.page_number
    LIMIT 1000
  `).all(user.id) as Array<{
    pageId: string;
    reportId: string;
    originalName: string;
    storagePath: string;
    sourcePageNumber: number | null;
    pageNumber: number;
    rotation: number;
  }>;

  let regenerated = 0;
  let removedLegacy = 0;
  const failures: Array<{ pageId: string; reportId: string; message: string }> = [];
  for (const row of rows) {
    const previewPath = storagePath(pdfPreviewRelativePath(row.reportId, row.pageId));
    if (existsSync(previewPath)) {
      rmSync(previewPath, { force: true });
      removedLegacy += 1;
    }

    try {
      await requestWorker({
        action: "thumbnail",
        imagePath: storagePath(row.storagePath),
        outputPath: previewPath,
        pageNumber: row.sourcePageNumber || row.pageNumber,
        rotation: row.rotation,
        maxSize: pdfPreviewMaxSize,
        quality: pdfPreviewQuality,
        renderScale: pdfPreviewRenderScale
      });
      if (existsSync(previewPath)) regenerated += 1;
      else failures.push({ pageId: row.pageId, reportId: row.reportId, message: "预览图未生成" });
    } catch (error) {
      failures.push({
        pageId: row.pageId,
        reportId: row.reportId,
        message: error instanceof Error ? error.message : "生成失败"
      });
    }
  }

  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'maintenance.regenerate_pdf_previews', 'report_page', NULL, ?)
  `).run(createId("audit"), user.id, JSON.stringify({
    scanned: rows.length,
    regenerated,
    failed: failures.length,
    removedLegacy,
    sample: failures.slice(0, 20)
  }));

  return {
    scanned: rows.length,
    regenerated,
    failed: failures.length,
    removedLegacy,
    failures: failures.slice(0, 20)
  };
}

export function createBackup(user: RequestUser) {
  return createFullBackup(user);
}

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

export type BackupManifestFile = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

type BackupManifest = {
  formatVersion: number;
  id?: string;
  appName?: string;
  appTitle?: string;
  appVersion?: string;
  schemaVersion?: number;
  appliedSchemaVersion?: number;
  createdAt?: string;
  reason?: "manual" | "pre_restore";
  storageLayout?: {
    database?: string;
    directories?: string[];
  };
  counts?: {
    reportCount?: number;
    memberCount?: number;
  };
  files?: BackupManifestFile[];
  notes?: string;
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

export type BackupDownload = BackupSummary & {
  path: string;
};

export type CreatedBackup = BackupSummary & {
  path: string;
};

const backupFormatVersion = 1;
const backupIncludedDirectories = ["reports", "thumbnails", "config", "secrets"] as const;

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function timestampForFilename(date = new Date()) {
  const [datePart, timePart = ""] = date.toISOString().split("T");
  const [clock = "", milliseconds = "000Z"] = timePart.split(".");
  return `${datePart.replaceAll("-", "")}-${clock.replaceAll(":", "")}-${milliseconds.replace("Z", "")}`;
}

function assertGatewayAdmin(user: RequestUser, action: string) {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: `仅管理员可${action}` });
}

function backupDirectory() {
  const directory = join(getAppConfig().storageDir, "backups", "full");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function assertSafeBackupId(id: string) {
  if (!/^backup_[a-f0-9]{32}$/.test(id)) {
    throw createError({ statusCode: 400, statusMessage: "备份 ID 无效" });
  }
}

function backupArchivePath(id: string) {
  assertSafeBackupId(id);
  const directory = backupDirectory();
  const metadata = readBackupMetadata(backupMetadataPath(id));
  if (metadata?.filename) {
    assertSafeBackupFilename(metadata.filename);
    return join(directory, metadata.filename);
  }
  return join(directory, `${id}.tar.gz`);
}

function backupMetadataPath(id: string) {
  assertSafeBackupId(id);
  return join(backupDirectory(), `${id}.metadata.json`);
}

function readBackupMetadata(path: string): BackupSummary | null {
  try {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as BackupSummary;
    return metadata?.id ? metadata : null;
  } catch {
    return null;
  }
}

function assertSafeBackupFilename(filename: string) {
  if (basename(filename) !== filename || !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(filename)) {
    throw createError({ statusCode: 400, statusMessage: "备份文件名无效" });
  }
}

function createBackupArchiveFilename(appName: string, date: Date, id: string) {
  const base = `${appName}-backup-${timestampForFilename(date)}.tar.gz`;
  const archivePath = join(backupDirectory(), base);
  if (!existsSync(archivePath)) return base;
  return `${appName}-backup-${timestampForFilename(date)}-${id.slice(-8)}.tar.gz`;
}

function safeStorageTarget(relativePath: string) {
  const storageRoot = resolve(getAppConfig().storageDir);
  const target = resolve(storageRoot, relativePath);
  if (target !== storageRoot && !target.startsWith(`${storageRoot}/`)) {
    throw createError({ statusCode: 400, statusMessage: "备份路径无效" });
  }
  return target;
}

function copyDirectoryForBackup(stagingRoot: string, directoryName: typeof backupIncludedDirectories[number]) {
  const source = safeStorageTarget(directoryName);
  const target = join(stagingRoot, directoryName);
  if (existsSync(source)) {
    cpSync(source, target, { recursive: true, force: true });
  } else {
    mkdirSync(target, { recursive: true });
  }
}

function normalizeArchiveRelativePath(path: string) {
  return path.split(sep).join("/");
}

function assertSafeArchiveRelativePath(path: string) {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  const normalized = normalizeArchiveRelativePath(path);
  return !normalized.split("/").some((part) => part === "..");
}

function listFilesForChecksum(root: string) {
  const results: string[] = [];
  function walk(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!stats.isFile()) continue;
      const relativePath = normalizeArchiveRelativePath(relative(root, absolutePath));
      if (relativePath === "manifest.json") continue;
      results.push(relativePath);
    }
  }
  walk(root);
  return results.sort();
}

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createBackupFileManifest(stagingRoot: string): BackupManifestFile[] {
  return listFilesForChecksum(stagingRoot).map((path) => {
    const absolutePath = join(stagingRoot, path);
    return {
      path,
      sizeBytes: statSync(absolutePath).size,
      sha256: sha256File(absolutePath)
    };
  });
}

function copyDatabaseSnapshot(snapshotPath: string) {
  const db = getDatabase();
  checkpointDatabase();
  mkdirSync(dirname(snapshotPath), { recursive: true });
  try {
    db.exec(`VACUUM INTO ${sqlString(snapshotPath)}`);
  } catch {
    copyFileSync(getDatabasePath(), snapshotPath);
  }
  chmodSync(snapshotPath, 0o600);
}

function createTarArchive(sourceDirectory: string, archivePath: string) {
  execFileSync("tar", ["-czf", archivePath, "-C", sourceDirectory, "."], { stdio: "pipe" });
  chmodSync(archivePath, 0o600);
}

function extractTarArchive(archivePath: string, targetDirectory: string) {
  mkdirSync(targetDirectory, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", targetDirectory], { stdio: "pipe" });
}

function countBackupSourceRows() {
  const db = getDatabase();
  const reports = db.prepare("SELECT COUNT(*) AS count FROM reports WHERE status <> 'trashed'").get() as { count: number };
  const members = db.prepare("SELECT COUNT(*) AS count FROM health_members WHERE deleted_at IS NULL").get() as { count: number };
  return { reportCount: reports.count, memberCount: members.count };
}

export function createFullBackup(user: RequestUser, reason: "manual" | "pre_restore" = "manual"): CreatedBackup {
  assertGatewayAdmin(user, "创建备份");
  const config = getAppConfig();
  const id = createId("backup");
  const createdDate = new Date();
  const createdAt = createdDate.toISOString();
  const filename = createBackupArchiveFilename(config.appName, createdDate, id);
  const archivePath = join(backupDirectory(), filename);
  const metadataPath = backupMetadataPath(id);
  const stagingRoot = mkdtempSync(join(tmpdir(), "health-records-backup-"));

  try {
    mkdirSync(join(stagingRoot, "db"), { recursive: true });
    const databaseStatus = getDatabaseStatus();
    const counts = countBackupSourceRows();
    copyDatabaseSnapshot(join(stagingRoot, "db", "health-records.sqlite"));
    for (const directoryName of backupIncludedDirectories) copyDirectoryForBackup(stagingRoot, directoryName);

    const manifestFiles = createBackupFileManifest(stagingRoot);
    const manifest: BackupManifest = {
      formatVersion: backupFormatVersion,
      id,
      appName: config.appName,
      appTitle: config.appTitle,
      appVersion: config.appVersion,
      schemaVersion: databaseStatus.schemaVersion,
      appliedSchemaVersion: databaseStatus.appliedSchemaVersion,
      createdAt,
      reason,
      storageLayout: {
        database: "db/health-records.sqlite",
        directories: [...backupIncludedDirectories]
      },
      counts,
      files: manifestFiles,
      notes: "完整备份包含健康档案数据库、报告原件、分页/缩略图、运行配置和 AI 加密密钥，请仅在可信设备保存。"
    };
    writeFileSync(join(stagingRoot, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    createTarArchive(stagingRoot, archivePath);

    const metadata: CreatedBackup = {
      id,
      filename,
      createdAt,
      sizeBytes: statSync(archivePath).size,
      appVersion: config.appVersion,
      schemaVersion: databaseStatus.appliedSchemaVersion || databaseStatus.schemaVersion,
      reportCount: counts.reportCount,
      memberCount: counts.memberCount,
      includes: ["数据库", "报告原件", "分页/缩略图", "运行配置", "AI 密钥"],
      reason,
      fileCount: manifestFiles.length,
      path: archivePath
    };
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });

    getDatabase().prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'backup.create', 'backup', ?, ?)
    `).run(createId("audit"), user.id, id, JSON.stringify({
      reportCount: metadata.reportCount,
      memberCount: metadata.memberCount,
      sizeBytes: metadata.sizeBytes,
      reason
    }));
    return metadata;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function listBackups(user: RequestUser): BackupSummary[] {
  assertGatewayAdmin(user, "查看备份");
  const directory = backupDirectory();
  const results = new Map<string, BackupSummary>();
  const filenames = readdirSync(directory);

  for (const metadataFilename of filenames.filter((name) => /^backup_[a-f0-9]{32}\.metadata\.json$/.test(name))) {
    const id = metadataFilename.replace(/\.metadata\.json$/, "");
    const metadata = readBackupMetadata(join(directory, metadataFilename));
    if (!metadata?.filename) continue;
    assertSafeBackupFilename(metadata.filename);
    const archivePath = join(directory, metadata.filename);
    if (!existsSync(archivePath)) continue;
    const archiveStat = statSync(archivePath);
    results.set(id, {
      ...metadata,
      sizeBytes: archiveStat.size
    });
  }

  for (const filename of filenames.filter((name) => /^backup_[a-f0-9]{32}\.tar\.gz$/.test(name))) {
    const id = filename.replace(/\.tar\.gz$/, "");
    if (results.has(id)) continue;
    const archivePath = join(directory, filename);
    const archiveStat = statSync(archivePath);
    const metadata = readBackupMetadata(backupMetadataPath(id));
    results.set(id, {
      id,
      filename,
      createdAt: metadata?.createdAt || archiveStat.birthtime.toISOString(),
      sizeBytes: archiveStat.size,
      appVersion: metadata?.appVersion || "未知",
      schemaVersion: metadata?.schemaVersion || 0,
      reportCount: metadata?.reportCount || 0,
      memberCount: metadata?.memberCount || 0,
      includes: metadata?.includes || ["数据库", "报告原件"],
      reason: metadata?.reason || "manual"
    });
  }

  return [...results.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getBackupDownload(user: RequestUser, id: string): BackupDownload {
  assertGatewayAdmin(user, "下载备份");
  const archivePath = backupArchivePath(id);
  if (!existsSync(archivePath)) throw createError({ statusCode: 404, statusMessage: "备份不存在" });
  const metadata = listBackups(user).find((item) => item.id === id) || {
    id,
    filename: basename(archivePath),
    createdAt: statSync(archivePath).birthtime.toISOString(),
    sizeBytes: statSync(archivePath).size,
    appVersion: "未知",
    schemaVersion: 0,
    reportCount: 0,
    memberCount: 0,
    includes: ["数据库", "报告原件"],
    reason: "manual" as const
  };
  return { ...metadata, path: archivePath };
}

export function deleteBackup(user: RequestUser, id: string) {
  assertGatewayAdmin(user, "删除备份");
  const backup = getBackupDownload(user, id);
  const metadataPath = backupMetadataPath(id);
  rmSync(backup.path, { force: true });
  rmSync(metadataPath, { force: true });
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'backup.delete', 'backup', ?, ?)
  `).run(createId("audit"), user.id, id, JSON.stringify({
    filename: backup.filename,
    sizeBytes: backup.sizeBytes,
    reason: backup.reason
  }));
  return { id, deleted: true };
}

function emptyBackupValidationResult(): BackupValidationResult {
  return {
    valid: false,
    checksumAvailable: false,
    fileCount: 0,
    checkedCount: 0,
    missingFiles: [],
    mismatchedFiles: [],
    extraFiles: [],
    warnings: [],
    errors: [],
    manifest: null
  };
}

function manifestSummary(manifest: BackupManifest): BackupValidationResult["manifest"] {
  return {
    id: manifest.id || null,
    appName: manifest.appName || null,
    appTitle: manifest.appTitle || null,
    appVersion: manifest.appVersion || null,
    schemaVersion: manifest.appliedSchemaVersion || manifest.schemaVersion || null,
    createdAt: manifest.createdAt || null,
    reason: manifest.reason || null,
    reportCount: manifest.counts?.reportCount ?? null,
    memberCount: manifest.counts?.memberCount ?? null
  };
}

function readExtractedBackupManifest(extractRoot: string): { manifest?: BackupManifest; result: BackupValidationResult } {
  const manifestPath = join(extractRoot, "manifest.json");
  const result = emptyBackupValidationResult();
  if (!existsSync(manifestPath)) {
    result.errors.push("备份清单缺失");
    return { result };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
    result.manifest = manifestSummary(manifest);
    return { manifest, result };
  } catch {
    result.errors.push("备份清单损坏");
    return { result };
  }
}

function validateBackupDatabase(databasePath: string, manifest: BackupManifest, result: BackupValidationResult) {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const quickCheck = database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (quickCheck?.quick_check !== "ok") result.errors.push("备份数据库完整性检查未通过");

    const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length) {
      result.errors.push(`备份数据库存在 ${foreignKeyErrors.length} 条外键不一致`);
    }

    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name));
    for (const required of ["users", "health_members", "reports", "report_pages"]) {
      if (!tables.has(required)) result.errors.push(`备份数据库缺少核心表：${required}`);
    }

    let actualSchemaVersion = 0;
    if (tables.has("schema_migrations")) {
      const versions = (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
        .map((row) => Number(row.version));
      actualSchemaVersion = versions.at(-1) || 0;
      if (actualSchemaVersion <= schemaVersion) {
        const versionSet = new Set(versions);
        const missingVersion = Array.from({ length: actualSchemaVersion }, (_, index) => index + 1)
          .find((version) => !versionSet.has(version));
        if (missingVersion) result.errors.push(`备份数据库迁移记录不连续，缺少 v${missingVersion}`);
      }
    } else if (tables.has("reports")) {
      actualSchemaVersion = 1;
    }

    if (actualSchemaVersion < 1) result.errors.push("无法识别备份数据库版本");
    if (actualSchemaVersion > schemaVersion) {
      result.errors.push(`备份数据库版本 v${actualSchemaVersion} 高于当前应用支持的 v${schemaVersion}`);
    }
    const declaredSchemaVersion = Number(manifest.appliedSchemaVersion || manifest.schemaVersion || 0);
    if (declaredSchemaVersion > schemaVersion) {
      result.errors.push(`备份清单要求数据库 v${declaredSchemaVersion}，当前应用仅支持到 v${schemaVersion}`);
    }
    if (declaredSchemaVersion > 0 && actualSchemaVersion > 0 && declaredSchemaVersion !== actualSchemaVersion) {
      result.errors.push(`备份清单数据库版本 v${declaredSchemaVersion} 与实际 v${actualSchemaVersion} 不一致`);
    }
  } catch (error) {
    result.errors.push(`备份数据库无法读取：${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    database?.close();
  }
}

function validateExtractedBackup(extractRoot: string): BackupValidationResult {
  const { manifest, result } = readExtractedBackupManifest(extractRoot);
  const databasePath = join(extractRoot, "db", "health-records.sqlite");
  if (!manifest) return result;
  if (manifest.appName !== getAppConfig().appName) {
    result.errors.push("备份不属于当前应用");
  }
  if (manifest.formatVersion !== backupFormatVersion) {
    result.errors.push("备份格式版本不兼容");
  }
  if (!existsSync(databasePath)) {
    result.errors.push("备份数据库缺失");
  } else {
    validateBackupDatabase(databasePath, manifest, result);
  }
  if (!Array.isArray(manifest.files)) {
    result.warnings.push("旧备份没有文件校验清单，仅完成基础兼容性校验");
    result.valid = result.errors.length === 0;
    return result;
  }

  result.checksumAvailable = true;
  result.fileCount = manifest.files.length;
  const expectedPaths = new Set<string>();
  for (const file of manifest.files) {
    if (!file || !assertSafeArchiveRelativePath(file.path)) {
      result.errors.push(`备份清单包含非法路径：${file?.path || "空路径"}`);
      continue;
    }
    expectedPaths.add(file.path);
    const target = join(extractRoot, file.path);
    if (!existsSync(target)) {
      result.missingFiles.push(file.path);
      continue;
    }
    const stats = lstatSync(target);
    if (!stats.isFile()) {
      result.mismatchedFiles.push({
        path: file.path,
        expectedSha256: file.sha256,
        expectedSizeBytes: file.sizeBytes
      });
      continue;
    }
    const actualSha256 = sha256File(target);
    result.checkedCount += 1;
    if (stats.size !== file.sizeBytes || actualSha256 !== file.sha256) {
      result.mismatchedFiles.push({
        path: file.path,
        expectedSha256: file.sha256,
        actualSha256,
        expectedSizeBytes: file.sizeBytes,
        actualSizeBytes: stats.size
      });
    }
  }
  for (const actualPath of listFilesForChecksum(extractRoot)) {
    if (!expectedPaths.has(actualPath)) result.extraFiles.push(actualPath);
  }
  if (result.extraFiles.length) {
    result.errors.push(`备份包包含 ${result.extraFiles.length} 个未登记文件`);
  }
  if (result.missingFiles.length) {
    result.errors.push(`备份包缺失 ${result.missingFiles.length} 个文件`);
  }
  if (result.mismatchedFiles.length) {
    result.errors.push(`备份包有 ${result.mismatchedFiles.length} 个文件校验不一致`);
  }
  result.valid = result.errors.length === 0;
  return result;
}

function ensureBackupValidationPassed(result: BackupValidationResult) {
  if (result.valid) return;
  throw createError({
    statusCode: 400,
    statusMessage: result.errors[0] ? `备份校验失败：${result.errors[0]}` : "备份校验失败，无法恢复"
  });
}

function validateBackupArchivePath(archivePath: string): BackupValidationResult {
  if (!existsSync(archivePath)) {
    return { ...emptyBackupValidationResult(), errors: ["备份不存在"] };
  }
  const extractRoot = mkdtempSync(join(tmpdir(), "health-records-backup-check-"));
  try {
    extractTarArchive(archivePath, extractRoot);
    return validateExtractedBackup(extractRoot);
  } catch (error) {
    const result = emptyBackupValidationResult();
    result.errors.push(error instanceof Error ? `备份包无法解压：${error.message}` : "备份包无法解压");
    return result;
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

export function validateBackup(user: RequestUser, id: string): BackupValidationResult {
  assertGatewayAdmin(user, "校验备份");
  const archivePath = backupArchivePath(id);
  return validateBackupArchivePath(archivePath);
}

function replaceStorageDirectory(directoryName: typeof backupIncludedDirectories[number], extractRoot: string) {
  const source = join(extractRoot, directoryName);
  const target = safeStorageTarget(directoryName);
  rmSync(target, { recursive: true, force: true });
  if (existsSync(source)) {
    cpSync(source, target, { recursive: true, force: true });
  } else {
    mkdirSync(target, { recursive: true });
  }
}

function replaceDatabaseFromBackup(extractRoot: string) {
  const targetDatabase = getDatabasePath();
  const safetyDirectory = safeStorageTarget(join("backups", "restore-safety"));
  mkdirSync(safetyDirectory, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${targetDatabase}${suffix}`;
    if (existsSync(target)) {
      renameSync(target, join(safetyDirectory, `restore-current-${timestampForFilename()}${suffix || ".sqlite"}`));
    }
  }
  mkdirSync(dirname(targetDatabase), { recursive: true });
  copyFileSync(join(extractRoot, "db", "health-records.sqlite"), targetDatabase);
  chmodSync(targetDatabase, 0o600);
}

function insertRestoreAudit(actorUserId: string, backupId: string, safetyBackupId: string) {
  const db = getDatabase();
  const actor = db.prepare("SELECT id FROM users WHERE id = ?").get(actorUserId) as { id: string } | undefined;
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'backup.restore', 'backup', ?, ?)
  `).run(createId("audit"), actor?.id || null, backupId, JSON.stringify({ safetyBackupId }));
}

function restoreBackupFromArchive(user: RequestUser, archivePath: string, backupId: string) {
  assertGatewayAdmin(user, "恢复备份");
  if (!existsSync(archivePath)) throw createError({ statusCode: 404, statusMessage: "备份不存在" });
  const runnerStatus = getJobRunnerStatus();
  if (runnerStatus.busy) {
    throw createError({ statusCode: 409, statusMessage: "后台识别任务正在执行，请稍后再恢复备份" });
  }
  const extractRoot = mkdtempSync(join(tmpdir(), "health-records-restore-"));
  let shouldRestartRunner = false;

  try {
    extractTarArchive(archivePath, extractRoot);
    const validation = validateExtractedBackup(extractRoot);
    ensureBackupValidationPassed(validation);
    shouldRestartRunner = runnerStatus.started;
    stopJobRunner();
    const safetyBackup = createFullBackup(user, "pre_restore");
    closeDatabase();
    for (const directoryName of backupIncludedDirectories) replaceStorageDirectory(directoryName, extractRoot);
    replaceDatabaseFromBackup(extractRoot);
    getDatabase();
    const identityRebind = rebindRestoredGatewayAdministrator(user);
    insertRestoreAudit(user.id, backupId, safetyBackup.id);
    return {
      restored: true,
      backupId,
      safetyBackupId: safetyBackup.id,
      identityRebind,
      validation
    };
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
    if (shouldRestartRunner) startJobRunner();
  }
}

export function restoreBackup(user: RequestUser, id: string) {
  const archivePath = backupArchivePath(id);
  return restoreBackupFromArchive(user, archivePath, id);
}

export function restoreUploadedBackup(user: RequestUser, archivePath: string) {
  const validation = validateBackupArchivePath(archivePath);
  ensureBackupValidationPassed(validation);
  const manifestId = validation.manifest?.id && /^backup_[a-f0-9]{32}$/.test(validation.manifest.id)
    ? validation.manifest.id
    : createId("backup");
  return restoreBackupFromArchive(user, archivePath, manifestId);
}
