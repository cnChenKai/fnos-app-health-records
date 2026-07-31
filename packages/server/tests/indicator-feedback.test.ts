import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIndicatorDictionaryIssueUrl,
  sanitizeIndicatorFeedbackName
} from "../../ui/src/utils/indicator-feedback.ts";

test("builds indicator feedback with names only and rejects likely identity data", () => {
  assert.equal(sanitizeIndicatorFeedbackName("  白细胞\n计数  "), "白细胞 计数");
  assert.equal(sanitizeIndicatorFeedbackName("联系电话 13800138000"), null);
  assert.equal(sanitizeIndicatorFeedbackName("证件 440101199001011234"), null);
  assert.equal(sanitizeIndicatorFeedbackName("user@example.com"), null);

  const value = buildIndicatorDictionaryIssueUrl([
    "白细胞计数",
    "白细胞计数",
    "中性粒细胞百分比",
    "联系电话 13800138000"
  ]);
  const url = new URL(value);
  assert.equal(url.origin, "https://github.com");
  const body = url.searchParams.get("body") || "";
  assert.match(body, /- 白细胞计数/);
  assert.match(body, /- 中性粒细胞百分比/);
  assert.equal(body.match(/- 白细胞计数/g)?.length, 1);
  assert.doesNotMatch(body, /13800138000|440101199001011234|user@example\.com/);
});
