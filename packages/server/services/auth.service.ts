import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createError, getRequestIP, setCookie, deleteCookie, type H3Event } from "h3";
import { getDatabase } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { getAppConfig } from "../utils/runtime-config";
import { createId } from "../utils/identifier";

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw createError({ statusCode: 400, statusMessage: `${label}不能为空` });
  }
  return value.trim();
}

function sessionToken(event: H3Event) {
  const encoded = event.node!.req!.headers.cookie?.match(/(?:^|;\s*)health_session=([^;]+)/)?.[1];
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cleanBootstrapUsername(value: string) {
  const username = value.trim();
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    throw new Error("LOCAL_ADMIN_USERNAME must be 3-64 characters using letters, numbers, dot, underscore or hyphen");
  }
  return username;
}

function cleanBootstrapPassword(value: string) {
  const password = value.trim();
  if (password.length < 12 || password.length > 128) {
    throw new Error("Local administrator password must contain 12-128 characters");
  }
  return password;
}

function bootstrapPassword() {
  const path = String(process.env.LOCAL_ADMIN_PASSWORD_FILE || "").trim();
  if (path) {
    if (!existsSync(path)) throw new Error(`LOCAL_ADMIN_PASSWORD_FILE does not exist: ${path}`);
    return readFileSync(path, "utf8").trim();
  }
  return String(process.env.LOCAL_ADMIN_PASSWORD || "").trim();
}

export function localAuthSetupRequired() {
  if (getAppConfig().authMode !== "local") return false;
  const row = getDatabase().prepare(`
    SELECT COUNT(*) AS count FROM local_accounts WHERE disabled_at IS NULL
  `).get() as { count: number };
  return Number(row.count) === 0;
}

export function bootstrapLocalAdministrator() {
  if (getAppConfig().authMode !== "local" || !localAuthSetupRequired()) {
    return { created: false, setupRequired: false };
  }
  const rawPassword = bootstrapPassword();
  if (!rawPassword) return { created: false, setupRequired: true };

  const username = cleanBootstrapUsername(process.env.LOCAL_ADMIN_USERNAME || "admin");
  const displayName = String(process.env.LOCAL_ADMIN_DISPLAY_NAME || username).trim().slice(0, 40) || username;
  const password = cleanBootstrapPassword(rawPassword);
  const passwordValue = hashPassword(password);
  const userId = createId("user");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const account = db.prepare(`SELECT 1 FROM local_accounts WHERE disabled_at IS NULL LIMIT 1`).get();
    if (account) {
      db.exec("COMMIT");
      return { created: false, setupRequired: false };
    }
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, 1)
    `).run(userId, displayName);
    db.prepare(`
      INSERT INTO user_identities (id, user_id, provider, subject) VALUES (?, ?, 'local', ?)
    `).run(createId("identity"), userId, username);
    db.prepare(`
      INSERT INTO local_accounts (id, user_id, username, password_hash, password_salt)
      VALUES (?, ?, ?, ?, ?)
    `).run(createId("account"), userId, username, passwordValue.hash, passwordValue.salt);
    const memberId = createId("member");
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES (?, ?, 'self', ?)
    `).run(memberId, displayName, userId);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `).run(memberId, userId, userId);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'auth.local_admin_bootstrap', 'user', ?, ?)
    `).run(createId("audit"), userId, userId, JSON.stringify({ username }));
    db.exec("COMMIT");
    delete process.env.LOCAL_ADMIN_PASSWORD;
    return { created: true, setupRequired: false, username };
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

