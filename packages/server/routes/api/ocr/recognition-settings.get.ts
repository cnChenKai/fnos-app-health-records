import { createError, defineEventHandler } from "h3";
import { isAdministrator } from "../../../domain/request-user";
import { getOcrRecognitionSettings } from "../../../services/ocr-recognition-settings.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  if (!isAdministrator(getRequestUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "仅管理员可查看 OCR 识别设置" });
  }
  return ok(getOcrRecognitionSettings(false));
});
