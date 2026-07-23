import { defineEventHandler, getQuery } from "h3";
import { listUserOperationAuditLogs } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  return ok(listUserOperationAuditLogs(
    getRequestUser(event),
    Number(query.limit || 30),
    typeof query.cursor === "string" ? query.cursor : undefined
  ));
});
