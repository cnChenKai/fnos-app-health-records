import { defineEventHandler, getRequestURL, sendProxy, setResponseHeader } from "h3";
import { readUiIndexHtml } from "../utils/ui-files";

export default defineEventHandler(async (event) => {
  const viteDevServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (viteDevServerUrl) {
    return sendProxy(event, `${viteDevServerUrl}${getRequestURL(event).pathname}${getRequestURL(event).search}`);
  }

  const html = await readUiIndexHtml();
  setResponseHeader(event, "content-type", "text/html; charset=utf-8");
  /* index.html 必须每次回源验证：WebView 缓存旧 HTML 会引用已删除的旧哈希 assets，升级后整页白屏 */
  setResponseHeader(event, "cache-control", "no-cache");
  return html;
});
