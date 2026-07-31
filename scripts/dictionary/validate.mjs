#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const rootDir = resolve(new URL("../..", import.meta.url).pathname);
const layerArg = process.argv.find((arg) => arg.startsWith("--layer="));
const selectedLayer = layerArg?.slice("--layer=".length) || "all";
if (!["all", "core", "remote"].includes(selectedLayer)) {
  throw new Error("--layer must be all, core or remote");
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), "utf8"));
}

const schemas = {
  taxonomy: readJson("dictionary/schemas/taxonomy.schema.json"),
  indicators: readJson("dictionary/schemas/indicators.schema.json")
};
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validators = {
  taxonomy: ajv.compile(schemas.taxonomy),
  indicators: ajv.compile(schemas.indicators)
};
const errors = [];
const warnings = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

function formatSchemaErrors(layer, type, validationErrors = []) {
  for (const error of validationErrors) {
    errors.push(`${layer}/${type}${error.instancePath || "/"} ${error.message}`);
  }
}

function duplicateValues(items, keyOf) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

function loadLayer(layer) {
  const taxonomy = readJson(`dictionary/${layer}/taxonomy.json`);
  const indicators = readJson(`dictionary/${layer}/indicators.json`);
  if (!validators.taxonomy(taxonomy)) formatSchemaErrors(layer, "taxonomy.json", validators.taxonomy.errors);
  if (!validators.indicators(indicators)) formatSchemaErrors(layer, "indicators.json", validators.indicators.errors);
  check(taxonomy.layer === layer, `${layer}/taxonomy.json layer must be ${layer}`);
  check(indicators.layer === layer, `${layer}/indicators.json layer must be ${layer}`);
  check(taxonomy.revision === indicators.revision, `${layer} taxonomy and indicators revision must match`);
  return { layer, taxonomy, indicators };
}

const layers = selectedLayer === "all"
  ? [loadLayer("core"), loadLayer("remote")]
  : [loadLayer(selectedLayer)];
const core = layers.find((item) => item.layer === "core")
  || (selectedLayer === "remote" ? loadLayer("core") : null);
const effectiveLayers = core && !layers.includes(core) ? [core, ...layers] : layers;
const groupRows = effectiveLayers.flatMap(({ layer, taxonomy }) =>
  taxonomy.groups.map((group) => ({ ...group, layer }))
);
const subgroupRows = groupRows.flatMap((group) =>
  group.subgroups.map((subgroup) => ({ ...subgroup, layer: group.layer, groupKey: group.key }))
);
const categoryRows = effectiveLayers.flatMap(({ layer, taxonomy }) =>
  taxonomy.categories.map((category) => ({ ...category, layer }))
);
const definitions = effectiveLayers.flatMap(({ layer, indicators }) =>
  indicators.indicators.map((indicator) => ({ ...indicator, layer }))
);
const extensions = effectiveLayers.flatMap(({ layer, indicators }) =>
  indicators.extensions.map((extension) => ({ ...extension, layer }))
);
const redirects = effectiveLayers.flatMap(({ layer, indicators }) =>
  Object.entries(indicators.redirects).map(([source, target]) => ({ source, target, layer }))
);

for (const duplicate of duplicateValues(groupRows, (item) => item.key)) {
  errors.push(`duplicate group key: ${duplicate}`);
}
for (const duplicate of duplicateValues(subgroupRows, (item) => item.key)) {
  errors.push(`duplicate subgroup key: ${duplicate}`);
}
for (const duplicate of duplicateValues(categoryRows, (item) => item.key)) {
  errors.push(`duplicate category key: ${duplicate}`);
}
for (const duplicate of duplicateValues(definitions, (item) => item.canonicalKey)) {
  errors.push(`duplicate indicator canonicalKey: ${duplicate}`);
}
for (const duplicate of duplicateValues(extensions, (item) => item.canonicalKey)) {
  errors.push(`duplicate indicator extension: ${duplicate}`);
}
for (const duplicate of duplicateValues(redirects, (item) => item.source)) {
  errors.push(`duplicate indicator redirect source: ${duplicate}`);
}

const groupsByKey = new Map(groupRows.map((item) => [item.key, item]));
const subgroupsByKey = new Map(subgroupRows.map((item) => [item.key, item]));
const categoriesByKey = new Map(categoryRows.map((item) => [item.key, item]));
const definitionsByKey = new Map(definitions.map((item) => [item.canonicalKey, item]));

