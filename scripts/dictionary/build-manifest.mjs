#!/usr/bin/env node

import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const rootDir = resolve(new URL("../..", import.meta.url).pathname);
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const sourceDirArg = process.argv.find((arg) => arg.startsWith("--source-dir="));
const compact = process.argv.includes("--compact");
const outputPath = resolve(rootDir, outputArg?.slice("--output=".length) || "dictionary/remote/manifest.json");
const remoteDir = resolve(rootDir, sourceDirArg?.slice("--source-dir=".length) || "dictionary/remote");
const taxonomyPath = resolve(remoteDir, "taxonomy.json");
const indicatorsPath = resolve(remoteDir, "indicators.json");
const validation = spawnSync(process.execPath, [resolve(rootDir, "scripts/dictionary/validate.mjs"), "--layer=remote"], {
  cwd: rootDir,
  encoding: "utf8"
});
if (validation.status !== 0) {
  process.stderr.write(validation.stdout);
  process.stderr.write(validation.stderr);
  process.exit(validation.status || 1);
}

const taxonomy = JSON.parse(readFileSync(taxonomyPath, "utf8"));
const indicators = JSON.parse(readFileSync(indicatorsPath, "utf8"));

function fileMetadata(path, relativePath) {
  const content = readFileSync(path);
  return {
    path: relativePath,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength
  };
}

const unsignedManifest = {
  formatVersion: 1,
  revision: taxonomy.revision,
  generatedAt: new Date().toISOString(),
  files: {
    taxonomy: fileMetadata(taxonomyPath, "taxonomy.json"),
    indicators: fileMetadata(indicatorsPath, "indicators.json")
  }
};
const privateKeyValue = process.env.DICTIONARY_SIGNING_PRIVATE_KEY?.replaceAll("\\n", "\n").trim();
const signature = privateKeyValue
  ? {
      algorithm: "ed25519",
      keyId: process.env.DICTIONARY_SIGNING_KEY_ID?.trim() || "default",
      value: sign(
        null,
        Buffer.from(JSON.stringify(unsignedManifest)),
        createPrivateKey(privateKeyValue)
      ).toString("base64")
    }
  : null;
const manifest = { ...unsignedManifest, signature };
const manifestSchema = JSON.parse(readFileSync(resolve(rootDir, "dictionary/schemas/manifest.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateManifest = ajv.compile(manifestSchema);
if (!validateManifest(manifest)) {
  const detail = validateManifest.errors?.map((error) =>
    `${error.instancePath || "/"} ${error.message}`
  ).join("; ");
  throw new Error(`Generated manifest failed schema validation: ${detail}`);
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, compact ? 0 : 2)}\n`, "utf8");
console.log(
  `Generated dictionary manifest revision ${manifest.revision} at ${outputPath}`
  + (signature ? ` with key ${signature.keyId}` : " without signature")
);
