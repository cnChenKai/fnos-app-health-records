import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { H3Event } from "h3";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { getRequestUser } from "../utils/request-user.ts";

test("ignores historical local session cookies outside the fnOS gateway", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-session-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin)
      VALUES ('local-direct-admin', 'admin', 1)
    `).run();

    const event = {
      node: {
        req: {
          healthAccessMode: "port",
          headers: { cookie: "health_session=legacy-local-session" }
        }
      }
    } as unknown as H3Event;

    assert.deepEqual(getRequestUser(event), {
      id: "anonymous",
      displayName: "未登录",
      provider: "fnos_gateway",
      authenticated: false,
      isGatewayAdmin: false
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
