import assert from "node:assert/strict";
import test from "node:test";
import { createError, type H3Event } from "h3";
import errorHandler from "../error-handler";

test("redirects unprefixed routes with a valid relative Location header", async () => {
  const event = {
    url: new URL("http://127.0.0.1:3534/healthz?probe=1")
  } as H3Event;

  const response = await errorHandler(
    createError({ statusCode: 404, statusMessage: "Not Found" }),
    event
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "/app/fnos-app-health-records/healthz?probe=1"
  );
});
