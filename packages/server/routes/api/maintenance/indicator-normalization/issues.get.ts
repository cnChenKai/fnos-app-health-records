import { defineEventHandler } from "h3";
import { listIndicatorNormalizationIssues } from "../../../../services/indicator-normalization.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  return ok(listIndicatorNormalizationIssues(getRequestUser(event)));
});
