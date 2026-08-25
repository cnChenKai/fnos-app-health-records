#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const requestedBump = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const nonInteractive = args.includes("--yes") || process.env.CI === "true" || !input.isTTY;
const validBumps = new Set(["major", "minor", "patch"]);

function git(args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function hasGitHead() {
  try {
    git(["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function lastTag() {
  try {
    return git(["describe", "--tags", "--abbrev=0"]);
  } catch {
    return "";
  }
}

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function changedFilesSinceBase() {
  if (!hasGitHead()) return [];
  const tag = lastTag();
  const baseArgs = tag ? [tag, "HEAD"] : ["HEAD"];
  const committed = lines(git(["diff", "--name-only", ...baseArgs]));
  const staged = lines(git(["diff", "--name-only", "--cached"]));
  const unstaged = lines(git(["diff", "--name-only"]));
  return [...new Set([...committed, ...staged, ...unstaged])];
}

function commitMessagesSinceBase() {
  if (!hasGitHead()) return [];
  const tag = lastTag();
  const range = tag ? `${tag}..HEAD` : "HEAD";
  return lines(git(["log", "--format=%s%n%b", range]));
}

function autoBump() {
  const forced = process.env.VERSION_BUMP || process.env.RELEASE_BUMP;
  if (forced) {
    if (!validBumps.has(forced)) throw new Error("VERSION_BUMP must be major, minor, or patch.");
    return forced;
  }

  const messages = commitMessagesSinceBase();
  const files = changedFilesSinceBase();
  const text = messages.join("\n");
  if (/BREAKING CHANGE|^[a-z]+(?:\([^)]+\))?!:/m.test(text)) return "major";
  if (messages.some((message) => /^feat(?:\([^)]+\))?:/.test(message))) return "minor";
  if (files.some((file) => file.startsWith("packages/server/database/"))) return "minor";
  return "patch";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseVersion(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Only stable semver versions are supported, got: ${value}`);
  return match.slice(1).map(Number);
}

function nextVersion(current, target) {
  if (target === "auto") return nextVersion(current, autoBump());
  if (/^\d+\.\d+\.\d+$/.test(target || "")) return target;
  if (!validBumps.has(target)) {
    throw new Error("Usage: pnpm version:bump [auto|major|minor|patch|x.y.z] or npm run version:bump -- [auto|major|minor|patch|x.y.z]");
  }
  const [major, minor, patch] = parseVersion(current);
  if (target === "major") return `${major + 1}.0.0`;
  if (target === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function promptBump(currentVersion) {
  if (requestedBump) return requestedBump;
  if (nonInteractive) return "patch";
  const patch = nextVersion(currentVersion, "patch");
  const minor = nextVersion(currentVersion, "minor");
  const major = nextVersion(currentVersion, "major");
  const rl = createInterface({ input, output });
  try {
    console.log(`Current version: ${currentVersion}`);
    console.log(`1) patch  ${patch}`);
    console.log(`2) minor  ${minor}`);
    console.log(`3) major  ${major}`);
    console.log("4) custom");
    const choice = (await rl.question("Select version type [1]: ")).trim() || "1";
    if (choice === "1" || choice.toLowerCase() === "patch") return "patch";
    if (choice === "2" || choice.toLowerCase() === "minor") return "minor";
    if (choice === "3" || choice.toLowerCase() === "major") return "major";
    if (choice === "4" || choice.toLowerCase() === "custom") {
      return (await rl.question("Enter version (x.y.z): ")).trim();
    }
    throw new Error("Invalid version type selection.");
  } finally {
    rl.close();
  }
}

function updateChangelog(path, currentVersion, targetVersion) {
  let content = readFileSync(path, "utf8");
  if (content.includes(`## ${targetVersion} - `)) return;
  if (content.includes(`## ${currentVersion} - Unreleased`)) {
    // Freeze the version being released, then start a clean section for the next version.
    content = content.replace(
      `## ${currentVersion} - Unreleased`,
      `## ${currentVersion}\n\n## ${targetVersion} - Unreleased\n\n### Added\n\n- 待补充本版本变更说明。\n\n### Changed\n\n### Fixed`,
    );
  } else {
    content = content.replace(
      "本项目遵循语义化版本。\n",
      `本项目遵循语义化版本。\n\n## ${targetVersion} - Unreleased\n\n### Changed\n\n- 待补充本版本变更说明。\n`
    );
  }
  writeFileSync(path, content, "utf8");
}

function updateReleaseProcess(path, targetVersion) {
  let content = readFileSync(path, "utf8");
  content = content
    .replace(/\| 应用版本 \| `[^`]+` \| `package\.json` \|/, `| 应用版本 | \`${targetVersion}\` | \`package.json\` |`)
    .replace(
      /\| fnOS manifest 版本 \| `[^`]+` \| `scripts\/prepare-package\.mjs` 从 `package\.json` 写入 \|/,
      `| fnOS manifest 版本 | \`${targetVersion}\` | \`scripts/prepare-package.mjs\` 从 \`package.json\` 写入 |`
    )
    .replace(
      /\| fnOS sub_version \| `[^`]+` \| `scripts\/prepare-package\.mjs` 生成 \|/,
      `| fnOS sub_version | \`${targetVersion}.0\` | \`scripts/prepare-package.mjs\` 生成 |`
    );
  writeFileSync(path, content, "utf8");
}

try {
  const packagePath = join(rootDir, "package.json");
  const lockPath = join(rootDir, "package-lock.json");
  const changelogPath = join(rootDir, "CHANGELOG.md");
  const releaseProcessPath = join(rootDir, "docs", "RELEASE_PROCESS.md");
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);
  const currentVersion = packageJson.version;
  const bump = await promptBump(currentVersion);
  const targetVersion = nextVersion(currentVersion, bump);

  if (targetVersion === currentVersion) {
    throw new Error(`Version is already ${targetVersion}.`);
  }

  if (dryRun) {
    console.log(`Version would be bumped: ${currentVersion} -> ${targetVersion}`);
    process.exit(0);
  }

  packageJson.version = targetVersion;
  packageLock.version = targetVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = targetVersion;
  }

  writeJson(packagePath, packageJson);
  writeJson(lockPath, packageLock);
  updateChangelog(changelogPath, currentVersion, targetVersion);
  updateReleaseProcess(releaseProcessPath, targetVersion);

  console.log(`Version bumped: ${currentVersion} -> ${targetVersion}`);
  console.log("Next: update CHANGELOG.md and template.config.json releaseNotes, then run pnpm release or npm run release.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
