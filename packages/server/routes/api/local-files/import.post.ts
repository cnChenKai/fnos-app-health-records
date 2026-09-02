import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import { isAdministrator } from "../../../domain/request-user";
import { importLocalFiles } from "../../../services/local-file-import.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const user = getRequestUser(event);
  if (!isAdministrator(user)) {
    throw createError({ statusCode: 403, statusMessage: "仅管理员可从 NAS 导入报告" });
  }
  const body = (await readBody(event)) as {
    memberId?: unknown;
    files?: Array<{ rootId?: unknown; path?: unknown; rotation?: unknown }>;
    ocrMode?: unknown;
    remoteProcessingAccepted?: unknown;
  } | null;
  const memberId = String(body?.memberId || "").trim();
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "请选择报告所属成员" });
  const result = importLocalFiles(user, memberId, body?.files || [], {
    ocrMode: body?.ocrMode,
    remoteProcessingAccepted: body?.remoteProcessingAccepted
  });
  setResponseStatus(event, 201);
  return ok(result);
});
