import { createError, defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { getSystemSummary } from "../../services/system.service";
import { getRequestAccessMode } from "../../utils/access-mode";
import { getRequestUser } from "../../utils/request-user";
import { isAdministrator } from "../../domain/request-user";

export default defineEventHandler((event) => {
  if (!isAdministrator(getRequestUser(event))) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看系统运行信息" });
  return ok(getSystemSummary(getRequestAccessMode(event)));
});
