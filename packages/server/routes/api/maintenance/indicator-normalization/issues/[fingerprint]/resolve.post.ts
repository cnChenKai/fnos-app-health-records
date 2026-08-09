import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { resolveIndicatorNormalizationIssue } from "../../../../../../services/indicator-normalization.service";
import { ok } from "../../../../../../utils/api-response";
import { getRequestUser } from "../../../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const fingerprint = getRouterParam(event, "fingerprint") || "";
  const body = await readBody(event).catch(() => null) as {
    action?: unknown;
    canonicalKey?: unknown;
    saveAlias?: unknown;
    aliasScope?: unknown;
    reason?: unknown;
  } | null;
  if (!body || (body.action !== "confirm" && body.action !== "exclude")) {
    throw createError({ statusCode: 400, statusMessage: "治理参数无效" });
  }
  const aliasScope = body.aliasScope === "global" || body.aliasScope === "report_type"
    ? body.aliasScope
    : undefined;
  return ok(resolveIndicatorNormalizationIssue(getRequestUser(event), {
    fingerprint,
    action: body.action,
    canonicalKey: typeof body.canonicalKey === "string" ? body.canonicalKey : null,
    saveAlias: body.saveAlias === true,
    aliasScope,
    reason: typeof body.reason === "string" ? body.reason : null
  }));
});
