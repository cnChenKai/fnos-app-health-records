import { createError, defineEventHandler, getRouterParam } from "h3";
import { deleteBackup } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "备份 ID 无效" });
  return ok(deleteBackup(getRequestUser(event), id));
});
