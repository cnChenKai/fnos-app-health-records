import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createError, getRequestIP, setCookie, deleteCookie, type H3Event } from "h3";
import { getDatabase } from "../database/client";
import { createId } from "../utils/identifier";

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw createError({ statusCode: 400, statusMessage: `${label}不能为空` });
  }
  return value.trim();
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

/* 浏览器会拒收 HTTP 明文连接下发的 Secure cookie，按请求实际协议（含网关上送的 X-Forwarded-Proto）决定 */
function isHttpsRequest(event: H3Event) {
  const request = event.node!.req!;
  const forwarded = request.headers["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded.trim()) {
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
  const username = requiredText(body.username, "用户名");
  const password = requiredText(body.password, "密码");
  const ip = getRequestIP(event, { xForwardedFor: false }) || "unknown";
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
  const tokenHash = createHash("sha256").update(token).digest("hex");
  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, datetime('now', '+12 hours'))
  `).run(createId("session"), account.userId, tokenHash);
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
  const token = event.node!.req!.headers.cookie?.match(/(?:^|;\s*)health_session=([^;]+)/)?.[1];
  if (token) {
    const tokenHash = createHash("sha256").update(decodeURIComponent(token)).digest("hex");
    getDatabase().prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(tokenHash);
  }
  deleteCookie(event, "health_session", { path: "/" });
  return { authenticated: false };
}
