import { defineEventHandler } from "h3";
import { updateRemoteIndicatorDictionary } from "../../../../services/indicator-dictionary.service";
import { runIndicatorDictionaryBackfillIfNeeded } from "../../../../services/maintenance-runner.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const dictionary = await updateRemoteIndicatorDictionary(getRequestUser(event));
  const normalization = runIndicatorDictionaryBackfillIfNeeded();
  return ok({ ...dictionary, normalization });
});
