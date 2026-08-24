import { createError, defineEventHandler } from "h3";
import { getRequestUser } from "../utils/request-user";

const allowedPaths = new Set([
  "/api/session",
  "/api/auth/logout",
  "/api/auth/password"
]);

export default defineEventHandler((event) => {
  const user = getRequestUser(event);
  if (user.provider !== "local" || !user.authenticated || !user.mustChangePassword) return;
  const path = (event.node!.req!.url || "").split("?", 1)[0].replace(/\/$/, "");
  if (!path.startsWith("/api/")) return;
  if (allowedPaths.has(path)) return;
  throw createError({ statusCode: 428, statusMessage: "首次登录必须先修改密码" });
});
