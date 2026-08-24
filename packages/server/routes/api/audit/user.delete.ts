import { defineEventHandler } from "h3";
import { clearUserOperationAuditLogs } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  return ok(clearUserOperationAuditLogs(getRequestUser(event)));
});
