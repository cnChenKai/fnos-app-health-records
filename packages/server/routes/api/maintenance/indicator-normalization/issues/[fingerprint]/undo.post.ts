import { defineEventHandler, getRouterParam, readBody } from "h3";
import { undoIndicatorGovernanceDecision } from "../../../../../../services/indicator-normalization.service";
import { ok } from "../../../../../../utils/api-response";
import { getRequestUser } from "../../../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const fingerprint = getRouterParam(event, "fingerprint") || "";
  const body = await readBody(event).catch(() => null) as { reason?: unknown } | null;
  return ok(undoIndicatorGovernanceDecision(
    getRequestUser(event),
    fingerprint,
    typeof body?.reason === "string" ? body.reason : null
  ));
});
