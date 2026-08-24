import { createError, defineEventHandler } from "h3";
import { getOcrInstallSettings } from "../../../services/ocr-runtime.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";
import { isAdministrator } from "../../../domain/request-user";

export default defineEventHandler((event) => {
  if (!isAdministrator(getRequestUser(event))) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看 OCR 安装设置" });
  return ok(getOcrInstallSettings());
});
