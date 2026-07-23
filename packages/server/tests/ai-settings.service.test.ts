import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  getAiSettings,
  saveAiSettings,
  testAiConnection
} from "../services/ai-settings.service.ts";
import { isAiExtractionConfigured } from "../services/ai-extraction.service.ts";

async function withDatabase(run: () => Promise<void> | void) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ai-settings-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    await run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

test("migrates the legacy flat AI configuration into the selected provider", async () => {
  await withDatabase(() => {
    saveAiSettings({
      enabled: true,
      provider: "deepseek",
      visionEnabled: true,
      baseUrl: "https://legacy.example.com/v1",
      textModel: "legacy-text",
      visionModel: "legacy-vision",
      apiKey: "legacy-secret-key"
    });
    const db = getDatabase();
    const row = db.prepare("SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'ai.provider'")
      .get() as { valueJson: string };
    const modern = JSON.parse(row.valueJson) as {
      providers: { deepseek: { apiKeyEncrypted: string } };
    };
    db.prepare("UPDATE app_settings SET value_json = ? WHERE setting_key = 'ai.provider'").run(JSON.stringify({
      enabled: true,
      provider: "deepseek",
      visionEnabled: true,
      baseUrl: "https://legacy.example.com/v1",
      textModel: "legacy-text",
      visionModel: "legacy-vision",
      apiKeyEncrypted: modern.providers.deepseek.apiKeyEncrypted
    }));

    const settings = getAiSettings(true);
    assert.equal(settings.provider, "deepseek");
    assert.equal(settings.baseUrl, "https://legacy.example.com/v1");
    assert.equal(settings.textModel, "legacy-text");
    assert.equal(settings.visionModel, "legacy-vision");
    assert.equal(settings.visionEnabled, true);
    assert.equal(settings.apiKey, "legacy-secret-key");
    assert.equal(settings.apiKeyMasked.includes("legacy-secret-key"), false);
  });
});

test("retains independent provider configurations when switching models", async () => {
  await withDatabase(() => {
    saveAiSettings({
      enabled: true,
      provider: "deepseek",
      visionEnabled: false,
      baseUrl: "https://deepseek.example.com/v1",
      textModel: "deepseek-health",
      visionModel: "",
      apiKey: "deepseek-secret-key"
    });
    const qwen = saveAiSettings({
      enabled: true,
      provider: "qwen",
      visionEnabled: true,
      baseUrl: "https://qwen.example.com/v1",
      textModel: "qwen-health",
      visionModel: "qwen-vl-health",
      apiKey: "qwen-secret-key"
    });
    assert.equal(qwen.provider, "qwen");
    assert.equal(qwen.providerSettings.deepseek.textModel, "deepseek-health");
    assert.equal(qwen.providerSettings.deepseek.apiKeyConfigured, true);
    assert.equal(qwen.providerSettings.qwen.visionModel, "qwen-vl-health");

    const deepseek = saveAiSettings({
      enabled: true,
      provider: "deepseek",
      visionEnabled: qwen.providerSettings.deepseek.visionEnabled,
      baseUrl: qwen.providerSettings.deepseek.baseUrl,
      textModel: qwen.providerSettings.deepseek.textModel,
      visionModel: qwen.providerSettings.deepseek.visionModel
    });
    assert.equal(deepseek.provider, "deepseek");
    assert.equal(deepseek.textModel, "deepseek-health");
    assert.equal(deepseek.apiKeyConfigured, true);
    assert.equal(deepseek.providerSettings.qwen.textModel, "qwen-health");
    assert.equal(deepseek.providerSettings.qwen.apiKeyMasked.endsWith("-key"), true);
    assert.equal(isAiExtractionConfigured(), true);

    const stored = JSON.parse((getDatabase().prepare(
      "SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'ai.provider'"
    ).get() as { valueJson: string }).valueJson) as Record<string, unknown>;
    assert.equal("apiKey" in stored, false);
    assert.equal(JSON.stringify(stored).includes("deepseek-secret-key"), false);
    assert.equal(JSON.stringify(stored).includes("qwen-secret-key"), false);
  });
});

test("tests the selected provider with unsaved form values", async () => {
  await withDatabase(async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedModel = "";
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedModel = String(JSON.parse(String(init?.body)).model);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer unsaved-qwen-key");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };
    try {
      const result = await testAiConnection({
        provider: "qwen",
        baseUrl: "https://unsaved.example.com/v1/",
        textModel: "unsaved-qwen-model",
        apiKey: "unsaved-qwen-key"
      });
      assert.equal(result.provider, "qwen");
      assert.equal(requestedUrl, "https://unsaved.example.com/v1/chat/completions");
      assert.equal(requestedModel, "unsaved-qwen-model");
      assert.equal(getAiSettings(false).providerSettings.qwen.apiKeyConfigured, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
