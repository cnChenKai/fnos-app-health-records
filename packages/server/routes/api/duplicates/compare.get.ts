import { createError, defineEventHandler, getQuery } from "h3";
import { getReportDuplicateComparison } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const reportId = typeof query.reportId === "string" ? query.reportId : "";
  const candidateReportId = typeof query.candidateReportId === "string" ? query.candidateReportId : "";
  if (!reportId || !candidateReportId) {
    throw createError({ statusCode: 400, statusMessage: "请选择两份需要比较的报告" });
  }
  return ok(getReportDuplicateComparison(getRequestUser(event), reportId, candidateReportId));
});
