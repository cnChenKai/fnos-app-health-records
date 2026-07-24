#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const template = JSON.parse(readFileSync(join(rootDir, "template.config.json"), "utf8"));
const migrationsSource = readFileSync(join(rootDir, "packages", "server", "database", "migrations.ts"), "utf8");
const changelog = readFileSync(join(rootDir, "CHANGELOG.md"), "utf8");
const versions = [...migrationsSource.matchAll(/version:\s*(\d+)/g)].map((match) => Number(match[1]));
const schemaVersion = Math.max(...versions);

function extractChangelogSection(version) {
  const lines = changelog.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => line.startsWith("## ") ? [{ index, title: line.slice(3).trim() }] : []);
  const exactHeading = headings.find((heading) => heading.title === version || heading.title.startsWith(`${version} -`));
  const fallbackHeading = headings.find((heading) => /-\s*Unreleased$/i.test(heading.title));
  const heading = exactHeading || fallbackHeading;
  if (heading) {
    const next = headings.find((item) => item.index > heading.index);
    return {
      version: heading.title,
      exact: heading === exactHeading,
      body: lines.slice(heading.index + 1, next?.index).join("\n").trim()
    };
  }
  return { version: "", exact: false, body: "" };
}

const changelogSection = extractChangelogSection(packageJson.version);

const info = {
  appName: template.appName,
  appTitle: template.appTitle,
  displayName: template.displayName,
  version: packageJson.version,
  subVersion: `${packageJson.version}.0`,
  schemaVersion,
  releaseSummary: template.releaseNotes?.summary || "",
  releaseHighlights: template.releaseNotes?.highlights || [],
  changelogVersion: changelogSection.version,
  changelogExact: changelogSection.exact,
  changelogBody: changelogSection.body
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(info, null, 2));
} else {
  for (const [key, value] of Object.entries(info)) {
    console.log(`${key}=${Array.isArray(value) ? value.join("; ") : value}`);
  }
}
