import { defineEventHandler, readBody } from "h3";
import { createMember } from "../../services/member.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler(async (event) => {
  return ok(createMember(getRequestUser(event), (await readBody(event)) || {}));
});
