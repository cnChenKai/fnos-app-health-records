import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getReportDetail } from "../../../services/records.service";
import { updateReportStructuredSection } from "../../../services/report-structured-section.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "专属内容 ID 无效" });
  const user = getRequestUser(event);
  const result = updateReportStructuredSection(
    user,
    id,
    (await readBody(event) || {}) as Record<string, unknown>
  );
  return ok(getReportDetail(user, result.reportId));
});
