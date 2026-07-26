import { createError, defineEventHandler, getQuery } from "h3";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";
import { checkForUpdates } from "../../services/update-check.service";

export default defineEventHandler(async (event) => {
  getRequestUser(event);
  const refresh = getQuery(event).refresh === "1";
  try {
    return ok(await checkForUpdates(refresh));
  } catch (error) {
    throw createError({
      statusCode: 502,
      statusMessage: error instanceof Error ? error.message : "检查更新失败"
    });
  }
});
