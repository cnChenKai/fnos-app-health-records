import { defineEventHandler, getQuery } from "h3";
import { listIndicatorGovernanceHistory } from "../../../../services/indicator-normalization.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const limit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : 100;
  return ok(listIndicatorGovernanceHistory(getRequestUser(event), limit));
});
