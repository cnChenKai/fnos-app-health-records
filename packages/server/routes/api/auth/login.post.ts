import { defineEventHandler, readBody } from "h3";
import { login } from "../../../services/auth.service";
import { ok } from "../../../utils/api-response";

export default defineEventHandler(async (event) => {
  return ok(login(event, (await readBody(event)) || {}));
});
