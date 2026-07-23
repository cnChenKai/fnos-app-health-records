#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const template = JSON.parse(readFileSync(join(rootDir, "template.config.json"), "utf8"));
const changelog = readFileSync(join(rootDir, "CHANGELOG.md"), "utf8");
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

check(packageJson.name === template.appName, "package.json name must match template.config.json appName.");
check(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version), "package.json version must be semver.");
check(template.displayName === "健康档案", "template displayName should be 健康档案.");
check(template.appDescription && template.appDescription.length >= 80, "template appDescription is too short for application center.");
check(template.releaseNotes?.summary && template.releaseNotes.summary.length >= 8, "releaseNotes.summary is missing or too short.");
check(Array.isArray(template.releaseNotes?.highlights) && template.releaseNotes.highlights.length >= 3, "releaseNotes.highlights needs at least 3 items.");
check(changelog.includes(packageJson.version), `CHANGELOG.md must mention version ${packageJson.version}.`);
check(existsSync(join(rootDir, "docs", "VERSION_MIGRATION.md")), "Missing docs/VERSION_MIGRATION.md.");
check(existsSync(join(rootDir, "docs", "RELEASE_PROCESS.md")), "Missing docs/RELEASE_PROCESS.md.");

if (errors.length) {
  console.error("Release validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Release validation passed for ${template.appTitle} ${packageJson.version}.`);
