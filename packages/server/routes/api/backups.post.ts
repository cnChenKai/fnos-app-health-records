import { defineEventHandler, setResponseStatus } from "h3";
import { createBackup } from "../../services/records.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  const backup = createBackup(getRequestUser(event));
  setResponseStatus(event, 201);
  const { path: _path, ...safeBackup } = backup;
  return ok(safeBackup);
});
