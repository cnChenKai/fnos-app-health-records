import { defineEventHandler } from "h3";
import { clearSystemLogs } from "../../../services/system-logs.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const result = await clearSystemLogs(getRequestUser(event));
  event.context.skipRequestLog = true;
  return ok(result);
});
