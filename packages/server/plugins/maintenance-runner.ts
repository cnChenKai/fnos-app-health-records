import { definePlugin } from "nitro";
import { getDatabase, getUnreleasedSchemaMaintenance } from "../database/client";
import { startMaintenanceRunner } from "../services/maintenance-runner.service";

export default definePlugin(() => {
  getDatabase();
  // 未发版 schema 维护模式：不启动后台维护任务，等待修复完成
  if (getUnreleasedSchemaMaintenance()) return;
  startMaintenanceRunner();
});
