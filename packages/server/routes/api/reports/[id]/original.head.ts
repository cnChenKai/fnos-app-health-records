import { createError, defineEventHandler, getRouterParam, setHeader } from "h3";
import { getReportOriginalDownloadInfo } from "../../../../services/records.service";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  const info = getReportOriginalDownloadInfo(getRequestUser(event), reportId);
  if (info.directPath === null) {
    throw createError({ statusCode: 409, statusMessage: "PDF 正在生成，请稍后刷新后下载" });
  }
  setHeader(event, "content-type", "application/pdf");
  setHeader(event, "content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(info.filename)}`);
  setHeader(event, "cache-control", "private, no-store");
  setHeader(event, "x-content-type-options", "nosniff");
  event.context.skipRequestLog = true;
  return null;
});
