import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { requestLogLevel } from "../middleware/request-log";
import { createDiagnosticBundle } from "../services/diagnostic-export.service";
import { clearSystemLogs, listSystemLogs, recordClientSystemError } from "../services/system-logs.service";
import { writeLog } from "../utils/logger";

const adminUser: RequestUser = {
  id: "system-log-admin",
  displayName: "日志管理员",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: true
};

const regularUser: RequestUser = {
  id: "system-log-user",
  displayName: "普通用户",
  provider: "development",
  authenticated: true,
  isGatewayAdmin: false
};

async function withLogEnvironment(run: (logDir: string) => Promise<void>) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-system-logs-"));
  const logDir = join(storageDir, "logs");
  process.env.STORAGE_DIR = storageDir;
  process.env.LOG_DIR = logDir;
  process.env.APP_LOG_MAX_BYTES = String(256 * 1024);
  process.env.APP_LOG_MAX_FILES = "2";
  try {
    await run(logDir);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.LOG_DIR;
    delete process.env.APP_LOG_MAX_BYTES;
    delete process.env.APP_LOG_MAX_FILES;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

test("records only abnormal HTTP response status codes", () => {
  assert.equal(requestLogLevel(200), null);
  assert.equal(requestLogLevel(204), null);
  assert.equal(requestLogLevel(302), null);
  assert.equal(requestLogLevel(400), "warn");
  assert.equal(requestLogLevel(404), "warn");
  assert.equal(requestLogLevel(500), "error");
  assert.equal(requestLogLevel(503), "error");
});

test("rotates application logs and enforces the archive retention limit", async () => {
  await withLogEnvironment(async (logDir) => {
    const payload = "x".repeat(110 * 1024);
    for (let index = 0; index < 7; index += 1) {
      await writeLog("info", "rotation-test", { index, payload });
    }

    const files = readdirSync(logDir).filter((name) => name === "app.log" || /^app\.log\.\d+$/.test(name));
    assert.ok(files.includes("app.log"));
    assert.ok(files.length <= 3);
    assert.ok(files.every((name) => statSync(join(logDir, name)).size <= 256 * 1024));
    assert.equal(files.some((name) => name === "app.log.3"), false);
  });
});

test("redacts private fields and identity data before writing application logs", async () => {
  await withLogEnvironment(async (logDir) => {
    await writeLog("error", "privacy-test", {
      apiKey: "sk-sensitive-api-key",
      authorization: "Bearer private-token-value",
      prompt: "患者报告完整内容",
      patientName: "张三",
      address: "测试市健康路 1 号",
      filename: "张三-体检报告.pdf",
      promptTokens: 128,
      nested: {
        detail: "用户 13800138000，证件号 110101199001011234，文件 /Users/private/report.pdf",
        email: "person@example.com"
      }
    });

    const raw = readFileSync(join(logDir, "app.log"), "utf8");
    assert.equal(raw.includes("sk-sensitive-api-key"), false);
    assert.equal(raw.includes("private-token-value"), false);
    assert.equal(raw.includes("患者报告完整内容"), false);
    assert.equal(raw.includes("张三"), false);
    assert.equal(raw.includes("健康路"), false);
    assert.equal(raw.includes("13800138000"), false);
    assert.equal(raw.includes("110101199001011234"), false);
    assert.equal(raw.includes("/Users/private"), false);
    assert.equal(raw.includes("person@example.com"), false);
    assert.match(raw, /\[已隐藏]/);
    assert.match(raw, /\[内容已省略]/);
    assert.match(raw, /"promptTokens":128/);
  });
});

test("filters, paginates and sanitizes system logs for administrators", async () => {
  await withLogEnvironment(async () => {
    await writeLog("info", "request", { method: "GET", path: "/api/health", statusCode: 200, durationMs: 8 });
    await recordClientSystemError(adminUser, {
      source: "vue",
      detail: "页面异常 /Users/private/page.ts 13800138000"
    });
    for (let index = 0; index < 7; index += 1) {
      await writeLog("warn", "processing-job-failed", {
        error: `任务 ${index} 失败，文件 /Users/private/report-${index}.pdf，手机号 13800138000`
      });
    }

    const first = await listSystemLogs(adminUser, { limit: 3 });
    assert.equal(first.items.length, 3);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    assert.ok(first.items.every((item) => item.level === "warn"));
    assert.ok(first.items.every((item) => !item.detail.includes("/Users/private")));
    assert.ok(first.items.every((item) => !item.detail.includes("13800138000")));

    const second = await listSystemLogs(adminUser, { limit: 3, cursor: first.nextCursor || undefined });
    assert.equal(second.items.length, 3);
    assert.equal(second.items.some((item) => first.items.some((firstItem) => firstItem.id === item.id)), false);

    const all = await listSystemLogs(adminUser, { limit: 20, filter: "all" });
    assert.ok(all.items.some((item) => item.level === "info"));
    assert.ok(all.items.some((item) => item.category === "前端"));
    assert.equal(all.stats.maxArchiveFiles, 2);

    await assert.rejects(() => listSystemLogs(regularUser), /仅管理员可查看系统日志/);
    await assert.rejects(
      () => recordClientSystemError({ ...regularUser, authenticated: false }, { detail: "test" }),
      /请先登录/
    );
  });
});

test("exports a sanitized administrator diagnostic bundle without health data", async () => {
  await withLogEnvironment(async (logDir) => {
    const extractionRoot = mkdtempSync(join(tmpdir(), "health-records-diagnostics-test-"));
    const previousPackageVar = process.env.TRIM_PKGVAR;
    const previousAuthMode = process.env.AUTH_MODE;
    process.env.TRIM_PKGVAR = dirname(logDir);
    process.env.AUTH_MODE = "local";
    let bundle: ReturnType<typeof createDiagnosticBundle> | null = null;
    try {
      const db = getDatabase();
      db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
        .run(adminUser.id, adminUser.displayName);
      await writeLog("error", "diagnostic-test", {
        detail: "手机号 13800138000，Bearer private-runtime-token，路径 /Users/private/app.ts"
      });
      writeFileSync(
        join(logDir, "ocr-install.log"),
        "2026-07-27T00:00:00.000Z [stderr] key-privatevalue failed at /Users/private/worker.py\n",
        "utf8"
      );
      writeFileSync(
        join(dirname(logDir), "info.log"),
        "2026-07-27 08:00:00 [error] [process] user person@example.com failed\n",
        "utf8"
      );

      bundle = createDiagnosticBundle(adminUser);
      assert.match(bundle.filename, /^fnos-app-health-records-diagnostics-\d{8}-\d{6}Z\.tar\.gz$/);
      assert.ok(bundle.sizeBytes > 0);
      assert.equal(bundle.includedLogFiles, 3);
      execFileSync("tar", ["-xzf", bundle.path, "-C", extractionRoot], { stdio: "pipe" });

      const files = readdirSync(join(extractionRoot, "logs")).sort();
      assert.ok(files.some((name) => name.startsWith("application-")));
      assert.ok(files.some((name) => name.startsWith("ocr-install-")));
      assert.ok(files.some((name) => name.startsWith("lifecycle-")));
      const exportedText = files
        .map((name) => readFileSync(join(extractionRoot, "logs", name), "utf8"))
        .join("\n");
      assert.equal(exportedText.includes("13800138000"), false);
      assert.equal(exportedText.includes("private-runtime-token"), false);
      assert.equal(exportedText.includes("/Users/private"), false);
      assert.equal(exportedText.includes("person@example.com"), false);
      assert.match(exportedText, /\[已隐藏]|\[路径]|\[邮箱已隐藏]/);

      const manifest = JSON.parse(readFileSync(join(extractionRoot, "manifest.json"), "utf8")) as {
        privacy: { sanitized: boolean; excluded: string[] };
      };
      assert.equal(manifest.privacy.sanitized, true);
      assert.ok(manifest.privacy.excluded.includes("数据库"));
      assert.equal(existsSync(join(extractionRoot, "db")), false);
      const readme = readFileSync(join(extractionRoot, "README.txt"), "utf8");
      assert.match(readme, /Docker 容器启动问题/);
      assert.doesNotMatch(readme, /飞牛|fnOS/);

      const audit = db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'system.diagnostics_export'")
        .get() as { count: number };
      assert.equal(audit.count, 1);
      assert.throws(() => createDiagnosticBundle(regularUser), /仅管理员可导出诊断包/);
    } finally {
      bundle?.cleanup();
      rmSync(extractionRoot, { recursive: true, force: true });
      if (previousPackageVar === undefined) delete process.env.TRIM_PKGVAR;
      else process.env.TRIM_PKGVAR = previousPackageVar;
      if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousAuthMode;
    }
  });
});

test("clears runtime log files and records an administrator audit event", async () => {
  await withLogEnvironment(async (logDir) => {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)")
      .run(adminUser.id, adminUser.displayName);
    await writeLog("warn", "processing-job-failed", { error: "测试失败" });
    assert.equal(existsSync(join(logDir, "app.log")), true);

    const result = await clearSystemLogs(adminUser);
    assert.equal(result.deletedFiles, 1);
    assert.ok(result.freedBytes > 0);
    assert.equal(existsSync(join(logDir, "app.log")), false);

    const audit = db.prepare(`
      SELECT action, detail_json AS detailJson
      FROM audit_logs
      WHERE actor_user_id = ? AND action = 'system.logs_clear'
    `).get(adminUser.id) as { action: string; detailJson: string } | undefined;
    assert.equal(audit?.action, "system.logs_clear");
    assert.equal(JSON.parse(audit?.detailJson || "{}").deletedFiles, 1);
  });
});
