import { defineEventHandler, readBody, setResponseStatus } from "h3";
import { createReminder } from "../../services/records.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reminder = createReminder(getRequestUser(event), (await readBody(event) || {}) as Record<string, unknown>);
  setResponseStatus(event, 201);
  return ok(reminder);
});
