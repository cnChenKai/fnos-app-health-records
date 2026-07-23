import { createError, defineEventHandler, readBody } from "h3";
import { saveAiSettings } from "../../../services/ai-settings.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  if (!getRequestUser(event).isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可修改 AI 配置" });
  return ok(saveAiSettings((await readBody(event)) || {}));
});
