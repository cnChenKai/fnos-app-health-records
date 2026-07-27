import { defineEventHandler, readBody } from "h3";
import { updateTrendPin } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}));
  return ok(updateTrendPin(getRequestUser(event), body || {}, false));
});
