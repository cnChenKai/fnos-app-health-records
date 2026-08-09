import { createError, defineEventHandler, getQuery } from "h3";
import { getReportDuplicateMetrics } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const memberId = query.memberId;
  if (typeof memberId !== "string" || !memberId) {
    throw createError({ statusCode: 400, statusMessage: "请选择成员" });
  }
  return ok(getReportDuplicateMetrics(getRequestUser(event), memberId));
});
