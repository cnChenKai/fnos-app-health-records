import { createHash } from "node:crypto";
import { getDatabase } from "../database/client";

export type LocalDuplicateEvidence = {
  reportId: string;
  confidence: "high" | "medium";
  matchedFields: string[];
  reason: string;
  textSimilarity: number | null;
};

type LocalReportSnapshot = {
  reportId: string;
  memberId: string;
  fileSignature: string | null;
  identifiers: Map<string, string>;
  text: string;
  lines: Set<string>;
  shingles: Set<string>;
};

const businessIdentifierPattern =
  /(报告号|门诊号|住院号|体检号|检查号|标本号|条码号)\s*[:：]\s*([A-Z0-9][A-Z0-9./_-]{2,})/gi;
const directIdentityPattern =
  /(?:患者)?姓名|受检者|身份证|证件号码?|联系电话|手机号码?|手机号|家庭住址|通讯地址|现住址|联系地址|出生日期|出生年月|电子邮箱|邮箱|E-?mail/i;
const pageNoisePattern =
  /^(?:第?\d+页(?:共\d+页)?|\d+[/／]\d+页?|本报告仅供.*|仅供临床参考|打印时间.*|打印日期.*)$/i;

function normalizeComparableText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/\[(?:患者个资已过滤|已过滤身份证号|已过滤手机号|已过滤邮箱)\]/g, "")
    .replace(/[（）()[\]【】{}<>《》:：,，.。;；、/\\|_\-\s]/g, "")
    .trim();
}

