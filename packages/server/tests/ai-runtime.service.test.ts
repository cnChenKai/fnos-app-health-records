import assert from "node:assert/strict";
import test from "node:test";
import { executeAiChatCompletion } from "../services/ai-runtime.service.ts";

test("executes an OpenAI-compatible task without knowing report-domain fields", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: "runtime-model-v2",
      choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 }
    }), { status: 200 });
  };
  try {
    const result = await executeAiChatCompletion({
      provider: "test",
      baseUrl: "https://ai.example.test/v1",
      apiKey: "secret",
      model: "runtime-model"
    }, {
      messages: [{ role: "user", content: "test" }],
      responseFormat: "json_object",
      maxOutputTokens: 128,
      timeoutMs: 15_000
    });
    assert.equal(body.model, "runtime-model");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(result, {
      provider: "test",
      model: "runtime-model-v2",
      content: "{\"ok\":true}",
      finishReason: "stop",
      promptTokens: 12,
      completionTokens: 5,
      elapsedMs: result.elapsedMs
    });
    assert.ok(result.elapsedMs >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns provider status and detail through a stable runtime error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: "quota exhausted" }
  }), { status: 429 });
  try {
    await assert.rejects(
      () => executeAiChatCompletion({
        provider: "test",
        baseUrl: "https://ai.example.test/v1",
        apiKey: "secret",
        model: "runtime-model"
      }, {
        messages: [{ role: "user", content: "test" }],
        maxOutputTokens: 64,
        timeoutMs: 15_000
      }),
      (error: unknown) => {
        const value = error as { code?: string; upstreamStatus?: number; upstreamDetail?: string };
        return value.code === "AI_HTTP_429"
          && value.upstreamStatus === 429
          && value.upstreamDetail === "quota exhausted";
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
