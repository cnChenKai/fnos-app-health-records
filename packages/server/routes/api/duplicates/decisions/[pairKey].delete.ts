import { createError, defineEventHandler, getRouterParam } from "h3";
import { undoReportDuplicateDecision } from "../../../../services/report-duplicate-governance.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const pairKey = getRouterParam(event, "pairKey");
  if (!pairKey) throw createError({ statusCode: 400, statusMessage: "治理记录无效" });
  return ok(undoReportDuplicateDecision(getRequestUser(event), pairKey));
});
