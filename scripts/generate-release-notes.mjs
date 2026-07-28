#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const outputPath = outputArg ? resolve(rootDir, outputArg.slice("--output=".length)) : null;
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const template = JSON.parse(readFileSync(join(rootDir, "template.config.json"), "utf8"));
const changelog = readFileSync(join(rootDir, "CHANGELOG.md"), "utf8");
const migrationsSource = readFileSync(join(rootDir, "packages", "server", "database", "migrations.ts"), "utf8");
const schemaVersions = [...migrationsSource.matchAll(/version:\s*(\d+)/g)].map((match) => Number(match[1]));
const schemaVersion = Math.max(...schemaVersions);

function extractChangelogSection(version) {
  const lines = changelog.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => line.startsWith("## ") ? [{ index, title: line.slice(3).trim() }] : []);
  const heading = headings.find((item) => item.title === version || item.title.startsWith(`${version} -`));
  if (!heading) {
    throw new Error(`CHANGELOG.md must contain a non-empty section for ${version} before generating GitHub release notes.`);
  }
  const next = headings.find((item) => item.index > heading.index);
  const body = lines.slice(heading.index + 1, next?.index).join("\n").trim();
  if (!body) throw new Error(`CHANGELOG.md section for ${version} is empty.`);
  return body;
}

function bulletLines(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

const version = packageJson.version;
const changelogBody = extractChangelogSection(version);
const highlights = Array.isArray(template.releaseNotes?.highlights) ? template.releaseNotes.highlights : [];
const notes = `# ${template.appTitle} v${version}

## 本版本变更

${changelogBody}

## 发布摘要

- ${template.releaseNotes?.summary || "本版本更新。"}
- 应用标识：\`${template.appName}\`
- 目标数据库版本：\`v${schemaVersion}\`

## 重点能力

${bulletLines(highlights)}

## 发布产物

- \`dist/app.tgz\`：fnOS 应用载荷归档
- \`dist/${template.appName}-${version}.fpk\`：可安装 fnOS 应用包

## 数据库升级

- 应用启动时会按需执行 SQLite schema 迁移。
- 存在待执行 schema 迁移时，会在迁移前自动创建轻量数据库备份。
- 跨版本升级基于 \`schema_migrations\` 逐条补齐，不依赖用户安装过中间版本。

## 说明

- Release notes 由 \`scripts/generate-release-notes.mjs\` 根据 \`CHANGELOG.md\` 当前版本段落生成。
- 版本来源：\`package.json\`
- 应用配置来源：\`template.config.json\`
- 迁移注册表：\`packages/server/database/migrations.ts\`
`;

if (outputPath) {
  writeFileSync(outputPath, notes, "utf8");
} else {
  process.stdout.write(notes);
}
