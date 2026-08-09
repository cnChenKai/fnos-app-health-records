import { createError, defineEventHandler, getRouterParam } from "h3";
import { getReportPageOcrDetail } from "../../../../../../services/records.service";
import { ok } from "../../../../../../utils/api-response";
import { getRequestUser } from "../../../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reportId = getRouterParam(event, "id");
  const pageId = getRouterParam(event, "pageId");
  if (!reportId || !pageId) throw createError({ statusCode: 400, statusMessage: "报告页面 ID 无效" });
  const detail = await getReportPageOcrDetail(getRequestUser(event), reportId, pageId);
  if (!detail) throw createError({ statusCode: 404, statusMessage: "页面 OCR 结果不存在" });
  return ok(detail);
});
