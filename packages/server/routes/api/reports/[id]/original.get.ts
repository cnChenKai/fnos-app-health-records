import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createError, defineEventHandler, getRouterParam, sendStream, setHeader } from "h3";
import { getReportOriginalDownload } from "../../../../services/records.service";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  const file = await getReportOriginalDownload(getRequestUser(event), reportId);
  const stream = createReadStream(file.path);
  setHeader(event, "content-type", file.mimeType);
  setHeader(event, "content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  setHeader(event, "cache-control", "private, no-store");
  setHeader(event, "x-content-type-options", "nosniff");
  event.context.skipRequestLog = true;
  return sendStream(event, Readable.toWeb(stream) as unknown as ReadableStream);
});
