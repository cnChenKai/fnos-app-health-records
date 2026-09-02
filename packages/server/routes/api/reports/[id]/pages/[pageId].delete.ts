import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { deleteReportPage } from "../../../../../services/records.service";
import { ok } from "../../../../../utils/api-response";
import { getRequestUser } from "../../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reportId = getRouterParam(event, "id");
  const pageId = getRouterParam(event, "pageId");
  if (!reportId || !pageId) throw createError({ statusCode: 400, statusMessage: "页面 ID 无效" });
  return ok(deleteReportPage(
    getRequestUser(event),
    reportId,
    pageId,
    (await readBody(event) || {}) as Record<string, unknown>
  ));
});
