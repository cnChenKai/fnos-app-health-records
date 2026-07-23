#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const template = JSON.parse(readFileSync(join(rootDir, "template.config.json"), "utf8"));
const migrationsSource = readFileSync(join(rootDir, "packages", "server", "database", "migrations.ts"), "utf8");
const versions = [...migrationsSource.matchAll(/version:\s*(\d+)/g)].map((match) => Number(match[1]));
const schemaVersion = Math.max(...versions);

const info = {
  appName: template.appName,
  appTitle: template.appTitle,
  displayName: template.displayName,
  version: packageJson.version,
  subVersion: `${packageJson.version}.0`,
  schemaVersion,
  releaseSummary: template.releaseNotes?.summary || "",
  releaseHighlights: template.releaseNotes?.highlights || []
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(info, null, 2));
} else {
  for (const [key, value] of Object.entries(info)) {
    console.log(`${key}=${Array.isArray(value) ? value.join("; ") : value}`);
  }
}
