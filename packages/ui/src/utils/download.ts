import { apiUrl } from "./api";
import { describeTechnical } from "./error";

/* 用 location.href 直接下载时，服务端报错会把用户导航到裸 JSON 错误页、应用状态全丢；
   改为 fetch 先校验响应，再生成 Blob 触发浏览器下载，失败抛出让调用方提示 */
export async function downloadFile(path: string, fallbackName: string) {
  let response: Response;
  try {
    response = await fetch(apiUrl(path));
  } catch (cause) {
    throw new Error(`无法连接服务器，请检查网络或 fnOS 网关状态后重试（${describeTechnical(cause)}）`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as { error?: { message?: string }; statusMessage?: string };
      detail = payload.error?.message || payload.statusMessage || "";
    } catch { /* 网关返回的非 JSON 错误页，状态码已足够定位 */ }
    throw new Error(`${detail || "文件下载失败"}（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1].replace(/"/g, "")) : fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* 大文件交给浏览器下载器边接收边落盘，避免 response.blob() 在内嵌 WebView 中
   长时间占用内存。HEAD 只校验权限和文件状态，不读取备份正文。 */
export async function downloadStreamedFile(path: string, fallbackName: string) {
  const url = apiUrl(path);
  let response: Response;
  try {
    response = await fetch(url, { method: "HEAD", cache: "no-store" });
  } catch (cause) {
    throw new Error(`无法连接服务器，请检查网络或 fnOS 网关状态后重试（${describeTechnical(cause)}）`);
  }
  if (!response.ok) {
    throw new Error(`备份文件下载准备失败（HTTP ${response.status}）`);
  }

  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1].replace(/"/g, "")) : fallbackName;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
