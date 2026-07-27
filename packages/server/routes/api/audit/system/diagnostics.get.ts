import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { defineEventHandler, sendStream, setHeader } from "h3";
import { createDiagnosticBundle } from "../../../../services/diagnostic-export.service";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const bundle = createDiagnosticBundle(getRequestUser(event));
  const stream = createReadStream(bundle.path);
  stream.once("close", bundle.cleanup);
  setHeader(event, "content-type", "application/gzip");
  setHeader(event, "content-length", String(bundle.sizeBytes));
  setHeader(event, "content-disposition", `attachment; filename="${bundle.filename}"`);
  setHeader(event, "cache-control", "private, no-store");
  event.context.skipRequestLog = true;
  return sendStream(event, Readable.toWeb(stream) as unknown as ReadableStream);
});
