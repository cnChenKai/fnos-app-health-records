import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdates, compareVersions } from "../services/update-check.service.ts";

test("compareVersions orders semantic versions", () => {
  assert.equal(compareVersions("0.1.12", "0.1.13"), -1);
  assert.equal(compareVersions("0.1.13", "0.1.13"), 0);
  assert.equal(compareVersions("0.2.0", "0.1.99"), 1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.1.12", "0.1.12.1"), -1);
});

test("checkForUpdates reports a newer GitHub release", async () => {
  const result = await checkForUpdates(true, async () => ({
    tag_name: "v99.0.0",
    name: "健康档案 v99.0.0",
    html_url: "https://github.com/timor-m/fnos-app-health-records/releases/tag/v99.0.0",
    published_at: "2026-07-26T00:00:00Z",
    assets: [
      { name: "app.tgz", browser_download_url: "https://example.com/app.tgz", size: 100 },
      { name: "fnos-app-health-records.fpk", browser_download_url: "https://example.com/app.fpk", size: 12345678 }
    ]
  }));
  assert.equal(result.latestVersion, "99.0.0");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.releaseUrl, "https://github.com/timor-m/fnos-app-health-records/releases/tag/v99.0.0");
  assert.equal(result.downloadUrl, "https://example.com/app.fpk");
  assert.equal(result.downloadSizeBytes, 12345678);
});

test("checkForUpdates leaves download empty when the release has no fpk asset", async () => {
  const result = await checkForUpdates(true, async () => ({
    tag_name: "v99.0.0",
    html_url: "https://github.com/timor-m/fnos-app-health-records/releases/tag/v99.0.0"
  }));
  assert.equal(result.updateAvailable, true);
  assert.equal(result.downloadUrl, "");
  assert.equal(result.downloadSizeBytes, null);
});

test("checkForUpdates reports up-to-date when GitHub is not newer", async () => {
  const current = (await import("../../../package.json", { with: { type: "json" } })).default.version;
  const result = await checkForUpdates(true, async () => ({ tag_name: `v${current}` }));
  assert.equal(result.updateAvailable, false);
  assert.equal(result.releaseUrl, "https://github.com/timor-m/fnos-app-health-records/releases");
});

test("checkForUpdates surfaces fetch failures as readable errors", async () => {
  await assert.rejects(
    () => checkForUpdates(true, async () => { throw new Error("无法连接 GitHub，请检查 NAS 网络后重试"); }),
    /无法连接 GitHub/
  );
  await assert.rejects(
    () => checkForUpdates(true, async () => ({})),
    /还没有已发布的版本/
  );
});
