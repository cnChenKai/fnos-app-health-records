import { defineEventHandler, getRequestURL } from "h3";
import { writeLog } from "../utils/logger";

export default defineEventHandler((event) => {
  const startedAt = Date.now();
  const url = getRequestURL(event);
  const response = event.node!.res!;

  response.on("finish", () => {
    void writeLog("info", "request", {
      method: event.method,
      path: url.pathname,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
});
