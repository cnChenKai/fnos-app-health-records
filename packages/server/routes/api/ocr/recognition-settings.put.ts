import { createError, defineEventHandler, readBody } from "h3";
import { isAdministrator } from "../../../domain/request-user";
import { saveOcrRecognitionSettings } from "../../../services/ocr-recognition-settings.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  if (!isAdministrator(getRequestUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "仅管理员可修改 OCR 识别设置" });
  }
  return ok(saveOcrRecognitionSettings((await readBody(event) || {}) as Record<string, unknown>));
});
