#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const migrationsPath = join(rootDir, "packages", "server", "database", "migrations.ts");
const schemaPath = join(rootDir, "packages", "server", "database", "schema.ts");
const migrationsSource = readFileSync(migrationsPath, "utf8");
const schemaSource = readFileSync(schemaPath, "utf8");
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

const migrationMatches = [...migrationsSource.matchAll(/version:\s*(\d+),\s*\n\s*name:\s*"([^"]+)",\s*\n\s*checksum:\s*"([^"]+)"/g)];
const migrations = migrationMatches.map((match) => ({
  version: Number(match[1]),
  name: match[2],
  checksum: match[3]
}));

check(migrations.length > 0, "No database migrations found.");
check(schemaSource.includes("export const schemaVersion = latestSchemaVersion"), "schemaVersion must be derived from latestSchemaVersion.");
check(schemaSource.includes("CREATE TABLE IF NOT EXISTS schema_migrations"), "schemaSql must include schema_migrations.");
check(schemaSource.includes("CREATE TABLE IF NOT EXISTS app_upgrade_history"), "schemaSql must include app_upgrade_history.");

const seenVersions = new Set();
for (let index = 0; index < migrations.length; index += 1) {
  const migration = migrations[index];
  const expectedVersion = index + 1;
  check(migration.version === expectedVersion, `Migration ${migration.name} must use version ${expectedVersion}, got ${migration.version}.`);
  check(!seenVersions.has(migration.version), `Duplicate migration version ${migration.version}.`);
  check(/^manual:\d{3}-[a-z0-9-]+$/.test(migration.checksum), `Migration v${migration.version} has invalid checksum format.`);
  seenVersions.add(migration.version);
}

const latestVersion = migrations.at(-1)?.version ?? 0;
check(
  migrationsSource.includes("export const latestSchemaVersion = databaseMigrations[databaseMigrations.length - 1]?.version ?? 0"),
  "latestSchemaVersion must be derived from the last registered migration."
);
check(latestVersion > 0, "latestSchemaVersion must be greater than zero.");

if (errors.length) {
  console.error("Database migration validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Database migration validation passed. latest schema v${latestVersion}.`);
