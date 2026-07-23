import { existsSync, readdirSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import templateConfig from "../../../template.config.json" with { type: "json" };
import { getAppConfig } from "../utils/runtime-config";
import { getDatabaseStatus } from "../database/client";
import type { RequestAccessMode } from "../utils/access-mode";

function directorySize(path: string) {
  if (!existsSync(path)) return 0;
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let entries: string[];
    try { entries = readdirSync(current); } catch { continue; }
    for (const entry of entries) {
      const target = join(current, entry);
      try {
        const stat = statSync(target);
        if (stat.isDirectory()) stack.push(target);
        else total += stat.size;
      } catch {
        // Ignore files that may disappear while a background task is writing.
      }
    }
  }
  return total;
}

export function getSystemSummary(accessMode: RequestAccessMode) {
  const config = getAppConfig();
  const storage = {
    storageDir: config.storageDir,
    databaseBytes: directorySize(join(config.storageDir, "db")),
    reportsBytes: directorySize(join(config.storageDir, "reports")),
    thumbnailsBytes: directorySize(join(config.storageDir, "thumbnails")),
    backupsBytes: directorySize(join(config.storageDir, "backups")),
    logsBytes: directorySize(join(config.storageDir, "logs")),
    modelsBytes: directorySize(join(config.storageDir, "models"))
  };

  return {
    appName: config.appName,
    appTitle: config.appTitle,
    appVersion: config.appVersion,
    accessMode,
    gatewayPrefix: config.gatewayPrefix,
    appPort: config.appPort,
    servicePort: config.servicePort,
    runtime: "nitro",
    nodePlatform: platform(),
    nodeArch: arch(),
    processUptimeSec: Math.floor(process.uptime()),
    database: getDatabaseStatus(),
    storage: {
      ...storage,
      totalKnownBytes: storage.databaseBytes + storage.reportsBytes + storage.thumbnailsBytes
        + storage.backupsBytes + storage.logsBytes + storage.modelsBytes
    }
  };
}

export function getAboutSummary(accessMode: RequestAccessMode) {
  const config = getAppConfig();
  const database = getDatabaseStatus();

  return {
    appName: config.appName,
    appTitle: config.appTitle,
    appVersion: config.appVersion,
    appDescription: templateConfig.appDescription,
    maintainer: templateConfig.maintainer,
    maintainerUrl: templateConfig.maintainerUrl,
    distributor: templateConfig.distributor,
    distributorUrl: templateConfig.distributorUrl,
    source: templateConfig.source,
    osMinVersion: templateConfig.osMinVersion,
    accessMode,
    runtime: {
      name: "Nitro",
      node: process.version,
      platform: platform(),
      arch: arch()
    },
    database: {
      driver: database.driver,
      schemaVersion: database.schemaVersion,
      appliedSchemaVersion: database.appliedSchemaVersion,
      journalMode: database.journalMode,
      integrity: database.integrity
    }
  };
}
