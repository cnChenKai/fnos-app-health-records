import { defineEventHandler, getQuery } from "h3";
import { searchIndicatorCatalog } from "../../../../services/indicator-normalization.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const search = typeof query.q === "string" ? query.q : "";
  return ok(searchIndicatorCatalog(getRequestUser(event), search));
});
