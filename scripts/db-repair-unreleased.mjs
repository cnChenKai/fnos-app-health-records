#!/usr/bin/env node

/**
 * 显式修复未正式发布阶段（v17-v19）的 schema 迁移记录。
 *
 * 背景：v17-v19 只存在于发版前的开发过程，已折叠回 v16。服务启动时检测到
 * 这些版本会拒绝启动（避免静默改写迁移历史），本脚本是唯一允许的修复入口：
 * 先备份数据库文件，再删除 v17-v19 的 schema_migrations 记录。
 */

import { copyFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

const storageDir = process.env.STORAGE_DIR || resolve(process.cwd(), ".data");
const databasePath = join(storageDir, "db", "health-records.sqlite");

if (!existsSync(databasePath)) {
  console.error(`未找到数据库文件：${databasePath}`);
  process.exit(1);
}

const db = new DatabaseSync(databasePath);
try {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  const currentVersion = row?.version ?? 0;
  if (currentVersion <= 16 || currentVersion > 19) {
    console.log(`当前 schema 版本为 v${currentVersion}，无需修复。`);
    process.exit(0);
  }

  const backupPath = `${databasePath}.bak-unreleased-v${currentVersion}-${Date.now()}`;
  copyFileSync(databasePath, backupPath);
  console.log(`已备份数据库到 ${backupPath}`);

  const result = db.prepare("DELETE FROM schema_migrations WHERE version > 16 AND version <= 19").run();
  console.log(`已删除 ${Number(result.changes || 0)} 条未发版迁移记录（v17-v19），折叠回 v16。可以重新启动服务。`);
} finally {
  db.close();
}
