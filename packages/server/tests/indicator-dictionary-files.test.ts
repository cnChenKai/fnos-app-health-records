import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  builtinIndicators,
  builtinIndicatorVersion
} from "../domain/indicator-dictionary/builtin-indicators.ts";
import { trendPlacementFor } from "../domain/indicator-dictionary/trend-taxonomy.ts";

const rootDir = resolve(new URL("../../..", import.meta.url).pathname);

test("loads the builtin runtime catalog from the validated core JSON snapshot", () => {
  const document = JSON.parse(
    readFileSync(resolve(rootDir, "dictionary/core/indicators.json"), "utf8")
  ) as {
    revision: number;
    indicators: Array<{
      canonicalKey: string;
    }>;
  };

  assert.equal(builtinIndicatorVersion, `core-r${document.revision}`);
  assert.equal(builtinIndicators.length, document.indicators.length);
  assert.deepEqual(
    builtinIndicators.map((indicator) => indicator.canonicalKey),
    document.indicators.map((indicator) => indicator.canonicalKey)
  );
  const keys = new Set(builtinIndicators.map((indicator) => indicator.canonicalKey));
  for (const key of [
    "vital_systolic_bp",
    "cbc_hct",
    "urine_specific_gravity",
    "urine_protein_quantitative",
    "liver_albumin",
    "renal_egfr",
    "glucose_postprandial_2h",
    "electrolyte_chloride",
    "vascular_abi_right",
    "vascular_abi_left",
    "vascular_bapwv_right",
    "vascular_bapwv_left"
  ]) {
    assert.equal(keys.has(key), true, `missing common builtin indicator ${key}`);
  }
});

test("publishes confirmed specialty aliases through the remote dictionary", () => {
  const indicators = JSON.parse(
    readFileSync(resolve(rootDir, "dictionary/remote/indicators.json"), "utf8")
  ) as {
    revision: number;
    indicators: Array<{ canonicalKey: string; aliases: string[] }>;
  };
  const taxonomy = JSON.parse(
    readFileSync(resolve(rootDir, "dictionary/remote/taxonomy.json"), "utf8")
  ) as { revision: number };
  const manifest = JSON.parse(
    readFileSync(resolve(rootDir, "dictionary/remote/manifest.json"), "utf8")
  ) as { revision: number };
  const keys = new Set(indicators.indicators.map((indicator) => indicator.canonicalKey));
  for (const key of [
    "tumor_afp",
    "tumor_cea",
    "tumor_ca19_9",
    "tumor_ca15_3",
    "tumor_ca242",
    "tumor_ca50",
    "tumor_nse",
    "tumor_ca72_4",
    "tumor_cyfra21_1",
    "thyroid_tpo_antibody",
    "thyroid_thyroglobulin_antibody",
    "thyroid_tsh_receptor_antibody"
  ]) {
    assert.equal(keys.has(key), true, `missing remote indicator ${key}`);
  }
  const tpo = indicators.indicators.find((item) => item.canonicalKey === "thyroid_tpo_antibody");
  assert.ok(tpo?.aliases.includes("抗甲状腺过氧化物酶抗体"));
  assert.ok(tpo?.aliases.includes("Anti-thyroid peroxidase antibody"));
  assert.ok(tpo?.aliases.includes("TPOAb"));
  assert.equal(indicators.revision, taxonomy.revision);
  assert.equal(indicators.revision, manifest.revision);
});

test("derives trend placement from the core taxonomy JSON", () => {
  assert.deepEqual(trendPlacementFor({ category: "血常规" }), {
    groupKey: "laboratory",
    groupName: "检验检查",
    groupOrder: 80,
    subgroupKey: "blood",
    subgroupName: "血常规",
    subgroupOrder: 10
  });
  assert.equal(trendPlacementFor({ sectionName: "甲功五项" }).subgroupKey, "thyroid");
  assert.equal(trendPlacementFor({ sectionName: "胸部CT检查" }).groupKey, "imaging");
  assert.equal(trendPlacementFor({ sectionName: "生化检验" }).subgroupKey, "laboratory_other");
});

test("passes schema and cross-file dictionary validation", () => {
  const output = execFileSync(process.execPath, ["scripts/dictionary/validate.mjs"], {
    cwd: rootDir,
    encoding: "utf8"
  });
  assert.match(output, /Dictionary validation passed/);
});

test("builds compact Pages JSON and hashes the published bytes", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "health-records-dictionary-pages-"));
  try {
    execFileSync(process.execPath, [
      "scripts/dictionary/build-pages.mjs",
      `--output=${outputDir}`
    ], {
      cwd: rootDir,
      encoding: "utf8"
    });
    const manifestContent = readFileSync(resolve(outputDir, "manifest.json"), "utf8");
    assert.equal(manifestContent.trim(), JSON.stringify(JSON.parse(manifestContent)));

    const manifest = JSON.parse(manifestContent) as {
      files: Record<string, { path: string; sha256: string; bytes: number }>;
    };
    for (const file of Object.values(manifest.files)) {
      const content = readFileSync(resolve(outputDir, file.path));
      assert.equal(content.byteLength, file.bytes);
      assert.equal(createHash("sha256").update(content).digest("hex"), file.sha256);
      assert.equal(content.toString("utf8").trim(), JSON.stringify(JSON.parse(content.toString("utf8"))));
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
