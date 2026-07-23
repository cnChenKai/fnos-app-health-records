import { defineEventHandler, getRouterParam } from "h3";
import { retryProcessingJob } from "../../../../services/job-runner.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  return ok(retryProcessingJob(getRequestUser(event), getRouterParam(event, "id") || ""));
});
