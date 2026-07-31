import { createError, defineEventHandler, getRouterParam } from "h3";
import { ignoreMorphologyFinding } from "../../../../services/morphology-finding.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少形态发现 ID" });
  return ok(ignoreMorphologyFinding(getRequestUser(event), id));
});
