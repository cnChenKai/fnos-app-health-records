import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { H3Event } from "h3";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import recognitionModeRoute from "../routes/api/ocr/recognition-mode.get.ts";
import recognitionSettingsRoute from "../routes/api/ocr/recognition-settings.get.ts";
import {
  getOcrRecognitionModeSummary,
  getOcrRecognitionSettings,
  saveOcrRecognitionSettings,
  validateOcrBatchSelection,
} from "../services/ocr-recognition-settings.service.ts";

async function withDatabase(run: (storageDir: string) => Promise<void> | void) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ocr-recognition-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    await run(storageDir);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.FNOS_SOCKET_PATH;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function statusCode(error: unknown) {
  const value = error as { status?: number; statusCode?: number };
  return value.statusCode ?? value.status;
}

function event(options: { administrator?: boolean } = {}) {
  return {
    context: {},
    node: {
      req: {
        healthAccessMode: "gateway",
        headers: options.administrator
          ? {
              "x-trim-userid": "ocr-admin",
              "x-trim-username": "OCR 管理员",
              "x-trim-isadmin": "true",
            }
          : {},
      },
      res: {},
    },
  } as unknown as H3Event;
}

test("defaults to local OCR and encrypts precise API tokens without returning plaintext", async () => {
  await withDatabase((storageDir) => {
    assert.deepEqual(getOcrRecognitionModeSummary(), {
      mode: "local",
      label: "本地 OCR",
      description: "报告页面仅在当前设备内识别，不会发送给外部服务。",
      externalProcessing: false,
      requiresApiToken: false,
      requiresRemoteProcessingAcceptance: false,
      limits: { maxFileBytes: null, maxFileMegabytes: null, maxPages: null },
    });
    assert.throws(
      () => saveOcrRecognitionSettings({ mode: "mineru_precise" }),
      (error: unknown) => statusCode(error) === 400,
    );

    const token = "mineru-test-token-that-must-stay-secret";
    const saved = saveOcrRecognitionSettings({ mode: "mineru_precise", apiToken: token });
    assert.equal(saved.mode, "mineru_precise");
    assert.equal(saved.apiTokenConfigured, true);
    assert.equal(saved.apiTokenMasked.includes(token), false);
    assert.equal("apiToken" in saved, false);

    const row = getDatabase().prepare(
      "SELECT value_json AS valueJson FROM app_settings WHERE setting_key = 'ocr.recognition'",
    ).get() as { valueJson: string };
    assert.equal(row.valueJson.includes(token), false);
    const stored = JSON.parse(row.valueJson) as { apiTokenEncrypted?: string };
    assert.equal(typeof stored.apiTokenEncrypted, "string");
    assert.notEqual(stored.apiTokenEncrypted, token);

    const keyFile = join(storageDir, "secrets", "ocr-recognition.key");
    assert.equal(existsSync(keyFile), true);
    assert.equal(readFileSync(keyFile).byteLength, 32);
    assert.equal(getOcrRecognitionSettings(true).apiToken, token);

    const agent = saveOcrRecognitionSettings({ mode: "mineru_agent" });
    assert.equal(agent.apiTokenConfigured, true);
    assert.equal(getOcrRecognitionSettings(true).apiToken, token);
    const preciseAgain = saveOcrRecognitionSettings({ mode: "mineru_precise" });
    assert.equal(preciseAgain.apiTokenConfigured, true);

    saveOcrRecognitionSettings({ mode: "local", clearApiToken: true });
    assert.equal(getOcrRecognitionSettings(true).apiToken, "");
    assert.throws(
      () => saveOcrRecognitionSettings({ mode: "mineru_precise" }),
      (error: unknown) => statusCode(error) === 400,
    );
  });
});

test("requires a per-batch remote confirmation and rejects stale observed modes", async () => {
  await withDatabase(() => {
    assert.deepEqual(validateOcrBatchSelection(), {
      ocrMode: "local",
      remoteProcessingAccepted: false,
    });
    saveOcrRecognitionSettings({ mode: "mineru_agent" });
    assert.throws(
      () => validateOcrBatchSelection({ ocrMode: "mineru_agent" }),
      (error: unknown) => statusCode(error) === 400,
    );
    assert.throws(
      () => validateOcrBatchSelection({ ocrMode: "local", remoteProcessingAccepted: true }),
      (error: unknown) => statusCode(error) === 409,
    );
    assert.deepEqual(
      validateOcrBatchSelection({ ocrMode: "mineru_agent", remoteProcessingAccepted: "true" }),
      { ocrMode: "mineru_agent", remoteProcessingAccepted: true },
    );
  });
});

test("rejects malformed tokens and damaged settings fail closed to local OCR", async () => {
  await withDatabase(() => {
    assert.throws(
      () => saveOcrRecognitionSettings({ mode: "local", apiToken: { unsafe: true } }),
      (error: unknown) => statusCode(error) === 400,
    );
    assert.throws(
      () => saveOcrRecognitionSettings({ mode: "local", apiToken: "bad\nheader" }),
      (error: unknown) => statusCode(error) === 400,
    );
    getDatabase().prepare(
      "INSERT INTO app_settings (setting_key, value_json) VALUES ('ocr.recognition', ?)",
    ).run(JSON.stringify({ mode: "mineru_precise", apiTokenEncrypted: "damaged" }));
    assert.equal(getOcrRecognitionModeSummary().mode, "local");
    assert.equal(getOcrRecognitionSettings(false).apiTokenConfigured, false);
  });
});

test("recognition APIs deny anonymous users and the administrator response remains secret-free", async () => {
  await withDatabase(async () => {
    process.env.AUTH_MODE = "fnos";
    process.env.FNOS_SOCKET_PATH = "/tmp/fnos-test.sock";
    assert.throws(
      () => recognitionModeRoute(event()),
      (error: unknown) => statusCode(error) === 401,
    );
    assert.throws(
      () => recognitionSettingsRoute(event()),
      (error: unknown) => statusCode(error) === 403,
    );

    saveOcrRecognitionSettings({ mode: "mineru_precise", apiToken: "route-secret-token" });
    const response = recognitionSettingsRoute(event({ administrator: true })) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    assert.equal(response.ok, true);
    assert.equal(response.data.apiTokenConfigured, true);
    assert.equal("apiToken" in response.data, false);
    assert.equal(JSON.stringify(response).includes("route-secret-token"), false);
  });
});
