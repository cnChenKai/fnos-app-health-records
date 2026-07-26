import { HTTPError, type H3Event } from "h3";
import templateConfig from "../../template.config.json" with { type: "json" };
import { writeLog } from "./utils/logger";

const baseURL = `${templateConfig.gatewayPrefix}/`;

/* h3 的 node 适配器会把所有路由错误再包一层 { unhandled: true } 的 HTTPError，逐层剥回最内层的业务错误 */
function unwrapHttpError(error: unknown) {
  let current: unknown = error;
  while (HTTPError.isError(current) && current.unhandled && HTTPError.isError(current.cause)) {
    current = current.cause;
  }
  return HTTPError.isError(current) && !current.unhandled ? current : null;
}

function describeCauseChain(error: unknown) {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.stack || current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n--- caused by ---\n");
}

/*
 * 全局错误兜底：
 * - 业务错误（createError 抛出的 HTTPError）原样透传中文提示；
 * - 未预期错误（代码 bug、依赖异常）先写详细日志便于定位，对外只返回通用提示，不泄露内部细节；
 * - 保留基座路径之外请求的 302 重定向行为（fnOS 网关挂载需要）。
 */
export default async function errorHandler(error: unknown, event: H3Event) {
  const businessError = unwrapHttpError(error);
  const status = businessError?.status || 500;

  if (status === 404) {
    const url = event.url || new URL(event.req.url);
    if (!url.pathname.startsWith(baseURL)) {
      return Response.redirect(`${baseURL}${url.pathname.slice(1)}${url.search}`, 302);
    }
  }

  let body: Record<string, unknown>;
  if (businessError) {
    body = { error: true, ...businessError.toJSON() };
  } else {
    await writeLog("error", "unhandled-request-error", {
      method: event.method,
      path: (event.url || new URL(event.req.url)).pathname,
      detail: describeCauseChain(error).slice(0, 2000)
    });
    body = { error: true, status, message: "服务器开小差了，请稍后重试；若反复出现，请携带操作时间反馈给开发者" };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
