import { getDatabase } from "../database/client";
import { writeLog } from "../utils/logger";
import { purgeExpiredReports } from "./records.service";
import { runFileGarbageCollection, scanOrphanStorageFiles } from "./file-gc.service";
import { backfillBuiltinIndicatorNormalizations } from "./indicator-normalization.service";
import { startIndicatorNormalizationTaskRunner } from "./indicator-normalization-task.service";
import { activeIndicatorDictionaryVersion } from "./indicator-dictionary.service";

const maintenanceIntervalMs = 6 * 60 * 60_000;
const orphanScanIntervalMs = 7 * 24 * 60 * 60_000;
const indicatorDictionaryVersionSetting = "maintenance.indicator_dictionary_version";
let startTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

function lastOrphanScanAt() {
  const row = getDatabase().prepare(`
    SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'maintenance.orphan_scan_at'
  `).get() as { valueJson: string } | undefined;
  if (!row) return 0;
  try {
    const value = JSON.parse(row.valueJson);
    return typeof value === "string" ? Date.parse(value) || 0 : 0;
  } catch {
    return 0;
  }
}

function markOrphanScan() {
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json, updated_at)
    VALUES ('maintenance.orphan_scan_at', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify(new Date().toISOString()));
}

function indicatorDictionaryVersion() {
  const row = getDatabase().prepare(`
    SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?
  `).get(indicatorDictionaryVersionSetting) as { valueJson: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.valueJson);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function markIndicatorDictionaryVersion() {
  const version = activeIndicatorDictionaryVersion();
  getDatabase().prepare(`
    INSERT INTO app_settings (setting_key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(indicatorDictionaryVersionSetting, JSON.stringify(version));
}

export function runIndicatorDictionaryBackfillIfNeeded() {
  const currentVersion = activeIndicatorDictionaryVersion();
  const previousVersion = indicatorDictionaryVersion();
  if (previousVersion === currentVersion) return null;
  const result = backfillBuiltinIndicatorNormalizations();
  markIndicatorDictionaryVersion();
  return { previousVersion, ...result };
}

export async function runMaintenanceCycle() {
  if (running) return { skipped: true as const };
  running = true;
  try {
    const indicatorNormalization = runIndicatorDictionaryBackfillIfNeeded();
    const recycleBin = purgeExpiredReports();
    let orphanScan: ReturnType<typeof scanOrphanStorageFiles> | null = null;
    if (Date.now() - lastOrphanScanAt() >= orphanScanIntervalMs) {
      orphanScan = scanOrphanStorageFiles();
      markOrphanScan();
    }
    const fileGc = runFileGarbageCollection();
    if (indicatorNormalization || recycleBin.deleted || recycleBin.failed || fileGc.deleted || fileGc.failed || orphanScan?.queued) {
      await writeLog(recycleBin.failed || fileGc.failed ? "warn" : "info", "maintenance cycle completed", {
        indicatorNormalization,
        recycleBin,
        fileGc,
        orphanScan
      });
    }
    return { skipped: false as const, indicatorNormalization, recycleBin, fileGc, orphanScan };
  } finally {
    running = false;
  }
}

export function startMaintenanceRunner() {
  startIndicatorNormalizationTaskRunner();
  if (startTimer || intervalTimer) return;
  startTimer = setTimeout(() => {
    startTimer = null;
    void runMaintenanceCycle().catch((error) => {
      void writeLog("error", "maintenance cycle failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, 15_000);
  startTimer.unref?.();
  intervalTimer = setInterval(() => {
    void runMaintenanceCycle().catch((error) => {
      void writeLog("error", "maintenance cycle failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, maintenanceIntervalMs);
  intervalTimer.unref?.();
}
