import { createError, defineEventHandler, getQuery } from "h3";
import { getDuplicateReportOverview } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const memberId = query.memberId;
  if (typeof memberId !== "string" || !memberId) {
    throw createError({ statusCode: 400, statusMessage: "请选择成员" });
  }
  const confidence = query.confidence === "high" || query.confidence === "medium"
    ? query.confidence
    : undefined;
  const page = typeof query.page === "string" ? Number(query.page) : undefined;
  const pageSize = typeof query.pageSize === "string" ? Number(query.pageSize) : undefined;
  return ok(getDuplicateReportOverview(getRequestUser(event), memberId, {
    query: typeof query.q === "string" ? query.q : undefined,
    confidence,
    reportType: typeof query.reportType === "string" ? query.reportType : undefined,
    hospital: typeof query.hospital === "string" ? query.hospital : undefined,
    page: Number.isFinite(page) ? page : undefined,
    pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
  }));
});
