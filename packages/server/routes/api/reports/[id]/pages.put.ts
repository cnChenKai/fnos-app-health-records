import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { updateReportPages } from "../../../../services/records.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  return ok(updateReportPages(getRequestUser(event), reportId, (await readBody(event) || {}) as Record<string, unknown>));
});
