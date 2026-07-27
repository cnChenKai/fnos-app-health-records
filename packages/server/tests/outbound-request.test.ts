import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithTimeout } from "../utils/outbound-request.ts";

test("classifies an outbound AI request timeout", async () => {
  const originalFetch = globalThis.fetch;
  const keepAlive = setTimeout(() => {}, 100);
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  try {
    await assert.rejects(
      () => fetchWithTimeout("https://ai.example.test", {}, {
        timeoutMs: 10,
        timeoutCode: "AI_REQUEST_TIMEOUT",
        timeoutMessage: "AI 请求超时",
        networkCode: "AI_NETWORK_ERROR",
        networkMessage: "AI 网络错误"
      }),
      (error: unknown) => (error as { code?: string; message?: string }).code === "AI_REQUEST_TIMEOUT"
        && (error as Error).message === "AI 请求超时"
    );
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
  }
});
