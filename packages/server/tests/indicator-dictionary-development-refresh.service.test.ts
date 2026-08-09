import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import coreIndicators from "../../../dictionary/core/indicators.json" with { type: "json" };
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { ensureCoreDictionaryMaterialized } from "../services/indicator-dictionary.service.ts";

const revision = coreIndicators.revision;

function seedConflictingCoreSnapshot() {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO indicator_dictionary_snapshots (
      id, layer, revision, format_version, content_sha256,
      taxonomy_json, indicators_json, source_url
    ) VALUES ('stale-core-snapshot', 'core', ?, 1, 'stale-development-hash', '{}', '{}', 'test://stale')
  `).run(revision);
  db.prepare(`
    INSERT INTO indicator_dictionary_state (
      layer, active_snapshot_id, revision, content_sha256
    ) VALUES ('core', 'stale-core-snapshot', ?, 'stale-development-hash')
  `).run(revision);
  return db;
}

test("rejects changed content under the same core revision until an explicit core reset", () => {
  const storageDir = mkdtempSync(
    join(tmpdir(), "health-records-dictionary-production-guard-"),
  );
  const previousStorageDir = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = seedConflictingCoreSnapshot();
    // 任何环境下都拒绝同 revision 不同内容的静默替换
    assert.throws(
      () => ensureCoreDictionaryMaterialized(),
      new RegExp(`core 字典 revision ${revision} 已存在不同内容`),
    );

    // 显式执行 dictionary:reset-core 等价的清理后，下一次物化从内置字典重建同 revision
    db.prepare("DELETE FROM indicator_dictionary_state WHERE layer = 'core'").run();
    db.prepare("DELETE FROM indicator_dictionary_snapshots WHERE layer = 'core'").run();
    ensureCoreDictionaryMaterialized();

    const state = db.prepare(`
      SELECT active_snapshot_id AS snapshotId, revision, content_sha256 AS contentSha256
      FROM indicator_dictionary_state WHERE layer = 'core'
    `).get() as { snapshotId: string; revision: number; contentSha256: string };
    assert.equal(state.revision, revision);
    assert.notEqual(state.snapshotId, "stale-core-snapshot");
    assert.notEqual(state.contentSha256, "stale-development-hash");
  } finally {
    closeDatabaseForTests();
    if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorageDir;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
