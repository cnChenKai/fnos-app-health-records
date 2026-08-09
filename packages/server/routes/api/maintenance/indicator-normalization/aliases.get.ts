import { defineEventHandler } from "h3";
import { listIndicatorAliasGovernance } from "../../../../services/indicator-normalization.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) =>
  ok(listIndicatorAliasGovernance(getRequestUser(event)))
);
