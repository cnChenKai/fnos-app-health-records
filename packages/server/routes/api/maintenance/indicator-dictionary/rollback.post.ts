import { createError, defineEventHandler, readBody } from "h3";
import { rollbackRemoteIndicatorDictionary } from "../../../../services/indicator-dictionary.service";
import { runIndicatorDictionaryBackfillIfNeeded } from "../../../../services/maintenance-runner.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null) as { snapshotId?: unknown } | null;
  const snapshotId = typeof body?.snapshotId === "string" ? body.snapshotId.trim() : "";
  if (!snapshotId) throw createError({ statusCode: 400, statusMessage: "缺少需要回滚的快照" });
  const dictionary = rollbackRemoteIndicatorDictionary(getRequestUser(event), snapshotId);
  const normalization = runIndicatorDictionaryBackfillIfNeeded();
  return ok({ ...dictionary, normalization });
});
