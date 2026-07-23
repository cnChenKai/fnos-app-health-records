import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createError, defineEventHandler, getRouterParam, sendStream, setHeader } from "h3";
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
  return sendStream(event, Readable.toWeb(createReadStream(backup.path)) as unknown as ReadableStream);
});
