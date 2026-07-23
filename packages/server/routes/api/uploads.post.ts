import {
  assertBodySize,
  createError,
  defineEventHandler,
  readMultipartFormData,
  setResponseStatus
} from "h3";
import { createUpload } from "../../services/upload.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

const maxRequestBytes = 205 * 1024 * 1024;

function textPart(parts: Awaited<ReturnType<typeof readMultipartFormData>>, name: string) {
  const part = parts.find((item) => item.name === name && !item.filename);
  return part ? Buffer.from(part.data).toString("utf8") : "";
}

export default defineEventHandler(async (event) => {
  await assertBodySize(event, maxRequestBytes);
  const parts = await readMultipartFormData(event);
  const memberId = textPart(parts, "memberId").trim();
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "请选择报告所属成员" });

  let rotations: number[] = [];
  const manifest = textPart(parts, "manifest");
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as { pages?: Array<{ rotation?: number }> };
      rotations = Array.isArray(parsed.pages) ? parsed.pages.map((page) => Number(page.rotation || 0)) : [];
    } catch {
      throw createError({ statusCode: 400, statusMessage: "页面顺序信息无效" });
    }
  }

  const files = parts.filter((part) => part.name === "files" && part.filename).map((part, index) => ({
    originalName: part.filename || `page-${index + 1}`,
    declaredType: part.type,
    data: part.data,
    rotation: rotations[index] || 0
  }));
  const result = createUpload(getRequestUser(event), memberId, files);
  setResponseStatus(event, 201);
  return ok(result);
});
