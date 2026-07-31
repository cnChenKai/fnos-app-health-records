import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  aiInputPlanningPolicy,
  planRebuiltOcrPages,
  rebuildOcrPages,
  redactAiInputText
} from "../services/ai-input-planner.service.ts";
import { buildAiExtractionInput } from "../services/ai-extraction.service.ts";

const plannerStorageDir = mkdtempSync(join(tmpdir(), "health-records-ai-planner-"));
process.env.STORAGE_DIR = plannerStorageDir;
test.after(() => {
  closeDatabaseForTests();
  delete process.env.STORAGE_DIR;
  rmSync(plannerStorageDir, { recursive: true, force: true });
});

function page(pageNumber: number, lines: string[]) {
  return {
    pageId: `page-${pageNumber}`,
    pageNumber,
    linesJson: JSON.stringify(lines.map((text, index) => ({
      id: `p${pageNumber}-line-${index + 1}`,
      text,
      confidence: 0.98,
      box: [0, index * 12, 100, index * 12 + 10]
    })))
  };
}

test("packs complete OCR pages up to six pages without splitting page content", () => {
  const rows = Array.from({ length: 10 }, (_, index) =>
    page(index + 1, [
      `第${index + 1}页说明 ${"内容".repeat(150)}`,
      `指标${index + 1} ${index + 1}.2 mmol/L 参考范围 1.0-20.0`
    ])
  );
  const rebuilt = rebuildOcrPages(rows);
  const plan = planRebuiltOcrPages("report", rebuilt);
  const scalarUnits = plan.units.filter((unit) => unit.route === "scalar");

  assert.equal(plan.pageCount, 10);
  assert.equal(plan.unitCount, 3);
  assert.deepEqual(scalarUnits.map((unit) => unit.pageNumbers), [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10]]);
  assert.equal(plan.units[0].route, "document");
  assert.doesNotMatch(plan.units[0].text, /本地分类|checkup/);
  assert.ok(plan.units.every((unit) => unit.unitType === "complete_pages"));
  assert.ok(scalarUnits.every((unit) => unit.characterCount <= aiInputPlanningPolicy.targetCharacters));
  assert.ok(scalarUnits.every((unit) => unit.pageNumbers.length <= aiInputPlanningPolicy.maxPagesPerUnit));
});

test("keeps a dense oversized page intact instead of splitting original page content", () => {
  const lines = [
    "项目 | 结果 | 单位 | 参考范围",
    ...Array.from({ length: 130 }, (_, index) =>
      `检验项目${index + 1} ${index + 1}.2 mmol/L 参考 ${index}.0-${index + 2}.0`
    )
  ];
  const rebuilt = rebuildOcrPages([page(4, lines)]);
  const plan = planRebuiltOcrPages("report", rebuilt);

  const scalar = plan.units.find((unit) => unit.route === "scalar");
  assert.equal(plan.unitCount, 2);
  assert.ok(scalar);
  assert.equal(scalar.unitType, "complete_pages");
  assert.equal(scalar.candidateRowCount, 130);
  assert.ok(scalar.estimatedOutputTokens > aiInputPlanningPolicy.targetOutputTokens);
  assert.equal(scalar.lineCount, rebuilt[0].lineCount);
  assert.match(scalar.text, /检验项目130/);
});

