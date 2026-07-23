import { defineEventHandler } from "h3";
import { normalizeAllObservationsWithAiFallback } from "../../../services/indicator-normalization.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  return ok(await normalizeAllObservationsWithAiFallback(getRequestUser(event)));
});
