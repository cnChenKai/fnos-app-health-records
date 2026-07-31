#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(new URL("../..", import.meta.url).pathname);
const fromArg = process.argv.find((arg) => arg.startsWith("--from="));
const toArg = process.argv.find((arg) => arg.startsWith("--to="));
if (!fromArg || !toArg) {
  console.error("Usage: npm run dictionary:compare -- --from=<directory> --to=<directory>");
  process.exit(1);
}

function loadSnapshot(argument) {
  const directory = resolve(rootDir, argument.split("=", 2)[1]);
  return {
    taxonomy: JSON.parse(readFileSync(resolve(directory, "taxonomy.json"), "utf8")),
    indicators: JSON.parse(readFileSync(resolve(directory, "indicators.json"), "utf8"))
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function compareRows(previousRows, nextRows, keyOf) {
  const previous = new Map(previousRows.map((item) => [keyOf(item), item]));
  const next = new Map(nextRows.map((item) => [keyOf(item), item]));
  return {
    added: [...next.keys()].filter((key) => !previous.has(key)).sort(),
    changed: [...next.keys()].filter((key) =>
      previous.has(key) && JSON.stringify(stable(previous.get(key))) !== JSON.stringify(stable(next.get(key)))
    ).sort(),
    removed: [...previous.keys()].filter((key) => !next.has(key)).sort()
  };
}

function taxonomyRows(snapshot) {
  return [
    ...snapshot.taxonomy.groups.map((item) => ({ ...item, rowKey: `group:${item.key}` })),
    ...snapshot.taxonomy.groups.flatMap((group) =>
      group.subgroups.map((item) => ({ ...item, rowKey: `subgroup:${item.key}`, groupKey: group.key }))
    ),
    ...snapshot.taxonomy.categories.map((item) => ({ ...item, rowKey: `category:${item.key}` }))
  ];
}

function indicatorRows(snapshot) {
  return [
    ...snapshot.indicators.indicators.map((item) => ({
      ...item,
      rowKey: `indicator:${item.canonicalKey}`
    })),
    ...snapshot.indicators.extensions.map((item) => ({
      ...item,
      rowKey: `extension:${item.canonicalKey}`
    })),
    ...Object.entries(snapshot.indicators.redirects).map(([source, target]) => ({
      source,
      target,
      rowKey: `redirect:${source}`
    }))
  ];
}

const previous = loadSnapshot(fromArg);
const next = loadSnapshot(toArg);
const result = {
  from: {
    revision: previous.taxonomy.revision
  },
  to: {
    revision: next.taxonomy.revision
  },
  taxonomy: compareRows(taxonomyRows(previous), taxonomyRows(next), (item) => item.rowKey),
  indicators: compareRows(indicatorRows(previous), indicatorRows(next), (item) => item.rowKey)
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