for (const group of groupRows) {
  for (const duplicate of duplicateValues(group.subgroups, (item) => item.order)) {
    errors.push(`group ${group.key} has duplicate subgroup order: ${duplicate}`);
  }
}
for (const category of categoryRows) {
  const group = groupsByKey.get(category.groupKey);
  check(Boolean(group), `category ${category.key} references unknown group ${category.groupKey}`);
  if (category.subgroupKey) {
    const subgroup = subgroupsByKey.get(category.subgroupKey);
    check(Boolean(subgroup), `category ${category.key} references unknown subgroup ${category.subgroupKey}`);
    check(
      subgroup?.groupKey === category.groupKey,
      `category ${category.key} subgroup ${category.subgroupKey} does not belong to ${category.groupKey}`
    );
  }
}

for (const indicator of definitions) {
  const category = categoriesByKey.get(indicator.categoryKey);
  check(Boolean(category), `indicator ${indicator.canonicalKey} references unknown category ${indicator.categoryKey}`);
  check(
    indicator.kind !== "quantitative" || indicator.valueType === "numeric",
    `indicator ${indicator.canonicalKey} quantitative kind requires numeric valueType`
  );
  check(
    indicator.kind !== "categorical" || ["positive_negative", "ordinal", "text"].includes(indicator.valueType),
    `indicator ${indicator.canonicalKey} categorical kind has invalid valueType`
  );
  const aliasKeys = indicator.aliases.map((alias) => alias.normalize("NFKC").toLocaleLowerCase("zh-CN").trim());
  for (const duplicate of duplicateValues(aliasKeys, (item) => item)) {
    errors.push(`indicator ${indicator.canonicalKey} has duplicate alias: ${duplicate}`);
  }
}

for (const duplicate of duplicateValues(
  definitions,
  (item) => `${item.categoryKey}\u0000${item.order}`
)) {
  errors.push(`duplicate indicator order within category: ${duplicate.replaceAll("\u0000", "/")}`);
}
for (const extension of extensions) {
  check(extension.layer === "remote", `core indicator ${extension.canonicalKey} cannot use an extension`);
  check(Boolean(definitionsByKey.get(extension.canonicalKey)), `extension targets unknown indicator ${extension.canonicalKey}`);
  for (const duplicate of duplicateValues(extension.aliases, (alias) =>
    alias.normalize("NFKC").toLocaleLowerCase("zh-CN").trim()
  )) {
    errors.push(`extension ${extension.canonicalKey} has duplicate alias: ${duplicate}`);
  }
}
const redirectsBySource = new Map(redirects.map((redirect) => [redirect.source, redirect.target]));
for (const redirect of redirects) {
  check(redirect.layer === "remote", `core dictionary cannot redirect ${redirect.source}`);
  check(!definitionsByKey.has(redirect.source), `redirect source ${redirect.source} is still an active definition`);
  check(Boolean(definitionsByKey.get(redirect.target)), `redirect ${redirect.source} targets unknown ${redirect.target}`);
  const visited = new Set([redirect.source]);
  let target = redirect.target;
  while (target) {
    if (visited.has(target)) {
      errors.push(`indicator merge cycle detected at ${target}`);
      break;
    }
    visited.add(target);
    target = redirectsBySource.get(target) || null;
  }
}

const aliasesByName = new Map();
for (const indicator of definitions) {
  for (const alias of indicator.aliases) {
    const key = alias.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
    if (!aliasesByName.has(key)) aliasesByName.set(key, new Set());
    aliasesByName.get(key).add(indicator.canonicalKey);
  }
}
for (const extension of extensions) {
  for (const alias of extension.aliases) {
    const key = alias.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
    if (!aliasesByName.has(key)) aliasesByName.set(key, new Set());
    aliasesByName.get(key).add(extension.canonicalKey);
  }
}
for (const [alias, keys] of aliasesByName) {
  if (keys.size > 1) warnings.push(`ambiguous global alias "${alias}" is used by ${[...keys].join(", ")}`);
}

if (selectedLayer !== "remote") {
  check((core?.indicators.indicators.length || 0) > 0, "core dictionary must contain indicators");
}

if (errors.length) {
  console.error("Dictionary validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
for (const warning of warnings) console.warn(`Dictionary warning: ${warning}`);
const selectedDefinitions = layers.reduce(
  (count, layer) => count + layer.indicators.indicators.length,
  0
);
console.log(
  `Dictionary validation passed for ${selectedLayer}: ${selectedDefinitions} definitions, `
  + `${extensions.length} extensions, ${redirects.length} redirects, ${categoryRows.length} effective categories.`
);
