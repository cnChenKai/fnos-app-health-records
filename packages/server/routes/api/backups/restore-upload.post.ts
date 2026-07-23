import {
  assertBodySize,
  createError,
  defineEventHandler,
  readMultipartFormData
} from "h3";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { restoreUploadedBackup } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

const maxUploadedBackupBytes = 1024 * 1024 * 1024;

export default defineEventHandler(async (event) => {
  await assertBodySize(event, maxUploadedBackupBytes);
  const parts = await readMultipartFormData(event);
  const backup = parts.find((part) => (part.name === "backup" || part.name === "file") && part.filename);
  if (!backup?.filename) throw createError({ statusCode: 400, statusMessage: "请选择备份文件" });
  if (!/\.tar\.gz$/i.test(backup.filename)) {
    throw createError({ statusCode: 400, statusMessage: "仅支持 .tar.gz 完整应用备份" });
  }

  const tempDirectory = mkdtempSync(join(tmpdir(), "health-records-uploaded-backup-"));
  const tempArchivePath = join(tempDirectory, basename(backup.filename));
  try {
    writeFileSync(tempArchivePath, backup.data, { mode: 0o600 });
    chmodSync(tempArchivePath, 0o600);
    return ok({
      ...restoreUploadedBackup(getRequestUser(event), tempArchivePath),
      filename: backup.filename
    });
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
