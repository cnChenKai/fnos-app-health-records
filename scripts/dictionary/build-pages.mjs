#!/usr/bin/env node

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = resolve(new URL("../..", import.meta.url).pathname);
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const outputDir = resolve(rootDir, outputArg?.slice("--output=".length) || ".dictionary-pages");
const schemaOutputDir = resolve(outputDir, "schemas");

const validation = spawnSync(process.execPath, [resolve(rootDir, "scripts/dictionary/validate.mjs")], {
  cwd: rootDir,
  encoding: "utf8"
});
if (validation.status !== 0) {
  process.stderr.write(validation.stdout);
  process.stderr.write(validation.stderr);
  process.exit(validation.status || 1);
}

mkdirSync(schemaOutputDir, { recursive: true });

const sources = [
  resolve(rootDir, "dictionary/remote/taxonomy.json"),
  resolve(rootDir, "dictionary/remote/indicators.json"),
  ...readdirSync(resolve(rootDir, "dictionary/schemas"))
    .filter((name) => name.endsWith(".schema.json"))
    .sort()
    .map((name) => resolve(rootDir, "dictionary/schemas", name))
];

let sourceBytes = 0;
let outputBytes = 0;
for (const sourcePath of sources) {
  const source = readFileSync(sourcePath, "utf8");
  const compact = `${JSON.stringify(JSON.parse(source))}\n`;
  const destination = sourcePath.includes("/schemas/")
    ? resolve(schemaOutputDir, basename(sourcePath))
    : resolve(outputDir, basename(sourcePath));
  writeFileSync(destination, compact, "utf8");
  sourceBytes += Buffer.byteLength(source);
  outputBytes += Buffer.byteLength(compact);
}

const manifest = spawnSync(process.execPath, [
  resolve(rootDir, "scripts/dictionary/build-manifest.mjs"),
  `--source-dir=${outputDir}`,
  `--output=${resolve(outputDir, "manifest.json")}`,
  "--compact"
], {
  cwd: rootDir,
  encoding: "utf8",
  env: process.env
});
if (manifest.status !== 0) {
  process.stderr.write(manifest.stdout);
  process.stderr.write(manifest.stderr);
  process.exit(manifest.status || 1);
}

const savedBytes = sourceBytes - outputBytes;
const savedPercent = sourceBytes ? ((savedBytes / sourceBytes) * 100).toFixed(1) : "0.0";
console.log(
  `Built compact dictionary Pages artifact at ${outputDir}: `
  + `${outputBytes} bytes, saved ${savedBytes} bytes (${savedPercent}%).`
);
