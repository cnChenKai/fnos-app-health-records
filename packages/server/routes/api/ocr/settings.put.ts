import { createError, defineEventHandler, readBody } from "h3";
import { saveOcrInstallSettings } from "../../../services/ocr-runtime.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";
import { isAdministrator } from "../../../domain/request-user";

export default defineEventHandler(async (event) => {
  if (!isAdministrator(getRequestUser(event))) throw createError({ statusCode: 403, statusMessage: "仅管理员可修改 OCR 安装设置" });
  try {
    return ok(saveOcrInstallSettings((await readBody(event)) || {}));
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "OCR 安装设置无效" });
  }
});
