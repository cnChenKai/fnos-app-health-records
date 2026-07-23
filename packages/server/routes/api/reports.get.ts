import { defineEventHandler, getQuery } from "h3";
import { listReports } from "../../services/records.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  return ok(listReports(getRequestUser(event), Number(query.limit || 30), {
    memberId: typeof query.memberId === "string" ? query.memberId : undefined,
    cursor: typeof query.cursor === "string" ? query.cursor : undefined,
    query: typeof query.q === "string" ? query.q : undefined,
    ocrQuery: typeof query.ocr === "string" ? query.ocr : undefined,
    reportType: typeof query.type === "string" ? query.type : undefined,
    status: typeof query.status === "string" ? query.status : undefined,
    dateFrom: typeof query.dateFrom === "string" ? query.dateFrom : undefined,
    dateTo: typeof query.dateTo === "string" ? query.dateTo : undefined,
    trash: query.trash === "1"
  }));
});
