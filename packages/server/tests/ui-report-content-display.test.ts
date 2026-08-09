import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const reportDetail = readFileSync(
  join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"),
  "utf8"
);
const styles = readFileSync(
  join(process.cwd(), "packages/ui/src/styles.css"),
  "utf8"
);

test("report detail previews ten standardized indicators by default", () => {
  assert.match(reportDetail, /const OBSERVATION_PREVIEW_LIMIT = 10;/);
  assert.match(reportDetail, /previewSourceObservations\.value\.slice\(0, OBSERVATION_PREVIEW_LIMIT\)/);
});

test("teleported content type selector stays above nested report editors", () => {
  const selectLayer = styles.match(/\.form-select-layer \{[^}]*z-index:\s*(\d+);[^}]*\}/)?.[1];
  const editorLayer = styles.match(/\.structured-section-editor-backdrop[^}]*z-index:\s*(\d+);[^}]*\}/)?.[1];
  assert.ok(selectLayer, "form-select layer z-index should be declared");
  assert.ok(editorLayer, "structured-section editor z-index should be declared");
  assert.ok(Number(selectLayer) > Number(editorLayer));
});
