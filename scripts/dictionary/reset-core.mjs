#!/usr/bin/env node

/**
 * 显式重建指标字典（仅限未发版开发期使用）。
 *
 * 使用场景：dictionary/core 或 dictionary/remote 下的字典内容已修改，
 * 但 revision 未递增（未发版）。服务不会静默替换同 revision 内容，
 * 因此需要先执行本脚本清空对应层快照与激活状态，下次物化时从字典文件重建。
 * 历史更新记录（indicator_dictionary_updates）会保留，snapshot_id 自动置空。
 *
 * 默认清理 core 层；`--layer=remote` 清理 remote 层。
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

const storageDir = process.env.STORAGE_DIR || resolve(process.cwd(), ".data");
const databasePath = join(storageDir, "db", "health-records.sqlite");

if (!existsSync(databasePath)) {
  console.error(`未找到数据库文件：${databasePath}`);
  process.exit(1);
}

const db = new DatabaseSync(databasePath);
const layerArg = process.argv.find((argument) => argument.startsWith("--layer="));
const layer = layerArg ? layerArg.slice("--layer=".length) : "core";
if (!["core", "remote"].includes(layer)) {
  console.error(`不支持的字典层：${layer}（仅支持 core/remote）`);
  process.exit(1);
}
try {
  db.exec("BEGIN IMMEDIATE");
  const stateResult = db.prepare("DELETE FROM indicator_dictionary_state WHERE layer = ?").run(layer);
  const snapshotResult = db.prepare("DELETE FROM indicator_dictionary_snapshots WHERE layer = ?").run(layer);
  db.exec("COMMIT");
  console.log(
    `已清空 ${layer} 字典激活状态（${Number(stateResult.changes || 0)} 条）与快照（${Number(snapshotResult.changes || 0)} 条）。` +
    `下次物化时会从 dictionary/${layer} 重新构建当前 revision。`,
  );
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}