test("uses conservative output estimates to plan a dense 24-page report before provider calls", () => {
  const candidateCounts = [
    1, 16, 2, 8, 1, 25, 4, 1,
    23, 71, 41, 40, 47, 3, 1, 2,
    1, 14, 1, 9, 18, 2, 1, 1
  ];
  const rows = candidateCounts.map((count, pageIndex) => page(pageIndex + 1, [
    `第 ${pageIndex + 1} 页检查`,
    "项目 | 结果 | 单位 | 参考范围",
    ...Array.from({ length: count }, (_, itemIndex) =>
      `指标${pageIndex + 1}-${itemIndex + 1} ${itemIndex + 1}.2 mmol/L 参考范围 1.0-200.0`
    )
  ]));
  const plan = planRebuiltOcrPages("dense-report", rebuildOcrPages(rows));

  assert.equal(plan.pageCount, 24);
  const scalarUnits = plan.units.filter((unit) => unit.route === "scalar");
  assert.equal(plan.unitCount, 9);
  assert.equal(scalarUnits.length, 8);
  assert.equal(scalarUnits.flatMap((unit) => unit.pageNumbers).join(","), candidateCounts.map((_, index) => index + 1).join(","));
  assert.ok(scalarUnits.every((unit) => unit.pageNumbers.length <= aiInputPlanningPolicy.maxPagesPerUnit));
  assert.ok(scalarUnits.every((unit) =>
    unit.candidateRowCount <= aiInputPlanningPolicy.maxCandidateRowsPerUnit
    || unit.pageNumbers.length === 1
  ));
  assert.ok(scalarUnits.every((unit) =>
    unit.estimatedOutputTokens <= aiInputPlanningPolicy.targetOutputTokens
    || unit.pageNumbers.length === 1
  ));
});

test("preserves oversized page sections and produces stable content hashes", () => {
  const rows = [page(8, [
    "一般检查",
    ...Array.from({ length: 30 }, (_, index) => `一般检查说明${index + 1} ${"内容".repeat(120)}`),
    "血常规",
    "项目 结果 单位 参考范围",
    ...Array.from({ length: 70 }, (_, index) => `白细胞分项${index + 1} ${index + 1}.1 mmol/L 参考范围 1.0-20.0`)
  ])];
  const first = planRebuiltOcrPages("report", rebuildOcrPages(rows));
  const second = planRebuiltOcrPages("report", rebuildOcrPages(rows));
  const changed = planRebuiltOcrPages("report", rebuildOcrPages([
    page(8, [...JSON.parse(rows[0].linesJson).map((line: { text: string }) => line.text), "新增检查说明"])
  ]));

  assert.equal(first.planHash, second.planHash);
  assert.deepEqual(first.units.map((unit) => unit.unitKey), second.units.map((unit) => unit.unitKey));
  assert.notEqual(first.planHash, changed.planHash);
  assert.equal(first.unitCount, 2);
  const scalar = first.units.find((unit) => unit.route === "scalar");
  assert.ok(scalar);
  assert.match(scalar.text, /血常规/);
  assert.match(scalar.text, /白细胞分项70/);
  assert.doesNotMatch(scalar.text, /一般检查说明30/);
});

test("redacts direct patient identity while retaining business identifiers", () => {
  const text = redactAiInputText([
    "姓名：张三 报告号：R-20260729",
    "李小明 | 男 | 36岁",
    "身份证号：440101199001011234 体检号：PE-100",
    "手机号：13800138000 检查号：EX-200",
    "邮箱：patient@example.com",
    "出生日期：1990-01-01 性别：男 年龄：36岁",
    "住院号：IP-300 标本号：SP-400 条码号：BC-500"
  ].join("\n"));

  assert.doesNotMatch(text, /张三|李小明|440101199001011234|13800138000|patient@example\.com|1990-01-01/);
  assert.match(text, /R-20260729|PE-100|EX-200|IP-300|SP-400|BC-500/);
  assert.match(text, /男 \| 36岁/);
  assert.match(text, /性别：男 年龄：36岁/);
});

test("redacts an unlabeled patient name after OCR cells are merged into a visual row", () => {
  const rebuilt = rebuildOcrPages([{
    pageId: "identity-row",
    pageNumber: 1,
    linesJson: JSON.stringify([
      { id: "name", text: "王小明", confidence: 0.99, box: [10, 10, 80, 20] },
      { id: "sex", text: "男", confidence: 0.99, box: [100, 10, 120, 20] },
      { id: "age", text: "36岁", confidence: 0.99, box: [140, 10, 180, 20] },
      { id: "report", text: "报告号：R-20260731", confidence: 0.99, box: [10, 40, 180, 50] }
    ])
  }]);
  assert.doesNotMatch(rebuilt[0].text, /王小明/);
  assert.match(rebuilt[0].text, /患者个资已过滤.*男.*36岁/);
  assert.match(rebuilt[0].text, /R-20260731/);
});

