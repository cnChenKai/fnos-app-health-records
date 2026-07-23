import type { ApiResponse } from "../types/api";

const appBasePath = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
const apiBase = new URL("api/", new URL(appBasePath, window.location.origin));

export function apiUrl(path: string) {
  return new URL(path.replace(/^\//, ""), apiBase).toString();
}

export async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const payload = await response.json() as ApiResponse<T>;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message || payload.statusMessage || "请求失败");
  }
  return payload.data;
}
