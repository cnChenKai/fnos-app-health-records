import { createError, defineEventHandler, getRouterParam } from "h3";
import { deleteClinicalFact } from "../../../../services/clinical-fact.service";
import { getReportDetail } from "../../../../services/records.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const type = getRouterParam(event, "type");
  const id = getRouterParam(event, "id");
  if (!type || !id) throw createError({ statusCode: 400, statusMessage: "专属事实 ID 无效" });
  const user = getRequestUser(event);
  const result = deleteClinicalFact(user, type, id);
  return ok(getReportDetail(user, result.reportId));
});
