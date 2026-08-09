import { createError, defineEventHandler, readBody } from "h3";
import { setReportDuplicateDecision } from "../../../services/report-duplicate-governance.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    reportId?: string;
    candidateReportId?: string;
    decision?: "duplicate" | "distinct";
    reason?: string | null;
    evidence?: Record<string, unknown> | null;
  }>(event);
  if (!body?.reportId || !body.candidateReportId || !body.decision) {
    throw createError({ statusCode: 400, statusMessage: "请提供报告、候选报告和治理结论" });
  }
  return ok(setReportDuplicateDecision(getRequestUser(event), {
    reportId: body.reportId,
    candidateReportId: body.candidateReportId,
    decision: body.decision,
    reason: body.reason,
    evidence: body.evidence
  }));
});