test("reconstructs OCR table cells by coordinates and attaches dictionary candidates", () => {
  const rebuilt = rebuildOcrPages([{
    pageId: "page-layout",
    pageNumber: 1,
    linesJson: JSON.stringify([
      { id: "name", text: "总胆固醇", confidence: 0.98, box: [[10, 20], [90, 20], [90, 40], [10, 40]] },
      { id: "value", text: "5.3", confidence: 0.99, box: [[120, 20], [160, 20], [160, 40], [120, 40]] },
      { id: "unit", text: "mmol/L", confidence: 0.99, box: [[180, 20], [240, 20], [240, 40], [180, 40]] },
      { id: "range", text: "0-5.2", confidence: 0.97, box: [[260, 20], [320, 20], [320, 40], [260, 40]] }
    ])
  }]);

  assert.equal(rebuilt[0].lines.length, 1);
  assert.equal(rebuilt[0].lines[0].text, "总胆固醇 | 5.3 | mmol/L | 0-5.2");
  assert.deepEqual(rebuilt[0].lines[0].sourceLineIds, ["name", "value", "unit", "range"]);
  assert.equal(rebuilt[0].lines[0].candidateKind, "scalar");
  assert.ok(rebuilt[0].lines[0].dictionaryFacts.some((fact) => fact.displayName === "总胆固醇"));
});

test("creates separate scalar and morphology extraction routes", () => {
  const plan = planRebuiltOcrPages("routed-report", rebuildOcrPages([
    page(1, [
      "血脂",
      "总胆固醇 5.3 mmol/L 参考范围 0-5.2",
      "超声检查",
      "右肾见囊肿，大小约 8×6 mm"
    ])
  ]));

  assert.deepEqual(plan.units.map((unit) => unit.route), ["document", "morphology"]);
  assert.match(plan.units[0].text, /总胆固醇/);
  assert.match(plan.units[1].text, /右肾见囊肿/);
  assert.ok(plan.units[0].candidateFacts.every((fact) => fact.kind === "scalar"));
  assert.ok(plan.units[1].candidateFacts.every((fact) => fact.kind === "morphology"));
});

test("keeps single-page laboratory indicators while excluding density-name false positives", () => {
  const plan = planRebuiltOcrPages("single-lab", rebuildOcrPages([
    page(1, [
      "检验报告单",
      "项目 | 结果 | 单位 | 参考范围",
      "钾 | 4.2 | mmol/L | 3.5~5.3",
      "高密度脂蛋白胆固醇 | 1.2 | mmol/L | >1.0"
    ])
  ]));
  assert.equal(plan.unitCount, 1);
  assert.equal(plan.units[0].extractionMode, "scalar");
  assert.equal(plan.units[0].allowDocumentFields, true);
  assert.equal(plan.units[0].candidateRowCount, 0);
  assert.equal(plan.localObservationCount, 2);
  const localFacts = plan.pages[0].lines.flatMap((line) =>
    line.localObservation ? [line.localObservation] : []
  );
  assert.deepEqual(localFacts.map((fact) => ({
    name: fact.normalizedName,
    value: fact.numericValue,
    unit: fact.unit,
    low: fact.referenceLow,
    high: fact.referenceHigh
  })), [
    { name: "钾", value: 4.2, unit: "mmol/L", low: 3.5, high: 5.3 },
    { name: "高密度脂蛋白胆固醇", value: 1.2, unit: "mmol/L", low: 1, high: null }
  ]);
  assert.equal(plan.morphologyCandidateCount, 0);
});

test("keeps pure narrative medical sections in a dedicated route", () => {
  const plan = planRebuiltOcrPages("inpatient-narrative", rebuildOcrPages([
    page(1, [
      "出院小结",
      "住院号：ZY-20260730",
      "住院经过：患者入院后完成相关检查并接受治疗。",
      "出院医嘱：按门诊安排复诊。"
    ])
  ]));

  assert.deepEqual(plan.units.map((unit) => unit.route), ["document", "narrative"]);
  const narrative = plan.units[1];
  assert.match(narrative.text, /住院经过/);
  assert.match(narrative.text, /出院医嘱/);
  assert.equal(narrative.candidateRowCount, 0);
  assert.ok(plan.narrativeLineCount >= 2);
});

