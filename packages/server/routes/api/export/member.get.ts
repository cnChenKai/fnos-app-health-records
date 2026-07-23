import { createError, defineEventHandler, getQuery, setHeader } from "h3";
import { buildMemberExportManifest } from "../../../services/records.service";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const memberId = getQuery(event).memberId;
  if (typeof memberId !== "string" || !memberId) throw createError({ statusCode: 400, statusMessage: "请选择成员" });
  const manifest = buildMemberExportManifest(getRequestUser(event), memberId);
  setHeader(event, "content-type", "application/json; charset=utf-8");
  setHeader(event, "content-disposition", `attachment; filename="health-records-${memberId}.json"`);
  return JSON.stringify(manifest, null, 2);
});
