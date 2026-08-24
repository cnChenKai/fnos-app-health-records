import assert from "node:assert/strict";
import test from "node:test";
import { assertLocalRequestOrigin } from "../middleware/01-csrf.ts";

test("accepts same-origin local writes and rejects cross-site requests", () => {
  assert.doesNotThrow(() => assertLocalRequestOrigin({
    method: "POST",
    origin: "https://health.example.test",
    host: "health.example.test",
    trustProxy: false
  }));
  assert.throws(() => assertLocalRequestOrigin({
    method: "DELETE",
    origin: "https://attacker.example.test",
    host: "health.example.test",
    trustProxy: false
  }), /请求来源与当前服务不一致/);
  assert.throws(() => assertLocalRequestOrigin({
    method: "POST",
    host: "health.example.test",
    fetchSite: "cross-site",
    trustProxy: false
  }), /跨站请求已拒绝/);
});

test("uses the forwarded host only when the reverse proxy is trusted", () => {
  assert.doesNotThrow(() => assertLocalRequestOrigin({
    method: "PUT",
    origin: "https://health.example.test",
    host: "health-records:3334",
    forwardedHost: "health.example.test",
    trustProxy: true
  }));
  assert.throws(() => assertLocalRequestOrigin({
    method: "PUT",
    origin: "https://health.example.test",
    host: "health-records:3334",
    forwardedHost: "health.example.test",
    trustProxy: false
  }), /请求来源与当前服务不一致/);
});
