import { createError, defineEventHandler, getQuery } from "h3";
import { listProcessingJobs } from "../../services/upload.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  const reportId = getQuery(event).reportId;
  if (typeof reportId !== "string" || !reportId) {
    throw createError({ statusCode: 400, statusMessage: "缺少 reportId" });
  }
  return ok(listProcessingJobs(getRequestUser(event), reportId));
});
