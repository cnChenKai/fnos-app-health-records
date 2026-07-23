import { defineEventHandler, getRouterParam, readBody } from "h3";
import { updateMember } from "../../../services/member.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const memberId = getRouterParam(event, "id") || "";
  return ok(updateMember(getRequestUser(event), memberId, (await readBody(event)) || {}));
});
