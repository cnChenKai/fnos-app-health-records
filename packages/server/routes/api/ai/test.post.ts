import { createError, defineEventHandler, readBody } from "h3";
import { testAiConnection } from "../../../services/ai-settings.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";
import { isAdministrator } from "../../../domain/request-user";

export default defineEventHandler(async (event) => {
  if (!isAdministrator(getRequestUser(event))) throw createError({ statusCode: 403, statusMessage: "仅管理员可测试 AI 配置" });
  return ok(await testAiConnection((await readBody(event)) || {}));
});
