import assert from "node:assert/strict";
import test from "node:test";
import type { H3Event } from "h3";
import { getRequestAccessMode } from "../utils/access-mode.ts";
import { getGatewayUser } from "../utils/gateway-user.ts";

function event(accessMode: "gateway" | "port") {
  return {
    node: {
      req: {
        healthAccessMode: accessMode,
        headers: {
          "x-trim-userid": "1000",
          "x-trim-username": "测试用户",
          "x-trim-isadmin": "true"
        }
      }
    }
  } as unknown as H3Event;
}

test("accepts fnOS headers only on the gateway listener", () => {
  assert.deepEqual(getGatewayUser(event("gateway")), {
    authenticated: true,
    uid: "1000",
    username: "测试用户",
    isAdmin: true
  });
  assert.deepEqual(getGatewayUser(event("port")), {
    authenticated: false,
    uid: null,
    username: null,
    isAdmin: false
  });
});

test("reports the access mode marked by each listener", () => {
  assert.equal(getRequestAccessMode(event("gateway")), "gateway");
  assert.equal(getRequestAccessMode(event("port")), "port");
});
