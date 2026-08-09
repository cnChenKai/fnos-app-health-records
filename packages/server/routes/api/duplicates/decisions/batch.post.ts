import { createError, defineEventHandler, readBody } from "h3";
import { setReportDuplicateDecisionsBatch } from "../../../../services/report-duplicate-governance.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    items?: Array<{
      reportId?: string;
      candidateReportId?: string;
      decision?: "duplicate" | "distinct";
      reason?: string | null;
      evidence?: Record<string, unknown> | null;
    }>;
  }>(event);
  if (!Array.isArray(body?.items) || !body.items.length) {
    throw createError({ statusCode: 400, statusMessage: "请选择需要批量治理的候选" });
  }
  return ok(setReportDuplicateDecisionsBatch(
    getRequestUser(event),
    body.items.map((item) => ({
      reportId: item.reportId || "",
      candidateReportId: item.candidateReportId || "",
      decision: item.decision as "duplicate" | "distinct",
      reason: item.reason,
      evidence: item.evidence
    }))
  ));
});
