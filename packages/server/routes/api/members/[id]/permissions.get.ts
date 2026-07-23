import { defineEventHandler, getRouterParam } from "h3";
import { listMemberPermissions } from "../../../../services/member.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  return ok(listMemberPermissions(getRequestUser(event), getRouterParam(event, "id") || ""));
});