test("plans institution-neutral report layouts from structural evidence", () => {
  const cases = [
    {
      id: "table-lab",
      lines: ["生化检验报告", "项目 | 结果 | 单位 | 参考范围", "葡萄糖 | 5.6 | mmol/L | 3.9~6.1"],
      modeCount: 1
    },
    {
      id: "inline-lab",
      lines: ["血液检验", "WBC 5.2 10^9/L 参考范围 3.5-9.5"],
      modeCount: 1
    },
    {
      id: "categorical-lab",
      lines: ["尿常规", "尿蛋白 阴性"],
      modeCount: 1
    },
    {
      id: "imaging-finding",
      lines: ["甲状腺超声检查", "甲状腺左叶见低回声结节，大小约 6×4 mm"],
      modeCount: 2
    }
  ];
  for (const item of cases) {
    const plan = planRebuiltOcrPages(item.id, rebuildOcrPages([page(1, item.lines)]));
    assert.equal(plan.units[0].allowDocumentFields, true, item.id);
    assert.equal(plan.unitCount, item.modeCount, item.id);
    assert.ok(plan.candidateRowCount >= 1, item.id);
  }
});

test("does not send health education prose as indicator candidates", () => {
  const plan = planRebuiltOcrPages("education-report", rebuildOcrPages([
    page(1, [
      "检验报告单",
      "项目 | 结果 | 单位 | 参考范围",
      "总胆固醇 | 4.8 | mmol/L | <5.2"
    ]),
    page(2, [
      "专家健康宣教",
      "总胆固醇超过 5.2 mmol/L 时应关注生活方式，建议结合医生意见复查。"
    ])
  ]));
  assert.equal(plan.unitCount, 1);
  assert.equal(plan.candidateRowCount, 1);
  assert.equal(plan.units[0].candidateFacts.length, 0);
  assert.equal(plan.localObservationCount, 1);
});

test("recognizes bracketed report sections and preserves a dash as the current table result", () => {
  const lines = [
    { text: "【便常规】", box: [0, 0, 100, 10] },
    { text: "项目", box: [0, 20, 30, 30] },
    { text: "本次结果", box: [40, 20, 70, 30] },
    { text: "参考值", box: [80, 20, 110, 30] },
    { text: "白细胞", box: [0, 40, 30, 50] },
    { text: "-", box: [40, 40, 70, 50] },
    { text: "0~5", box: [80, 40, 110, 50] },
    { text: "红细胞", box: [0, 60, 30, 70] },
    { text: "-", box: [40, 60, 70, 70] },
    { text: "0~3", box: [80, 60, 110, 70] },
    { text: "【尿常规15项】", box: [0, 80, 100, 90] },
    { text: "酸碱度 | 6.0 | 5.0~8.0", box: [0, 100, 110, 110] }
  ];
  const rebuilt = rebuildOcrPages([{
    pageId: "page-1",
    pageNumber: 1,
    linesJson: JSON.stringify(lines.map((line, index) => ({
      id: `line-${index + 1}`,
      text: line.text,
      confidence: 0.98,
      box: line.box
    })))
  }]);
  const sent = rebuilt[0].text;
  assert.match(sent, /【便常规】/);
  assert.match(sent, /白细胞\s*\|\s*-\s*\|\s*0~5/);
  assert.match(sent, /红细胞\s*\|\s*-\s*\|\s*0~3/);
  assert.match(sent, /【尿常规15项】/);
  assert.equal(rebuilt[0].lines.find((line) => line.text.includes("白细胞"))?.candidate, true);
  assert.equal(rebuilt[0].lines.find((line) => line.text.includes("酸碱度"))?.candidate, true);
});

