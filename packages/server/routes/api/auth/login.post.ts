import { createError, defineEventHandler } from "h3";

export default defineEventHandler(() => {
  throw createError({ statusCode: 410, statusMessage: "健康档案使用 fnOS 账号体系，不提供独立登录" });
});
