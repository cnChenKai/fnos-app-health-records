import { defineEventHandler, getQuery } from "h3";
import { listAuditLogs } from "../../services/records.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  return ok(listAuditLogs(getRequestUser(event), Number(getQuery(event).limit || 80)));
});
