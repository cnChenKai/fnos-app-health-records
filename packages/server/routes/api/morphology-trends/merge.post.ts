import { createError, defineEventHandler, readBody } from "h3";
import { mergeMorphologyTrackingGroups } from "../../../services/morphology-finding.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = (await readBody(event) || {}) as Record<string, unknown>;
  const memberId = typeof body.memberId === "string" ? body.memberId : "";
  const sourceGroupId = typeof body.sourceGroupId === "string" ? body.sourceGroupId : "";
  const targetGroupId = typeof body.targetGroupId === "string" ? body.targetGroupId : "";
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "请选择家庭成员" });
  return ok(mergeMorphologyTrackingGroups(getRequestUser(event), memberId, sourceGroupId, targetGroupId));
});
