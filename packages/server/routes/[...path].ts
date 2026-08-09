import { createError, defineEventHandler, getRequestURL, sendProxy, setResponseHeader } from "h3";
import { extname } from "node:path";
import {
  isAssetRequest,
  readUiFile,
  readUiIndexHtml,
  stripGatewayPrefix
} from "../utils/ui-files";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json"
};

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);
  const appPath = stripGatewayPrefix(url.pathname);

  if (appPath.startsWith("/api/") || appPath === "/healthz") {
    throw createError({
      statusCode: 404,
      statusMessage: "Not Found"
    });
  }

  const viteDevServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (viteDevServerUrl) {
    return sendProxy(event, `${viteDevServerUrl}${url.pathname}${url.search}`);
  }

  const file = await readUiFile(appPath);
  if (!file) {
    if (isAssetRequest(appPath)) {
      throw createError({
        statusCode: 404,
        statusMessage: "Not Found"
      });
    }

    const html = await readUiIndexHtml();
    setResponseHeader(event, "content-type", "text/html; charset=utf-8");
    /* index.html 必须每次回源验证：WebView 缓存旧 HTML 会引用已删除的旧哈希 assets，升级后整页白屏 */
    setResponseHeader(event, "cache-control", "no-cache");
    return html;
  }

  const ext = extname(appPath).toLowerCase();
  const contentType = contentTypes[ext] || "application/octet-stream";
  setResponseHeader(event, "content-type", contentType);
  /* 带内容哈希的构建产物永久缓存；favicon 等非哈希文件仅短缓存 */
  setResponseHeader(
    event,
    "cache-control",
    appPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600"
  );
  return file;
});
