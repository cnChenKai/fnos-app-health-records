import { defineEventHandler, readBody } from "h3";
import { resetLocalAccountPassword } from "../../../../services/auth.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  return ok(resetLocalAccountPassword(getRequestUser(event), (await readBody(event)) || {}));
});
