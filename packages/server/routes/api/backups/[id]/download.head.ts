import { createError, defineEventHandler, getRouterParam, setHeader } from "h3";
import { getBackupDownload } from "../../../../services/records.service";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "备份 ID 无效" });
  const backup = getBackupDownload(getRequestUser(event), id);
  setHeader(event, "content-type", "application/gzip");
  setHeader(event, "content-length", String(backup.sizeBytes));
  setHeader(event, "content-disposition", `attachment; filename="${backup.filename}"`);
  setHeader(event, "cache-control", "private, no-store");
  setHeader(event, "accept-ranges", "bytes");
  setHeader(event, "x-content-type-options", "nosniff");
  event.context.skipRequestLog = true;
  return null;
});
