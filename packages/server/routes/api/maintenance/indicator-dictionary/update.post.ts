import { defineEventHandler, readBody } from "h3";
import { updateRemoteIndicatorDictionary } from "../../../../services/indicator-dictionary.service";
import { runIndicatorDictionaryBackfillIfNeeded } from "../../../../services/maintenance-runner.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    force?: unknown;
    useBundledFallback?: unknown;
  }>(event).catch(() => null);
  const dictionary = await updateRemoteIndicatorDictionary(getRequestUser(event), {
    force: body?.force === true,
    useBundledFallback: body?.useBundledFallback === true,
  });
  const normalization = runIndicatorDictionaryBackfillIfNeeded();
  return ok({ ...dictionary, normalization });
});
