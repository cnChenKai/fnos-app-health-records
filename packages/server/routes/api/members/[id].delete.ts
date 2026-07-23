import { defineEventHandler, getRouterParam } from "h3";
import { deleteMember } from "../../../services/member.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const memberId = getRouterParam(event, "id") || "";
  return ok(deleteMember(getRequestUser(event), memberId));
});
