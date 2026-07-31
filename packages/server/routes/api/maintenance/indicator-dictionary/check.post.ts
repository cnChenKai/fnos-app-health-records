import { defineEventHandler } from "h3";
import { checkRemoteIndicatorDictionary } from "../../../../services/indicator-dictionary.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  return ok(await checkRemoteIndicatorDictionary(getRequestUser(event)));
});
