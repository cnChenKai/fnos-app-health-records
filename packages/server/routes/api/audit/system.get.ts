import { defineEventHandler, getQuery } from "h3";
import { listSystemLogs } from "../../../services/system-logs.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  return ok(await listSystemLogs(getRequestUser(event), {
    limit: Number(query.limit || 30),
    cursor: typeof query.cursor === "string" ? query.cursor : undefined,
    filter: typeof query.filter === "string" ? query.filter : undefined
  }));
});
