import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveSingleByteRange } from "../utils/http-byte-range";

test("backup byte ranges support initial, open-ended, and suffix requests", () => {
  assert.deepEqual(resolveSingleByteRange(undefined, 1000), { kind: "full" });
  assert.deepEqual(resolveSingleByteRange("bytes=0-99", 1000), {
    kind: "partial", start: 0, end: 99, length: 100
  });
  assert.deepEqual(resolveSingleByteRange("bytes=900-", 1000), {
    kind: "partial", start: 900, end: 999, length: 100
  });
  assert.deepEqual(resolveSingleByteRange("bytes=-64", 1000), {
    kind: "partial", start: 936, end: 999, length: 64
  });
  assert.deepEqual(resolveSingleByteRange("bytes=900-1200", 1000), {
    kind: "partial", start: 900, end: 999, length: 100
  });
});

test("backup byte ranges reject invalid or unsupported requests", () => {
  for (const value of ["items=0-10", "bytes=", "bytes=1000-", "bytes=20-10", "bytes=0-1,4-5", "bytes=-0"]) {
    assert.deepEqual(resolveSingleByteRange(value, 1000), { kind: "unsatisfiable" });
  }
});

test("backup downloads use native streaming instead of buffering a Blob", () => {
  const download = readFileSync(join(process.cwd(), "packages/ui/src/utils/download.ts"), "utf8");
  const page = readFileSync(join(process.cwd(), "packages/ui/src/pages/settings/DataAuditSettingsPage.vue"), "utf8");
  const route = readFileSync(join(process.cwd(), "packages/server/routes/api/backups/[id]/download.get.ts"), "utf8");
  const headRoute = readFileSync(join(process.cwd(), "packages/server/routes/api/backups/[id]/download.head.ts"), "utf8");
  const streamedFunction = download.match(/export async function downloadStreamedFile[\s\S]*?\n\}/)?.[0] || "";
  assert.match(streamedFunction, /method:\s*"HEAD"/);
  assert.match(streamedFunction, /anchor\.click\(\)/);
  assert.doesNotMatch(streamedFunction, /\.blob\(\)/);
  assert.match(page, /downloadStreamedFile\(`backups\/\$\{encodeURIComponent\(backup\.id\)\}\/download`/);
  assert.match(route, /"accept-ranges",\s*"bytes"/);
  assert.match(route, /createReadStream\(backup\.path, \{ start: range\.start, end: range\.end \}\)/);
  assert.match(route, /setResponseStatus\(event, 416, "Range Not Satisfiable"\)/);
  assert.match(headRoute, /"content-length",\s*String\(backup\.sizeBytes\)/);
  assert.match(headRoute, /"accept-ranges",\s*"bytes"/);
});
