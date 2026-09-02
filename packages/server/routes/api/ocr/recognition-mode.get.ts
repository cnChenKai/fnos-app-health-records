import { createError, defineEventHandler } from "h3";
import { getOcrRecognitionModeSummary } from "../../../services/ocr-recognition-settings.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  if (!getRequestUser(event).authenticated) {
    throw createError({ statusCode: 401, statusMessage: "请先登录" });
  }
  return ok(getOcrRecognitionModeSummary());
});
