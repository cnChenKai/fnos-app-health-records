import type { ClinicalEvidence, ReportPage } from "../types/api";

type EvidencePage = Pick<ReportPage, "pageNumber">;

export type ClinicalEvidenceNavigation =
  | { status: "pending"; pageNumber: null; pageIndex: null }
  | { status: "missing_evidence"; pageNumber: null; pageIndex: null }
  | { status: "page_not_found"; pageNumber: number; pageIndex: null }
  | { status: "ready"; pageNumber: number; pageIndex: number };

export function resolveClinicalEvidenceNavigation(
  evidence: ClinicalEvidence,
  pages: readonly EvidencePage[],
  pageMutationPending = false
): ClinicalEvidenceNavigation {
  if (pageMutationPending) {
    return { status: "pending", pageNumber: null, pageIndex: null };
  }

  const pageNumbers = evidence
    .map((item) => Number(item.pageNumber))
    .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0);
  if (!pageNumbers.length) {
    return { status: "missing_evidence", pageNumber: null, pageIndex: null };
  }

  for (const pageNumber of pageNumbers) {
    const pageIndex = pages.findIndex((page) => page.pageNumber === pageNumber);
    if (pageIndex >= 0) return { status: "ready", pageNumber, pageIndex };
  }

  return { status: "page_not_found", pageNumber: pageNumbers[0], pageIndex: null };
}
