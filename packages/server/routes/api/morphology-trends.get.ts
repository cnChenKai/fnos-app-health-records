import { createError, defineEventHandler, getQuery } from "h3";
import { listMorphologyTracking } from "../../services/morphology-finding.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  const memberId = getQuery(event).memberId;
  if (typeof memberId !== "string" || !memberId.trim()) {
    throw createError({ statusCode: 400, statusMessage: "请选择要查看的家庭成员" });
  }
  return ok(listMorphologyTracking(getRequestUser(event), memberId.trim()));
});