test("excludes historical result sections from scalar and morphology candidates", () => {
  const plan = planRebuiltOcrPages("historical-report", rebuildOcrPages([
    page(1, [
      "腹部超声检查报告",
      "中度脂肪肝",
      "【历史检查结果（2025-07-12）】",
      "轻度脂肪肝",
      "总胆固醇 | 5.8 | mmol/L | <5.2"
    ])
  ]));
  const sent = plan.pages[0].text;
  assert.match(sent, /中度脂肪肝/);
  assert.doesNotMatch(sent, /轻度脂肪肝|总胆固醇|2025-07-12/);
  assert.equal(plan.pages[0].morphologyCandidateCount, 1);
  assert.equal(plan.pages[0].candidateRowCount, 1);
});

test("keeps health education continuation pages out of the candidate plan", () => {
  const plan = planRebuiltOcrPages("education-continuation", rebuildOcrPages([
    page(1, [
      "检验报告单",
      "项目 | 结果 | 单位 | 参考范围",
      "总胆固醇 | 4.8 | mmol/L | <5.2"
    ]),
    page(2, [
      "专家健康宣教",
      "总胆固醇超过 5.2 mmol/L 时应关注生活方式。"
    ]),
    page(3, [
      "尿酸和体重管理",
      "尿酸高于 420 μmol/L 时建议咨询医生，体重应保持在合理范围。"
    ])
  ]));
  assert.equal(plan.candidateRowCount, 1);
  assert.equal(plan.pages[1].candidateRowCount, 0);
  assert.equal(plan.pages[2].candidateRowCount, 0);
  assert.equal(plan.pages[2].lines.length, 0);
});

test("includes common ECG vascular tumor-marker and urine microscopy measurements as candidates", () => {
  const plan = planRebuiltOcrPages("functional-report", rebuildOcrPages([
    page(1, [
      "【心电图】",
      "PR间期 | 158 | ms | 120~200",
      "QRS时限 | 92 | ms | 60~110",
      "QTc间期 | 410 | ms | <450"
    ]),
    page(2, [
      "【动脉粥样硬化指数】",
      "右侧ABI | 1.08 | 0.9~1.4",
      "右侧baPWV | 1420 | cm/s | <1400",
      "DOB | 0.42 | 0.1~1.0"
    ]),
    page(3, [
      "【肿瘤标志物】",
      "f-PSA/T-PSA | 22.0 | % | >20"
    ]),
    page(4, [
      "【尿常规】",
      "镜检管型 | 0 | Cast/LP | 0~1"
    ])
  ]));
  const candidates = plan.units.flatMap((unit) => unit.candidateFacts.map((fact) => fact.sourceText));
  for (const name of ["PR间期", "QRS时限", "QTc间期", "右侧ABI", "右侧baPWV", "DOB", "f-PSA/T-PSA", "镜检管型"]) {
    assert.equal(candidates.some((line) => line.includes(name)), true, name);
  }
});

test("excludes instrument settings chart legends and interpretation prose from scalar candidates", () => {
  const plan = planRebuiltOcrPages("technical-noise", rebuildOcrPages([
    page(1, [
      "【心电图】",
      "增益: 10mm/mV 走速: 25mm/s | 窦性心律",
      "心率: 73 bpm",
      "PR间期: 153 ms"
    ]),
    page(2, [
      "13C呼气试验Hp检验报告",
      "试剂名称：13c尿素 | 纯度：99%",
      "指标：DOB值 | 检测值：0.7 | 检验结果：阴性"
    ]),
    page(3, [
      "动脉阻塞与僵硬度检测报告单",
      "右：1315 | 左：1395 | PWV(cm/s)",
      "*baPWV主要检测肢体 | 1000",
      "反映脑血管或心脏 | 800",
      "异常区域 | 正常区域",
      "双侧下肢静态ABI在正常范围",
      "四肢动脉脉搏波形未见异常。"
    ])
  ]));
  const facts = plan.units.flatMap((unit) => unit.candidateFacts.map((fact) => fact.sourceText));
  assert.equal(facts.some((line) => /增益|走速|试剂名称|主要检测|反映脑血管|异常区域|未见异常/.test(line)), false);
  assert.equal(facts.some((line) => line.includes("心率: 73")), true);
  assert.equal(facts.some((line) => line.includes("PR间期: 153")), true);
  assert.equal(facts.some((line) => line.includes("DOB值")), true);
  assert.equal(facts.some((line) => line.includes("右：1315")), true);
});

