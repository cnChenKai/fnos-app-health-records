import { defineEventHandler, readBody } from "h3";
import { recordClientSystemError } from "../../../../services/system-logs.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ source?: unknown; detail?: unknown }>(event);
  return ok(await recordClientSystemError(getRequestUser(event), body || {}));
});
