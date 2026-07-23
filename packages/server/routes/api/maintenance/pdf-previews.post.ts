import { defineEventHandler } from "h3";
import { regeneratePdfPagePreviews } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  return ok(await regeneratePdfPagePreviews(getRequestUser(event)));
});
