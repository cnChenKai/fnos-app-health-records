import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  createError,
  defineEventHandler,
  getHeader,
  getMethod,
  getRouterParam,
  sendStream,
  setHeader,
  setResponseStatus
} from "h3";
import { getBackupDownload } from "../../../../services/records.service";
import { getRequestUser } from "../../../../utils/request-user";
import { resolveSingleByteRange } from "../../../../utils/http-byte-range";

export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "备份 ID 无效" });
  const backup = getBackupDownload(getRequestUser(event), id);
  const range = resolveSingleByteRange(getHeader(event, "range"), backup.sizeBytes);
  setHeader(event, "content-type", "application/gzip");
  setHeader(event, "content-disposition", `attachment; filename="${backup.filename}"`);
  setHeader(event, "cache-control", "private, no-store");
  setHeader(event, "accept-ranges", "bytes");
  setHeader(event, "x-content-type-options", "nosniff");
  event.context.skipRequestLog = true;

  if (range.kind === "unsatisfiable") {
    setHeader(event, "content-range", `bytes */${backup.sizeBytes}`);
    setHeader(event, "content-length", "0");
    setResponseStatus(event, 416, "Range Not Satisfiable");
    return null;
  }

  if (range.kind === "partial") {
    setResponseStatus(event, 206);
    setHeader(event, "content-range", `bytes ${range.start}-${range.end}/${backup.sizeBytes}`);
    setHeader(event, "content-length", String(range.length));
    if (getMethod(event) === "HEAD") return null;
    return sendStream(
      event,
      Readable.toWeb(createReadStream(backup.path, { start: range.start, end: range.end })) as unknown as ReadableStream
    );
  }

  setHeader(event, "content-length", String(backup.sizeBytes));
  if (getMethod(event) === "HEAD") return null;
  return sendStream(event, Readable.toWeb(createReadStream(backup.path)) as unknown as ReadableStream);
});
