#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipBuild = args.includes("--skip-build");
const noCommit = args.includes("--no-commit");
const noTag = args.includes("--no-tag");
const bumpArg = args.find((arg) => !arg.startsWith("--"));

function run(command, commandArgs, options = {}) {
  if (dryRun && options.mutates) {
    console.log(`[dry-run] ${command} ${commandArgs.join(" ")}`);
    return "";
  }
  return execFileSync(command, commandArgs, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
  })?.trim() || "";
}

function git(commandArgs, options = {}) {
  return run("git", commandArgs, options);
}

function packageManager() {
  return process.env.npm_execpath?.includes("pnpm") ? "pnpm" : "npm";
}

function runScript(scriptName, extraArgs = [], options = {}) {
  const manager = packageManager();
  if (manager === "pnpm") {
    return run("pnpm", [scriptName, ...extraArgs], options);
  }
  return run("npm", ["run", scriptName, ...(extraArgs.length ? ["--", ...extraArgs] : [])], options);
}

function ensureGitReady() {
  try {
    git(["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error("Release requires at least one git commit. Create the initial commit before running pnpm release.");
  }
  const status = git(["status", "--porcelain"]);
  if (status) {
    throw new Error("Release requires a clean working tree. Commit or stash current changes before running pnpm release.");
  }
}

function readVersion() {
  const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  return packageJson.version;
}

function ensureTagAvailable(tagName) {
  try {
    git(["rev-parse", "--verify", tagName]);
    throw new Error(`Git tag ${tagName} already exists.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) throw error;
  }
}

try {
  if (dryRun) {
    const bumpArgs = bumpArg ? [bumpArg, "--dry-run"] : ["--yes", "--dry-run"];
    runScript("version:bump", bumpArgs, { inherit: true });
    console.log("[dry-run] release:ci");
    console.log("[dry-run] git add package.json package-lock.json CHANGELOG.md docs/RELEASE_PROCESS.md");
    console.log("[dry-run] git commit -m chore: release v<version>");
    console.log("[dry-run] git tag -a v<version> -m 健康档案 v<version>");
    process.exit(0);
  }

  ensureGitReady();
  const bumpArgs = bumpArg ? [bumpArg] : [];
  runScript("version:bump", bumpArgs, { inherit: true });
  const version = readVersion();
  const tagName = `v${version}`;
  ensureTagAvailable(tagName);

  if (!skipBuild) {
    runScript("release:ci", [], { inherit: true });
  }

  if (!noCommit) {
    git(["add", "package.json", "package-lock.json", "CHANGELOG.md", "docs/RELEASE_PROCESS.md"], { mutates: true });
    git(["commit", "-m", `chore: release ${tagName}`], { inherit: true, mutates: true });
  }

  if (!noTag) {
    git(["tag", "-a", tagName, "-m", `健康档案 ${tagName}`], { inherit: true, mutates: true });
  }

  console.log(`Release ${tagName} is ready.`);
  console.log(`Push with: git push origin main ${tagName}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
