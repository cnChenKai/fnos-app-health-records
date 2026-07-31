import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  checkRemoteIndicatorDictionary,
  getIndicatorDictionaryStatus,
  rollbackRemoteIndicatorDictionary,
  updateRemoteIndicatorDictionary
} from "../services/indicator-dictionary.service.ts";
import {
  backfillBuiltinIndicatorNormalizations,
  listIndicatorNormalizationIssues,
  normalizeReportObservations
} from "../services/indicator-normalization.service.ts";

const admin: RequestUser = {
  id: "dictionary-admin",
  displayName: "管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};
const regularUser: RequestUser = {
  ...admin,
  id: "dictionary-user",
  displayName: "普通用户",
  isGatewayAdmin: false
};

function jsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function remoteBundle(revision: number, includePendingAlias: boolean) {
  const taxonomy = {
    $schema: "../schemas/taxonomy.schema.json",
    formatVersion: 1,
    layer: "remote",
    revision,
    groups: [{
      key: "special_lab",
      name: "专项检验",
      order: 70,
      description: "远程字典测试分组",
      sectionHints: ["专项检验"],
      subgroups: []
    }],
    categories: [{
      key: "special_marker",
      name: "专项指标",
      groupKey: "special_lab",
      subgroupKey: null,
      order: 10,
      aliases: ["专项"],
      sectionHints: ["专项检验"]
    }]
  };
  const indicators = {
    $schema: "../schemas/indicators.schema.json",
    formatVersion: 1,
    layer: "remote",
    revision,
    indicators: [{
      canonicalKey: "remote_marker",
      displayName: "远程专项指标",
      categoryKey: "special_marker",
      order: 10,
      kind: "quantitative",
      valueType: "numeric",
      specimen: "serum",
      defaultUnit: "U/L",
      unitDimension: "enzyme_activity",
      aliases: includePendingAlias ? ["远程项目", "待收录项目"] : ["远程项目"],
      allowedUnits: ["U/L"],
      sectionHints: ["专项检验"],
      explanation: "用于验证远程指标字典的安装、匹配和回滚。"
    }],
    extensions: [],
    redirects: {}
  };
  const taxonomyBytes = jsonBytes(taxonomy);
  const indicatorsBytes = jsonBytes(indicators);
  return {
    taxonomyBytes,
    indicatorsBytes,
    manifest: {
      formatVersion: 1,
      revision,
      generatedAt: `2026-07-${String(20 + revision).padStart(2, "0")}T00:00:00.000Z`,
      files: {
        taxonomy: {
          path: "taxonomy.json",
          sha256: hash(taxonomyBytes),
          bytes: taxonomyBytes.byteLength
        },
        indicators: {
          path: "indicators.json",
          sha256: hash(indicatorsBytes),
          bytes: indicatorsBytes.byteLength
        }
      },
      signature: null
    }
  };
}

test("installs, upgrades and rolls back remote dictionaries while preserving unmatched-name history", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-remote-dictionary-"));
  const originalFetch = globalThis.fetch;
  process.env.STORAGE_DIR = storageDir;
  process.env.INDICATOR_DICTIONARY_URL = "https://dictionary.test/";
  let bundle = remoteBundle(1, false);
  let corruptIndicatorsHash = false;
  const failedHosts = new Set<string>();
  const requestedHosts: string[] = [];
  globalThis.fetch = (async (input) => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    requestedHosts.push(url.host);
    if (failedHosts.has(url.host)) return new Response("unavailable", { status: 503 });
    const pathname = url.pathname;
    if (pathname.endsWith("/manifest.json")) {
      const manifest = structuredClone(bundle.manifest);
      if (corruptIndicatorsHash) manifest.files.indicators.sha256 = "0".repeat(64);
      return new Response(jsonBytes(manifest), { status: 200 });
    }
    if (pathname.endsWith("/taxonomy.json")) {
      return new Response(bundle.taxonomyBytes, { status: 200 });
    }
    if (pathname.endsWith("/indicators.json")) {
      return new Response(bundle.indicatorsBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin)
      VALUES (?, ?, 1), (?, ?, 0)
    `).run(admin.id, admin.displayName, regularUser.id, regularUser.displayName);
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('dictionary-member', '本人', 'self', ?)
    `).run(admin.id);
    db.prepare(`
      INSERT INTO reports (
        id, member_id, title, report_type, status, report_issued_at, created_by
      ) VALUES (
        'dictionary-report', 'dictionary-member', '专项检验', 'laboratory',
        'ready', '2026-07-28', ?
      )
    `).run(admin.id);
    db.prepare(`
      INSERT INTO observations (
        id, report_id, section_name, item_name, normalized_name,
        result_text, numeric_value, unit
      ) VALUES (
        'dictionary-observation', 'dictionary-report', '专项检验',
        '待收录项目', '待收录项目', '12 U/L', 12, 'U/L'
      )
    `).run();

    assert.throws(
      () => getIndicatorDictionaryStatus(regularUser),
      (error: unknown) => Boolean(error && typeof error === "object" && "statusCode" in error
        && (error as { statusCode: number }).statusCode === 403)
    );

    const firstCheck = await checkRemoteIndicatorDictionary(admin);
    assert.equal(firstCheck.updateAvailable, true);
    assert.deepEqual(firstCheck.changes.indicators, { added: 1, updated: 0, removed: 0 });
    assert.equal(firstCheck.changes.aliases.added, 1);
    assert.equal(firstCheck.changes.taxonomy.groupsAdded, 1);
    assert.equal(firstCheck.changes.taxonomy.categoriesAdded, 1);
    const first = await updateRemoteIndicatorDictionary(admin);
    assert.equal(first.revision, 1);
    const remoteIndicatorCount = db.prepare(`
      SELECT COUNT(*) AS count FROM indicator_catalog
      WHERE canonical_key = 'remote_marker' AND dictionary_layer = 'remote'
    `).get() as { count: number };
    assert.equal(remoteIndicatorCount.count, 1);
    const remoteGroupCount = db.prepare(`
      SELECT COUNT(*) AS count FROM indicator_taxonomy_groups
      WHERE group_key = 'special_lab' AND dictionary_layer = 'remote'
    `).get() as { count: number };
    assert.equal(remoteGroupCount.count, 1);

    normalizeReportObservations("dictionary-report");
    const firstIssues = listIndicatorNormalizationIssues(admin);
    assert.equal(firstIssues.find((item) => item.rawName === "待收录项目")?.count, 1);
    const repeatedIssues = listIndicatorNormalizationIssues(admin);
    assert.equal(repeatedIssues.find((item) => item.rawName === "待收录项目")?.count, 1);

    bundle = remoteBundle(2, true);
    const secondCheck = await checkRemoteIndicatorDictionary(admin);
    assert.equal(secondCheck.changes.indicators.updated, 1);
    assert.equal(secondCheck.changes.aliases.added, 1);
    assert.deepEqual(secondCheck.changes.samples.updated, ["远程专项指标"]);
    const second = await updateRemoteIndicatorDictionary(admin);
    assert.equal(second.revision, 2);
    const backfill = backfillBuiltinIndicatorNormalizations();
    assert.equal(backfill.updated, 1);
    assert.equal(listIndicatorNormalizationIssues(admin).some((item) => item.rawName === "待收录项目"), false);
    const normalization = db.prepare(`
      SELECT canonical_key AS canonicalKey
      FROM observation_normalizations WHERE observation_id = 'dictionary-observation'
    `).get() as { canonicalKey: string };
    assert.equal(normalization.canonicalKey, "remote_marker");

    const revisionOneSnapshot = getIndicatorDictionaryStatus(admin).snapshots.find(
      (item: any) => item.layer === "remote" && item.revision === 1
    ) as { id: string } | undefined;
    assert.ok(revisionOneSnapshot);
    const rollback = rollbackRemoteIndicatorDictionary(admin, revisionOneSnapshot.id);
    assert.equal(rollback.revision, 1);
    assert.equal(getIndicatorDictionaryStatus(admin).states.find(
      (item: any) => item.layer === "remote"
    )?.revision, 1);
    const rollbackBackfill = backfillBuiltinIndicatorNormalizations();
    assert.equal(rollbackBackfill.unmatched, 1);
    const rolledBackNormalization = db.prepare(`
      SELECT canonical_key AS canonicalKey
      FROM observation_normalizations WHERE observation_id = 'dictionary-observation'
    `).get() as { canonicalKey: string | null };
    assert.equal(rolledBackNormalization.canonicalKey, null);
    assert.equal(
      listIndicatorNormalizationIssues(admin).find((item) => item.rawName === "待收录项目")?.count,
      1
    );

    bundle = remoteBundle(2, false);
    bundle.indicatorsBytes = jsonBytes({
      ...JSON.parse(new TextDecoder().decode(bundle.indicatorsBytes)),
      indicators: [{
        ...JSON.parse(new TextDecoder().decode(bundle.indicatorsBytes)).indicators[0],
        displayName: "被错误复用 revision 的名称"
      }]
    });
    bundle.manifest.files.indicators = {
      ...bundle.manifest.files.indicators,
      sha256: hash(bundle.indicatorsBytes),
      bytes: bundle.indicatorsBytes.byteLength
    };
    await assert.rejects(
      updateRemoteIndicatorDictionary(admin),
      /revision 2 已存在不同内容/
    );
    assert.equal(getIndicatorDictionaryStatus(admin).states.find(
      (item: any) => item.layer === "remote"
    )?.revision, 1);

    bundle = remoteBundle(3, true);
    corruptIndicatorsHash = true;
    await assert.rejects(updateRemoteIndicatorDictionary(admin), /SHA-256 校验失败/);
    const finalStatus = getIndicatorDictionaryStatus(admin);
    assert.equal(finalStatus.states.find((item: any) => item.layer === "remote")?.revision, 1);
    assert.equal(finalStatus.history.some(
      (item: any) => item.status === "failed" && /SHA-256/.test(item.errorMessage || "")
    ), true);

    delete process.env.INDICATOR_DICTIONARY_URL;
    bundle = remoteBundle(4, true);
    corruptIndicatorsHash = false;
    failedHosts.add("gitee.com");
    requestedHosts.length = 0;
    const fallbackCheck = await checkRemoteIndicatorDictionary(admin);
    assert.equal(fallbackCheck.sourceUrl, "https://timor-m.github.io/fnos-app-health-records/");
    assert.deepEqual(requestedHosts.slice(0, 2), ["gitee.com", "timor-m.github.io"]);
    assert.deepEqual(getIndicatorDictionaryStatus(admin).remoteBaseUrls, [
      "https://gitee.com/Timor-M/health-records-dictionary/raw/main/",
      "https://timor-m.github.io/fnos-app-health-records/"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.INDICATOR_DICTIONARY_URL;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
