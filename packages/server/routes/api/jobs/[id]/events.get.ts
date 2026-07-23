import { defineEventHandler, getRouterParam } from "h3";
import { listProcessingJobEvents } from "../../../../services/job-runner.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  return ok(listProcessingJobEvents(getRequestUser(event), getRouterParam(event, "id") || ""));
});
