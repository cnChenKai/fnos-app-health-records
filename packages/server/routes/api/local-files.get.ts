import { createError, defineEventHandler, getQuery } from "h3";
import { isAdministrator } from "../../domain/request-user";
import { listLocalImportDirectory } from "../../services/local-file-import.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  if (!isAdministrator(getRequestUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "仅管理员可浏览 NAS 文件" });
  }
  const query = getQuery(event);
  return ok(listLocalImportDirectory(query.rootId, query.path));
});
