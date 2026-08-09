import { createError, defineEventHandler, readBody } from "h3";
import { undoReportDuplicateDecisionsBatch } from "../../../../services/report-duplicate-governance.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ pairKeys?: string[] }>(event);
  if (!Array.isArray(body?.pairKeys) || !body.pairKeys.length) {
    throw createError({ statusCode: 400, statusMessage: "请选择需要撤销的治理记录" });
  }
  return ok(undoReportDuplicateDecisionsBatch(getRequestUser(event), body.pairKeys));
});