test("matches only the first table cell against dictionary aliases", () => {
  const rebuilt = rebuildOcrPages([
    page(1, [
      "【血糖】",
      "项目 | 本次结果 | 单位 | 参考范围",
      "糖化血红蛋白 | 5.4 | % | 4.0~6.0"
    ])
  ]);
  const line = rebuilt[0].lines.find((item) => item.text.includes("糖化血红蛋白"));
  assert.ok(line);
  assert.equal(line.dictionaryFacts.some((item) => item.canonicalKey === "cbc_hgb"), false);
});

test("removes repeated page noise while preserving table headers and medical rows", () => {
  const rebuilt = rebuildOcrPages(Array.from({ length: 6 }, (_, index) => page(index + 1, [
    "示例健康体检中心",
    `第 ${index + 1} 页 / 共 6 页`,
    "姓名：张三",
    "报告号：REPORT-100",
    "项目 | 结果 | 单位 | 参考范围",
    `白细胞计数 ${5 + index / 10} 10^9/L 参考范围 3.5-9.5`,
    "本报告仅供临床参考"
  ])));
  const plan = planRebuiltOcrPages("report", rebuilt);
  const sent = plan.pages.map((item) => item.text).join("\n");

  assert.equal((sent.match(/示例健康体检中心/g) || []).length, 1);
  assert.equal((sent.match(/报告号：REPORT-100/g) || []).length, 1);
  assert.equal((sent.match(/项目 \| 结果 \| 单位 \| 参考范围/g) || []).length, 6);
  assert.equal((sent.match(/白细胞计数/g) || []).length, 6);
  assert.doesNotMatch(sent, /张三|本报告仅供临床参考|共 6 页/);
  assert.equal(plan.candidateRowCount, 6);
  assert.ok(plan.repeatedRemovedLineCount >= 10);
  assert.ok(plan.noiseRemovedLineCount >= 6);
  assert.equal(plan.sourceLineCount, 36);
  assert.ok(plan.removedLineCount >= 16);
});

test("keeps the current single-request adapter while exposing the full OCR plan", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ai-plan-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('owner', '管理员');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '本人', 'owner');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('report', 'member', 'owner', 'checkup', '长体检报告', 'processing');
    `);
    const insertPage = db.prepare(`
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, mime_type, storage_path, file_size, sha256
      ) VALUES (?, 'report', ?, ?, 'image/png', ?, 1, ?)
    `);
    const insertJob = db.prepare(`
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, pipeline_version, deduplication_key
      ) VALUES (?, 'report', ?, 'ocr', 'completed', 'test', ?)
    `);
    const insertOcr = db.prepare(`
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json, text_length
      ) VALUES (?, ?, ?, 'test', 'test-v1', ?, ?)
    `);
    for (let index = 1; index <= 12; index += 1) {
      const pageId = `page-${index}`;
      const jobId = `job-${index}`;
      const text = `第${index}页 ${"完整报告内容".repeat(1_200)}`;
      insertPage.run(pageId, index, `${index}.png`, `originals/${index}.png`, `hash-${index}`);
      insertJob.run(jobId, pageId, `ocr-${index}`);
      insertOcr.run(`ocr-${index}`, jobId, pageId, JSON.stringify([{ id: "line-1", text }]), text.length);
    }

    const input = buildAiExtractionInput("report");
    assert.equal(input.pageCount, 12);
    assert.equal(input.plannedUnits, 1);
    assert.ok((input.sourceInputCharacters || 0) > 80_000);
    assert.equal(input.inputCharacters, 80_000);
    assert.equal(input.compatibilityTruncated, true);
    assert.match(input.planHash || "", /^[a-f0-9]{64}$/);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
