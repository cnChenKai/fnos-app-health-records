import { defineEventHandler } from "h3";
import { repairUnreleasedSchemaVersions } from "../../../database/client";
import { ensureCoreDictionaryMaterialized } from "../../../services/indicator-dictionary.service";
import { startMaintenanceRunner } from "../../../services/maintenance-runner.service";
import {
  backfillLegacyMorphologyFindings,
  rebuildMorphologyTrackingIfNeeded
} from "../../../services/morphology-finding.service";
import { ok } from "../../../utils/api-response";

/**
 * 维护页触发的显式修复入口。仅在检测到未发版 schema（v17-v19）时可用，
 * 其余时间调用会直接报错；修复含自动备份，成功后补齐启动期初始化，无需重启进程。
 */
export default defineEventHandler(() => {
  const result = repairUnreleasedSchemaVersions();
  ensureCoreDictionaryMaterialized();
  backfillLegacyMorphologyFindings();
  rebuildMorphologyTrackingIfNeeded();
  startMaintenanceRunner();
  return ok(result);
});
