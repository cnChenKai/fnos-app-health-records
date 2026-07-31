import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getReportDetail } from "../../../../services/records.service";
import { createReportStructuredSection } from "../../../../services/report-structured-section.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  const user = getRequestUser(event);
  createReportStructuredSection(
    user,
    reportId,
    (await readBody(event) || {}) as Record<string, unknown>
  );
  return ok(getReportDetail(user, reportId));
});
