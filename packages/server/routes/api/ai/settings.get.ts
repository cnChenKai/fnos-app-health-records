import { createError, defineEventHandler } from "h3";
import { getAiSettings } from "../../../services/ai-settings.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  if (!getRequestUser(event).isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看 AI 配置" });
  return ok(getAiSettings(false));
});
