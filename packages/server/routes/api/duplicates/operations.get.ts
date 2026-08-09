import { createError, defineEventHandler, getQuery } from "h3";
import { listDuplicateReportOperations } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const memberId = typeof query.memberId === "string" ? query.memberId : "";
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "请选择成员" });
  const limit = typeof query.limit === "string" ? Number(query.limit) : undefined;
  return ok(listDuplicateReportOperations(
    getRequestUser(event),
    memberId,
    Number.isFinite(limit) ? limit : undefined
  ));
});
