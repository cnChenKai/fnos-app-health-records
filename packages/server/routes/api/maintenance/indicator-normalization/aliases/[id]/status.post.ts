import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { setIndicatorAliasEnabled } from "../../../../../../services/indicator-normalization.service";
import { ok } from "../../../../../../utils/api-response";
import { getRequestUser } from "../../../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const aliasId = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => null) as { enabled?: unknown; reason?: unknown } | null;
  if (!body || typeof body.enabled !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "别名状态参数无效" });
  }
  return ok(setIndicatorAliasEnabled(
    getRequestUser(event),
    aliasId,
    body.enabled,
    typeof body.reason === "string" ? body.reason : null
  ));
});
