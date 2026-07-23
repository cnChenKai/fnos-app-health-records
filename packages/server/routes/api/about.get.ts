import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { getRequestAccessMode } from "../../utils/access-mode";
import { getRequestUser } from "../../utils/request-user";
import { getAboutSummary } from "../../services/system.service";

export default defineEventHandler((event) => {
  getRequestUser(event);
  return ok(getAboutSummary(getRequestAccessMode(event)));
});
