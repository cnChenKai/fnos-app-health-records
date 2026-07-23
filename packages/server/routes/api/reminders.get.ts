import { defineEventHandler, getQuery } from "h3";
import { listReminders } from "../../services/records.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  const memberId = getQuery(event).memberId;
  return ok(listReminders(getRequestUser(event), typeof memberId === "string" ? memberId : undefined));
});
