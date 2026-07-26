import type { ApiResponse } from "../types/api";
import { describeTechnical } from "./error";

const appBasePath = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
const apiBase = new URL("api/", new URL(appBasePath, window.location.origin));

export function apiUrl(path: string) {
  return new URL(path.replace(/^\//, ""), apiBase).toString();
}

export async function request<T>(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
        ...init?.headers
      }
    });
  } catch (cause) {
    /* fetch 自身抛出的 TypeError 是英文技术串，转换为可理解的提示并保留细节供排查 */
    throw new Error(`无法连接服务器，请检查网络或 fnOS 网关状态后重试（${describeTechnical(cause)}）`);
  }
  let payload: ApiResponse<T>;
  try {
    payload = await response.json() as ApiResponse<T>;
  } catch {
    /* 网关/代理异常时可能返回 HTML 错误页，JSON 解析失败的原始报错对用户无意义 */
    throw new Error(`服务器返回了无法识别的数据，请稍后重试（HTTP ${response.status}）`);
  }
  if (!response.ok || !payload.ok) {
    /* 服务端错误体为 { error: true, status, statusText, message }（h3 v2），兼容旧版 statusMessage 与 fail() 的 error.message */
    const message = (typeof payload.error === "object" ? payload.error?.message : "")
      || payload.message
      || payload.statusText
      || payload.statusMessage
      || "请求失败";
    throw new Error(response.ok ? message : `${message}（HTTP ${response.status}）`);
  }
  return payload.data;
}