function fileSignature(reportId: string) {
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

function extractIdentifiers(lines: string[]) {
  const identifiers = new Map<string, string>();
  for (const line of lines) {
    for (const match of line.matchAll(businessIdentifierPattern)) {
      const key = match[1].toLocaleLowerCase("zh-CN");
      const value = normalizeComparableText(match[2]);
      if (value.length >= 3) identifiers.set(key, value);
    }
  }
  return identifiers;
}

function buildShingles(text: string, width = 7) {
  const values = new Set<string>();
  if (text.length < width) return values;
  const step = text.length > 30_000 ? 4 : text.length > 12_000 ? 2 : 1;
  for (let index = 0; index <= text.length - width; index += step) {
    values.add(createHash("sha1").update(text.slice(index, index + width)).digest("base64url").slice(0, 10));
  }
  return values;
}

function snapshot(reportId: string): LocalReportSnapshot | null {
  const report = getDatabase().prepare(`
    SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'
  `).get(reportId) as { memberId: string } | undefined;
  if (!report) return null;
  try {
    const pages = getDatabase().prepare(`
      SELECT p.id, (
        SELECT o.lines_json FROM ocr_results o
        WHERE o.page_id = p.id
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 1
      ) AS linesJson
      FROM report_pages p
      WHERE p.report_id = ?
      ORDER BY p.page_number, p.id
    `).all(reportId) as Array<{ id: string; linesJson: string | null }>;
    if (!pages.length || pages.some((page) => page.linesJson === null)) return null;
    const rawLines = pages.flatMap((page) => {
      const parsed = JSON.parse(page.linesJson || "[]") as Array<{ text?: unknown }>;
      return parsed.flatMap((line) => {
        const text = typeof line.text === "string" ? line.text.trim() : "";
        return text ? [text] : [];
      });
    });
    if (!rawLines.length) return null;
    const identifiers = extractIdentifiers(rawLines);
    const comparableLines = rawLines.flatMap((line) => {
      if (directIdentityPattern.test(line) || pageNoisePattern.test(line)) return [];
      const normalized = normalizeComparableText(line);
      return normalized.length >= 5 ? [normalized] : [];
    });
    const text = comparableLines.join("");
    return {
      reportId,
      memberId: report.memberId,
      fileSignature: fileSignature(reportId),
      identifiers,
      text,
      lines: new Set(comparableLines),
      shingles: buildShingles(text)
    };
  } catch {
    return null;
  }
}

function overlap<T>(left: Set<T>, right: Set<T>) {
  if (!left.size || !right.size) return { shared: 0, smallerRatio: 0, largerRatio: 0 };
  let shared = 0;
  for (const value of left.size < right.size ? left : right) {
    if ((left.size < right.size ? right : left).has(value)) shared += 1;
  }
  return {
    shared,
    smallerRatio: shared / Math.min(left.size, right.size),
    largerRatio: shared / Math.max(left.size, right.size)
  };
}

function sharedIdentifiers(left: LocalReportSnapshot, right: LocalReportSnapshot) {
  return [...left.identifiers.entries()].flatMap(([key, value]) =>
    right.identifiers.get(key) === value ? [key] : []
  );
}

function compareSnapshots(current: LocalReportSnapshot, candidate: LocalReportSnapshot): LocalDuplicateEvidence | null {
  if (current.memberId !== candidate.memberId) return null;
  if (current.fileSignature && current.fileSignature === candidate.fileSignature) {
    return {
      reportId: candidate.reportId,
      confidence: "high",
      matchedFields: ["原始文件"],
      reason: "上传原件内容完全一致",
      textSimilarity: null
    };
  }

  const identifierMatches = sharedIdentifiers(current, candidate);
  if (identifierMatches.length) {
    return {
      reportId: candidate.reportId,
      confidence: "high",
      matchedFields: identifierMatches.map((key) => `OCR编号:${key}`),
      reason: `OCR 识别出的医疗编号一致（${identifierMatches.join("、")}）`,
      textSimilarity: null
    };
  }

  if (Math.min(current.text.length, candidate.text.length) < 120) return null;
  const lengthRatio = Math.min(current.text.length, candidate.text.length)
    / Math.max(current.text.length, candidate.text.length);
  const textStats = overlap(current.shingles, candidate.shingles);
  const lineStats = overlap(current.lines, candidate.lines);
  const textSimilarity = Number(textStats.smallerRatio.toFixed(4));
  const highTextMatch = lengthRatio >= 0.78
    && textStats.smallerRatio >= 0.92
    && textStats.largerRatio >= 0.72
    && (
      (lineStats.shared >= 3 && lineStats.smallerRatio >= 0.35)
      || (textStats.smallerRatio >= 0.985 && textStats.largerRatio >= 0.95)
    );
  const highLineMatch = lineStats.shared >= 8
    && lineStats.smallerRatio >= 0.85
    && lineStats.largerRatio >= 0.6
    && textStats.smallerRatio >= 0.78;
  if (highTextMatch || highLineMatch) {
    return {
      reportId: candidate.reportId,
      confidence: "high",
      matchedFields: [`OCR内容${lineStats.shared}行`, `文本相似度${Math.round(textSimilarity * 100)}%`],
      reason: "OCR 去噪后的报告内容高度一致",
      textSimilarity
    };
  }

  const mediumMatch = lengthRatio >= 0.65
    && textStats.smallerRatio >= 0.82
    && textStats.largerRatio >= 0.55
    && lineStats.shared >= 4;
  if (!mediumMatch) return null;
  return {
    reportId: candidate.reportId,
    confidence: "medium",
    matchedFields: [`OCR内容${lineStats.shared}行`, `文本相似度${Math.round(textSimilarity * 100)}%`],
    reason: "OCR 去噪后的报告内容较为相似",
    textSimilarity
  };
}

export function findLocalDuplicateEvidence(reportId: string, limit = 80) {
  const current = snapshot(reportId);
  if (!current) return [];
  const candidates = getDatabase().prepare(`
    SELECT id FROM reports
    WHERE member_id = ? AND id <> ? AND status <> 'trashed'
    ORDER BY updated_at DESC, id
    LIMIT ?
  `).all(current.memberId, reportId, Math.max(1, Math.min(300, Math.round(limit)))) as Array<{ id: string }>;
  return candidates.flatMap((candidate) => {
    const candidateSnapshot = snapshot(candidate.id);
    if (!candidateSnapshot) return [];
    const evidence = compareSnapshots(current, candidateSnapshot);
    return evidence ? [evidence] : [];
  });
}

export function hasHighConfidenceLocalDuplicate(reportId: string) {
  return findLocalDuplicateEvidence(reportId).some((candidate) => candidate.confidence === "high");
}
