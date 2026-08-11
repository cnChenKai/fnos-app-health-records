import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { searchReportIndicatorCatalog } from "../../../../services/indicator-normalization.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  const query = getQuery(event);
  const search = typeof query.q === "string" ? query.q : "";
  return ok(searchReportIndicatorCatalog(getRequestUser(event), reportId, search));
});