export function getLocalSessionUser(event: H3Event): RequestUser | null {
  if (getAppConfig().authMode !== "local") return null;
  const token = sessionToken(event);
  if (!token) return null;
  const hash = tokenHash(token);
  const db = getDatabase();
  const row = db.prepare(`
    SELECT u.id, u.display_name AS displayName, u.is_gateway_admin AS isAdmin
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN local_accounts la ON la.user_id = u.id AND la.disabled_at IS NULL
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
  `).get(hash) as { id: string; displayName: string; isAdmin: number } | undefined;
  if (!row) return null;
  db.prepare(`
    UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP
    WHERE token_hash = ? AND last_seen_at < datetime('now', '-5 minutes')
  `).run(hash);
  return {
    id: row.id,
    displayName: row.displayName,
    provider: "local",
    authenticated: true,
    isAdmin: Boolean(row.isAdmin),
    isGatewayAdmin: Boolean(row.isAdmin)
  };
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

/* 浏览器会拒收 HTTP 明文连接下发的 Secure cookie，按请求实际协议（含网关上送的 X-Forwarded-Proto）决定 */
function isHttpsRequest(event: H3Event) {
  const request = event.node!.req!;
  const forwarded = request.headers["x-forwarded-proto"];
  if (getAppConfig().trustProxy && typeof forwarded === "string" && forwarded.trim()) {
    const proto = forwarded.split(",", 1)[0];
    return typeof proto === "string" && proto.trim().toLowerCase() === "https";
  }
  return Boolean((request.socket as { encrypted?: boolean }).encrypted);
}

function verifyPassword(password: string, salt: string, expectedHex: string) {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function login(event: H3Event, body: Record<string, unknown>) {
  if (getAppConfig().authMode !== "local") {
    throw createError({ statusCode: 410, statusMessage: "当前部署使用 fnOS 账号体系，不提供独立登录" });
  }
  if (localAuthSetupRequired()) {
    throw createError({ statusCode: 503, statusMessage: "本地管理员尚未初始化，请先配置 Docker Secret 并重启" });
  }
  const username = requiredText(body.username, "用户名");
  const password = requiredText(body.password, "密码");
  const ip = getRequestIP(event, { xForwardedFor: getAppConfig().trustProxy }) || "unknown";
  const db = getDatabase();
  const recentFailures = db.prepare(`
    SELECT COUNT(*) AS count FROM login_attempts
    WHERE username = ? AND ip_address = ? AND succeeded = 0
      AND attempted_at >= datetime('now', '-15 minutes')
  `).get(username, ip) as { count: number };
  if (Number(recentFailures.count) >= 5) {
    throw createError({ statusCode: 429, statusMessage: "登录失败次数过多，请稍后再试" });
  }

  const account = db.prepare(`
    SELECT la.user_id AS userId, la.password_hash AS passwordHash, la.password_salt AS passwordSalt
    FROM local_accounts la WHERE la.username = ? AND la.disabled_at IS NULL
  `).get(username) as { userId: string; passwordHash: string; passwordSalt: string } | undefined;
  const succeeded = Boolean(account && verifyPassword(password, account.passwordSalt, account.passwordHash));
  db.prepare("INSERT INTO login_attempts (username, ip_address, succeeded) VALUES (?, ?, ?)")
    .run(username, ip, succeeded ? 1 : 0);
  if (!succeeded || !account) {
    throw createError({ statusCode: 401, statusMessage: "用户名或密码错误" });
  }

  const token = randomBytes(32).toString("base64url");
  const hash = tokenHash(token);
  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, datetime('now', '+12 hours'))
  `).run(createId("session"), account.userId, hash);
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 day')").run();
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= CURRENT_TIMESTAMP OR revoked_at IS NOT NULL").run();
  setCookie(event, "health_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development" && isHttpsRequest(event),
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 60 * 60
  });
  return { authenticated: true };
}

export function logout(event: H3Event) {
  const token = sessionToken(event);
  if (token) {
    getDatabase().prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(tokenHash(token));
  }
  deleteCookie(event, "health_session", { path: "/" });
  return { authenticated: false };
}

export function changeLocalPassword(event: H3Event, user: RequestUser, body: Record<string, unknown>) {
  if (getAppConfig().authMode !== "local") {
    throw createError({ statusCode: 410, statusMessage: "当前部署使用 fnOS 账号体系，密码由 fnOS 统一管理" });
  }
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  if (user.provider !== "local" || !isAdministrator(user)) {
    throw createError({ statusCode: 403, statusMessage: "仅本地管理员可修改密码" });
  }

  const currentPassword = requiredText(body.currentPassword, "当前密码");
  let newPassword = "";
  try {
    newPassword = cleanBootstrapPassword(requiredText(body.newPassword, "新密码"));
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: "新密码长度必须为 12-128 个字符"
    });
  }
  const confirmation = requiredText(body.confirmPassword, "确认密码");
  if (newPassword !== confirmation) {
    throw createError({ statusCode: 400, statusMessage: "两次输入的新密码不一致" });
  }
  if (newPassword === currentPassword) {
    throw createError({ statusCode: 400, statusMessage: "新密码不能与当前密码相同" });
  }

  const db = getDatabase();
  const account = db.prepare(`
    SELECT id, username, password_hash AS passwordHash, password_salt AS passwordSalt
    FROM local_accounts WHERE user_id = ? AND disabled_at IS NULL
  `).get(user.id) as {
    id: string;
    username: string;
    passwordHash: string;
    passwordSalt: string;
  } | undefined;
  if (!account || !verifyPassword(currentPassword, account.passwordSalt, account.passwordHash)) {
    throw createError({ statusCode: 400, statusMessage: "当前密码不正确" });
  }

  const next = hashPassword(newPassword);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE local_accounts
      SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(next.hash, next.salt, account.id);
    db.prepare(`
      UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(user.id);
    db.prepare("DELETE FROM login_attempts WHERE username = ?").run(account.username);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'auth.local_password_changed', 'user', ?, ?)
    `).run(createId("audit"), user.id, user.id, JSON.stringify({ username: account.username, sessionsRevoked: true }));
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
  deleteCookie(event, "health_session", { path: "/" });
  return { changed: true, reauthenticationRequired: true };
}
