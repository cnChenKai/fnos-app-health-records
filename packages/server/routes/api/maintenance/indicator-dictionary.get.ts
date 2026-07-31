import { defineEventHandler } from "h3";
import { getIndicatorDictionaryStatus } from "../../../services/indicator-dictionary.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  return ok(getIndicatorDictionaryStatus(getRequestUser(event)));
});
