import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("writes install runtime configuration with only the service port", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-config-"));
  const script = resolve(process.cwd(), "scripts", "write-runtime-config.mjs");
  try {
    execFileSync(process.execPath, [script, storageDir, "install"], {
      env: {
        ...process.env,
        wizard_service_port: "43444"
      }
    });
    const runtime = JSON.parse(readFileSync(join(storageDir, "config", "runtime.json"), "utf8"));
    assert.deepEqual(runtime, { servicePort: 43444 });
    assert.equal(existsSync(join(storageDir, "config", "bootstrap-admin.json")), false);
    assert.equal(existsSync(join(storageDir, "secrets", "direct.crt")), false);
    assert.equal(existsSync(join(storageDir, "secrets", "direct.key")), false);
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("rejects an invalid service port", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-invalid-port-"));
  const script = resolve(process.cwd(), "scripts", "write-runtime-config.mjs");
  try {
    assert.throws(() => execFileSync(process.execPath, [script, storageDir, "config"], {
      env: { ...process.env, wizard_service_port: "80" },
      stdio: "pipe"
    }));
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});
