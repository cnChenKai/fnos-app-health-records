import { defineEventHandler, getRouterParam } from "h3";
import { getProcessingJobEventDetail } from "../../../../services/job-runner.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  return ok(getProcessingJobEventDetail(getRequestUser(event), getRouterParam(event, "id") || ""));
});
