import { defineEventHandler, getQuery } from "h3";
import { getIndicatorNormalizationTask } from "../../../services/indicator-normalization-task.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const id = typeof query.id === "string" ? query.id : undefined;
  return ok(getIndicatorNormalizationTask(getRequestUser(event), id));
});
