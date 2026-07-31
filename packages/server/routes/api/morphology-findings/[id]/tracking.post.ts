import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { setMorphologyTracking } from "../../../../services/morphology-finding.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少形态发现 ID" });
  return ok(setMorphologyTracking(getRequestUser(event), id, await readBody(event) || {}));
});
