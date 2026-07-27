import { defineEventHandler, readBody } from "h3";
import { enqueueIndicatorNormalizationTask } from "../../../services/indicator-normalization-task.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null);
  const full = Boolean(body && typeof body === "object" && (body as { full?: unknown }).full === true);
  return ok(enqueueIndicatorNormalizationTask(getRequestUser(event), { full }));
});
