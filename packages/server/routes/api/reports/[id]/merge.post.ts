import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { mergeDuplicateReport } from "../../../../services/records.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const sourceReportId = getRouterParam(event, "id");
  if (!sourceReportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  const body = (await readBody(event) || {}) as { targetReportId?: string };
  if (!body.targetReportId) throw createError({ statusCode: 400, statusMessage: "请选择合并目标报告" });
  return ok(mergeDuplicateReport(getRequestUser(event), sourceReportId, body.targetReportId));
});
