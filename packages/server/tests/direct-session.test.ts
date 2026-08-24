import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { H3Event } from "h3";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import { getRequestUser } from "../utils/request-user.ts";
import {
  bootstrapLocalAdministrator,
  changeLocalPassword,
  localAuthSetupRequired,
  login,
  logout
} from "../services/auth.service.ts";

function localAuthEvent(options: { cookie?: string; forwardedProto?: string; clientAddress?: string } = {}) {
  const nodeHeaders: Record<string, string> = {};
  if (options.cookie) nodeHeaders.cookie = options.cookie;
  if (options.forwardedProto) nodeHeaders["x-forwarded-proto"] = options.forwardedProto;
  const headers = new Headers(nodeHeaders);
  return {
    req: {
      headers,
      url: "http://health.test/api/auth/login",
      context: { clientAddress: options.clientAddress || "127.0.0.1" }
    },
    res: { headers: new Headers() },
    node: { req: { headers: nodeHeaders, socket: {} } }
  } as unknown as H3Event;
}

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
      isAdmin: false,
      isGatewayAdmin: false
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("keeps fnOS gateway identity and administrator permissions in fnOS mode", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-fnos-auth-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "fnos";
  try {
    const event = {
      node: {
        req: {
          healthAccessMode: "gateway",
          headers: {
            "x-trim-userid": "fnos-user-1000",
            "x-trim-username": "飞牛管理员",
            "x-trim-isadmin": "true"
          }
        }
      }
    } as unknown as H3Event;
    assert.deepEqual(getRequestUser(event), {
      id: "fnos-user-1000",
      displayName: "飞牛管理员",
      provider: "fnos_gateway",
      authenticated: true,
      isAdmin: true,
      isGatewayAdmin: true
    });
    const stored = getDatabase().prepare(`
      SELECT display_name AS displayName, is_gateway_admin AS isAdmin FROM users WHERE id = ?
    `).get("fnos-user-1000") as { displayName: string; isAdmin: number };
    assert.deepEqual({ ...stored }, { displayName: "飞牛管理员", isAdmin: 1 });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("bootstraps a Docker local administrator and resolves only its persisted session", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-local-auth-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  process.env.LOCAL_ADMIN_USERNAME = "docker-admin";
  process.env.LOCAL_ADMIN_DISPLAY_NAME = "Docker 管理员";
  process.env.LOCAL_ADMIN_PASSWORD = "local-admin-password-2026";
  try {
    assert.equal(localAuthSetupRequired(), true);
    const bootstrap = bootstrapLocalAdministrator();
    assert.equal(bootstrap.created, true);
    assert.equal(localAuthSetupRequired(), false);

    const db = getDatabase();
    const account = db.prepare(`
      SELECT la.user_id AS userId, la.username, u.display_name AS displayName,
        u.is_gateway_admin AS isAdmin
      FROM local_accounts la JOIN users u ON u.id = la.user_id
    `).get() as { userId: string; username: string; displayName: string; isAdmin: number };
    assert.deepEqual({
      username: account.username,
      displayName: account.displayName,
      isAdmin: account.isAdmin
    }, {
      username: "docker-admin",
      displayName: "Docker 管理员",
      isAdmin: 1
    });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM health_members").get() as { count: number }).count, 1);

    const token = "persisted-local-session-token";
    const hash = createHash("sha256").update(token).digest("hex");
    db.prepare(`
      INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
      VALUES ('session-local-test', ?, ?, datetime('now', '+1 hour'))
    `).run(account.userId, hash);
    const event = {
      node: {
        req: {
          healthAccessMode: "port",
          headers: {
            cookie: `health_session=${token}`,
            "x-trim-userid": "spoofed-gateway-admin",
            "x-trim-isadmin": "true"
          }
        }
      }
    } as unknown as H3Event;
    assert.deepEqual(getRequestUser(event), {
      id: account.userId,
      displayName: "Docker 管理员",
      provider: "local",
      authenticated: true,
      isAdmin: true,
      isGatewayAdmin: true
    });

    const anonymousEvent = {
      node: { req: { healthAccessMode: "port", headers: { "x-trim-isadmin": "true" } } }
    } as unknown as H3Event;
    assert.deepEqual(getRequestUser(anonymousEvent), {
      id: "anonymous",
      displayName: "未登录",
      provider: "local",
      authenticated: false,
      isAdmin: false,
      isGatewayAdmin: false
    });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.LOCAL_ADMIN_USERNAME;
    delete process.env.LOCAL_ADMIN_DISPLAY_NAME;
    delete process.env.LOCAL_ADMIN_PASSWORD;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("logs in, revokes local sessions, trusts HTTPS proxy explicitly and rate limits failures", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-local-login-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  process.env.LOCAL_ADMIN_USERNAME = "docker-admin";
  process.env.LOCAL_ADMIN_PASSWORD = "local-admin-password-2026";
  try {
    bootstrapLocalAdministrator();
    const loginEvent = localAuthEvent();
    assert.deepEqual(login(loginEvent, {
      username: "docker-admin",
      password: "local-admin-password-2026"
    }), { authenticated: true });
    const setCookie = loginEvent.res.headers.get("set-cookie") || "";
    assert.match(setCookie, /^health_session=[^;]+;/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Secure/);
    const cookie = setCookie.split(";", 1)[0];
    assert.equal(getRequestUser(localAuthEvent({ cookie })).authenticated, true);

    assert.deepEqual(logout(localAuthEvent({ cookie })), { authenticated: false });
    assert.equal(getRequestUser(localAuthEvent({ cookie })).authenticated, false);

    process.env.TRUST_PROXY = "1";
    const httpsEvent = localAuthEvent({ forwardedProto: "https", clientAddress: "127.0.0.2" });
    login(httpsEvent, {
      username: "docker-admin",
      password: "local-admin-password-2026"
    });
    assert.match(httpsEvent.res.headers.get("set-cookie") || "", /Secure/);
    delete process.env.TRUST_PROXY;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.throws(() => login(localAuthEvent(), {
        username: "docker-admin",
        password: "incorrect-password"
      }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 401);
    }
    assert.throws(() => login(localAuthEvent(), {
      username: "docker-admin",
      password: "incorrect-password"
    }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 429);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.LOCAL_ADMIN_USERNAME;
    delete process.env.LOCAL_ADMIN_PASSWORD;
    delete process.env.TRUST_PROXY;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("changes a local administrator password and revokes every existing session", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-password-change-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  process.env.LOCAL_ADMIN_USERNAME = "docker-admin";
  process.env.LOCAL_ADMIN_PASSWORD = "local-admin-password-2026";
  try {
    bootstrapLocalAdministrator();
    const firstLogin = localAuthEvent();
    login(firstLogin, { username: "docker-admin", password: "local-admin-password-2026" });
    const firstCookie = (firstLogin.res.headers.get("set-cookie") || "").split(";", 1)[0];
    const secondLogin = localAuthEvent({ clientAddress: "127.0.0.2" });
    login(secondLogin, { username: "docker-admin", password: "local-admin-password-2026" });
    const secondCookie = (secondLogin.res.headers.get("set-cookie") || "").split(";", 1)[0];
    const event = localAuthEvent({ cookie: firstCookie });
    const user = getRequestUser(event);

    assert.deepEqual(changeLocalPassword(event, user, {
      currentPassword: "local-admin-password-2026",
      newPassword: "new-local-password-2026",
      confirmPassword: "new-local-password-2026"
    }), { changed: true, reauthenticationRequired: true });
    assert.match(event.res.headers.get("set-cookie") || "", /Max-Age=0/);
    assert.equal(getRequestUser(localAuthEvent({ cookie: firstCookie })).authenticated, false);
    assert.equal(getRequestUser(localAuthEvent({ cookie: secondCookie })).authenticated, false);
    assert.throws(() => login(localAuthEvent(), {
      username: "docker-admin",
      password: "local-admin-password-2026"
    }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 401);
    assert.deepEqual(login(localAuthEvent(), {
      username: "docker-admin",
      password: "new-local-password-2026"
    }), { authenticated: true });
    const audit = getDatabase().prepare(`
      SELECT action FROM audit_logs WHERE action = 'auth.local_password_changed'
    `).get() as { action: string } | undefined;
    assert.equal(audit?.action, "auth.local_password_changed");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.LOCAL_ADMIN_USERNAME;
    delete process.env.LOCAL_ADMIN_PASSWORD;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("does not expose local password management in fnOS mode", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-fnos-password-"));
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "fnos";
  try {
    const user = {
      id: "fnos-admin",
      displayName: "飞牛管理员",
      provider: "fnos_gateway" as const,
      authenticated: true,
      isAdmin: true,
      isGatewayAdmin: true
    };
    assert.throws(() => changeLocalPassword(localAuthEvent(), user, {
      currentPassword: "irrelevant-password",
      newPassword: "new-local-password-2026",
      confirmPassword: "new-local-password-2026"
    }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 410);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("resets a forgotten local password through the offline Docker command", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-password-reset-"));
  const passwordFile = join(storageDir, "reset-password.txt");
  process.env.STORAGE_DIR = storageDir;
  process.env.AUTH_MODE = "local";
  process.env.LOCAL_ADMIN_USERNAME = "docker-admin";
  process.env.LOCAL_ADMIN_PASSWORD = "local-admin-password-2026";
  try {
    bootstrapLocalAdministrator();
    closeDatabaseForTests();
    writeFileSync(passwordFile, "offline-reset-password-2026\n", { mode: 0o600 });
    const output = execFileSync(process.execPath, [
      join(process.cwd(), "scripts", "reset-local-admin-password.mjs"),
      "--password-file", passwordFile,
      "--username", "docker-admin"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, STORAGE_DIR: storageDir }
    });
    assert.match(output, /password reset completed/);
    assert.throws(() => login(localAuthEvent(), {
      username: "docker-admin",
      password: "local-admin-password-2026"
    }), (error: unknown) => Number((error as { statusCode?: number }).statusCode) === 401);
    assert.deepEqual(login(localAuthEvent(), {
      username: "docker-admin",
      password: "offline-reset-password-2026"
    }), { authenticated: true });
    const audit = getDatabase().prepare(`
      SELECT action FROM audit_logs WHERE action = 'auth.local_password_reset'
    `).get() as { action: string } | undefined;
    assert.equal(audit?.action, "auth.local_password_reset");
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    delete process.env.AUTH_MODE;
    delete process.env.LOCAL_ADMIN_USERNAME;
    delete process.env.LOCAL_ADMIN_PASSWORD;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
