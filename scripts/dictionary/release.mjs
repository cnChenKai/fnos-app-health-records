#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = resolve(new URL("../..", import.meta.url).pathname);
const remoteDir = resolve(rootDir, "dictionary/remote");
const taxonomyPath = resolve(remoteDir, "taxonomy.json");
const indicatorsPath = resolve(remoteDir, "indicators.json");
const manifestPath = resolve(remoteDir, "manifest.json");
const revisionArg = process.argv.find((argument) => argument.startsWith("--revision="));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(script, args = []) {
  const result = spawnSync(process.execPath, [resolve(rootDir, script), ...args], {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function hasGitChanges() {
  const paths = ["dictionary/remote/taxonomy.json", "dictionary/remote/indicators.json"];
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", ...paths], {
    cwd: rootDir,
    stdio: "ignore"
  });
  if (tracked.status !== 0) return true;
  const working = spawnSync("git", ["diff", "--quiet", "--", ...paths], { cwd: rootDir });
  const staged = spawnSync("git", ["diff", "--cached", "--quiet", "--", ...paths], { cwd: rootDir });
  return working.status !== 0 || staged.status !== 0;
}

const taxonomy = readJson(taxonomyPath);
const indicators = readJson(indicatorsPath);
const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;
if (taxonomy.revision !== indicators.revision) {
  throw new Error("taxonomy.json 与 indicators.json revision 不一致");
}
run("scripts/dictionary/validate.mjs", ["--layer=remote"]);

const unchangedFromManifest = manifest
  && manifest.files?.taxonomy?.sha256 === hash(taxonomyPath)
  && manifest.files?.indicators?.sha256 === hash(indicatorsPath);
if (unchangedFromManifest || (!manifest && !hasGitChanges())) {
  throw new Error("远程字典内容没有变化，无需创建新 revision");
}

const explicitRevision = revisionArg ? Number(revisionArg.slice("--revision=".length)) : null;
const publishedRevision = Number(manifest?.revision || taxonomy.revision);
if (explicitRevision !== null && (!Number.isInteger(explicitRevision) || explicitRevision <= publishedRevision)) {
  throw new Error(`--revision 必须是大于当前 revision ${publishedRevision} 的整数`);
}
const nextRevision = explicitRevision
  ?? (taxonomy.revision > publishedRevision ? taxonomy.revision : publishedRevision + 1);
taxonomy.revision = nextRevision;
indicators.revision = nextRevision;
writeFileSync(taxonomyPath, `${JSON.stringify(taxonomy, null, 2)}\n`, "utf8");
writeFileSync(indicatorsPath, `${JSON.stringify(indicators, null, 2)}\n`, "utf8");

run("scripts/dictionary/validate.mjs", ["--layer=remote"]);
run("scripts/dictionary/build-manifest.mjs");
console.log(`Remote dictionary revision ${nextRevision} is ready for commit and Pages deployment.`);
