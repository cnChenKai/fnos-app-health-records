import { defineEventHandler, getQuery } from "h3";
import { listAppNotifications } from "../../services/records.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  const memberId = getQuery(event).memberId;
  return ok(listAppNotifications(getRequestUser(event), typeof memberId === "string" ? memberId : undefined));
});
