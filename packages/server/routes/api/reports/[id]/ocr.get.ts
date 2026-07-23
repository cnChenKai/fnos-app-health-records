import { createError, defineEventHandler, getRouterParam } from "h3";
import { listReportOcrText } from "../../../../services/records.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  return ok(listReportOcrText(getRequestUser(event), reportId));
});
