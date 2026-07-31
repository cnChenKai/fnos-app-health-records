import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import {
  aiExtractionExecutionPolicy,
  executeAiExtractionPlan,
  mergeAiExtractionResults
} from "../services/ai-extraction-orchestrator.service.ts";
import {
  deduplicateReportMorphologyFindings,
  deduplicateReportObservations,
  normalizeAiExtraction,
  persistAiExtraction,
  aiExtractionPromptVersion,
  type AiExecutor,
  type AiExtractionResult
} from "../services/ai-extraction.service.ts";

async function withReport(
  pageCount: number,
  run: (context: { reportId: string; jobId: string }) => Promise<void>,
  linesForPage?: (pageNumber: number) => string[]
) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-ai-units-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('owner', '管理员');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '本人', 'owner');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('report', 'member', 'owner', 'checkup', '长体检报告', 'processing');
      INSERT INTO processing_jobs (
        id, report_id, job_type, status, pipeline_version, deduplication_key
      ) VALUES ('ai-job', 'report', 'ai_extract', 'processing', 'unit-test', 'ai-job-key');
    `);
    const insertPage = db.prepare(`
      INSERT INTO report_pages (
        id, report_id, page_number, original_name, mime_type, storage_path, file_size, sha256
      ) VALUES (?, 'report', ?, ?, 'image/png', ?, 1, ?)
    `);
    const insertOcrJob = db.prepare(`
      INSERT INTO processing_jobs (
        id, report_id, page_id, job_type, status, pipeline_version, deduplication_key
      ) VALUES (?, 'report', ?, 'ocr', 'completed', 'unit-test', ?)
    `);
    const insertOcr = db.prepare(`
      INSERT INTO ocr_results (
        id, job_id, page_id, engine, model_version, lines_json, text_length
      ) VALUES (?, ?, ?, 'test', 'test-v1', ?, ?)
    `);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const pageId = `page-${pageNumber}`;
      const ocrJobId = `ocr-job-${pageNumber}`;
      const lineTexts = linesForPage?.(pageNumber) || [
        `第${pageNumber}页检查`,
        `指标${pageNumber} ${pageNumber}.2 mmol/L 参考范围 1.0-20.0`,
        `说明${pageNumber} ${"内容".repeat(450)}`
      ];
      const lines = lineTexts.map((text, index) => ({
        id: `${pageId}-line-${index + 1}`, text, confidence: 0.99
      }));
      const linesJson = JSON.stringify(lines);
      insertPage.run(pageId, pageNumber, `${pageNumber}.png`, `reports/${pageNumber}.png`, `hash-${pageNumber}`);
      insertOcrJob.run(ocrJobId, pageId, `ocr-${pageNumber}`);
      insertOcr.run(`ocr-${pageNumber}`, ocrJobId, pageId, linesJson, linesJson.length);
    }
    await run({ reportId: "report", jobId: "ai-job" });
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function resultForInput(text: string, index: number): AiExtractionResult {
  const pages = [...text.matchAll(/\[第 (\d+) 页\]/g)].map((match) => Number(match[1]));
  const normalized = normalizeAiExtraction({
    reportType: "physical_exam",
    title: "年度体检报告",
    hospitalNameRaw: "示例体检中心",
    reportIssuedAt: "2026-07-29",
    summary: `单元${index}摘要`,
    observations: pages.map((pageNumber) => ({
      sectionName: "一般检查",
      itemName: `指标${pageNumber}`,
      resultText: `${pageNumber}.2`,
      numericValue: pageNumber + 0.2,
      unit: "mmol/L",
      referenceLow: 1,
      referenceHigh: 20,
      evidence: [{ pageNumber, quote: `指标${pageNumber} ${pageNumber}.2 mmol/L` }]
    }))
  });
  return {
    provider: "test-provider",
    model: "test-model",
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify(normalized),
    promptTokens: 100,
    completionTokens: 20,
    elapsedMs: 10
  };
}

test("processes a long report as multiple persisted units and merges every page", async () => {
  await withReport(10, async ({ reportId, jobId }) => {
    getDatabase().prepare(`
      INSERT INTO observations (id, report_id, item_name, result_text)
      VALUES ('old-observation', ?, '旧指标', '旧结果')
    `).run(reportId);
    let calls = 0;
    const executor: AiExecutor = async (input) => resultForInput(input.text, ++calls);
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);

    assert.ok(execution.plan.unitCount >= 2);
    assert.equal(calls, execution.plan.unitCount);
    assert.equal(execution.result.fields.observations.length, 10);
    assert.equal(execution.result.promptTokens, execution.plan.unitCount * 100);
    assert.equal(execution.result.fields.summary, "单元1摘要");
    assert.equal((getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM observations WHERE id = 'old-observation'
    `).get() as { count: number }).count, 1);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    assert.equal((getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM observations WHERE id = 'old-observation'
    `).get() as { count: number }).count, 0);
    assert.equal((getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM observations WHERE report_id = ?
    `).get(reportId) as { count: number }).count, 10);
    const counts = getDatabase().prepare(`
      SELECT COUNT(*) AS total, SUM(status = 'completed') AS completed
      FROM ai_extraction_units WHERE job_id = ?
    `).get(jobId) as { total: number; completed: number };
    assert.equal(counts.total, execution.plan.unitCount);
    assert.equal(counts.completed, execution.plan.unitCount);
  });
});

test("keeps document title and type anchored to the first scalar unit", async () => {
  await withReport(7, async ({ reportId, jobId }) => {
    const permissions: boolean[] = [];
    const executor: AiExecutor = async (input) => {
      permissions.push(Boolean(input.allowDocumentFields));
      const isFirstUnit = input.pageNumbers?.includes(1);
      const normalized = normalizeAiExtraction({
        reportType: isFirstUnit ? "physical_exam" : "functional",
        title: isFirstUnit ? "综合健康体检报告" : "动脉阻塞与僵硬度检测报告",
        hospitalNameRaw: isFirstUnit ? "示例体检中心" : "专项检查机构",
        observations: []
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(permissions[0], true);
    assert.equal(permissions.slice(1).every((allowed) => !allowed), true);
    assert.equal(execution.result.fields.reportType, "checkup");
    assert.equal(execution.result.fields.title, "综合健康体检报告");
    assert.equal(execution.result.fields.hospitalNameRaw, "示例体检中心");
  }, (pageNumber) => [
    pageNumber === 1 ? "个人健康体检报告" : `第${pageNumber}页专项检查`,
    `指标${pageNumber} ${pageNumber}.2 mmol/L 参考范围 1.0-20.0`
  ]);
});

test("keeps full document field extraction for a single-page laboratory report", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let receivedAllowDocumentFields = false;
    const executor: AiExecutor = async (input) => {
      receivedAllowDocumentFields = Boolean(input.allowDocumentFields);
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        title: "血常规检验报告",
        hospitalNameRaw: "示例医院",
        reportIssuedAt: "2026-07-30 08:30:00",
        observations: [{
          sectionName: "血常规",
          itemName: "白细胞计数",
          resultText: "5.0",
          numericValue: 5,
          unit: "10^9/L",
          referenceLow: 3.5,
          referenceHigh: 9.5,
          evidence: [{ pageNumber: 1, quote: "白细胞计数 | 5.0 | 10^9/L | 3.5-9.5" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(receivedAllowDocumentFields, true);
    assert.equal(execution.result.fields.reportType, "laboratory");
    assert.equal(execution.result.fields.title, "血常规检验报告");
    assert.equal(execution.result.fields.hospitalNameRaw, "示例医院");
    assert.equal(execution.result.fields.observations.length, 1);
  }, () => [
    "血常规检验报告",
    "项目 | 结果 | 单位 | 参考范围",
    "白细胞计数 | 5.0 | 10^9/L | 3.5-9.5"
  ]);
});

test("fills the nearest section and ignores abnormal markers from historical result columns", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [{
          itemName: "低密度脂蛋白胆固醇",
          resultText: "3.04",
          numericValue: 3.04,
          unit: "mmol/L",
          referenceHigh: 3.37,
          abnormalFlag: "high",
          evidence: [{
            pageNumber: 1,
            quote: "低密度脂蛋白胆固醇 | 3.04 | mmol/L | <3.37 | 3.52↑"
          }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const observation = execution.result.fields.observations[0];
    assert.equal(observation.sectionName, "血脂");
    assert.equal(observation.abnormalFlag, null);
  }, () => [
    "血脂",
    "项目 | 本次结果 | 单位 | 参考范围 | 历史结果",
    "低密度脂蛋白胆固醇 | 3.04 | mmol/L | <3.37 | 3.52↑"
  ]);
});

test("keeps a dash as the current stool result instead of using the reference range", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [{
          itemName: "白细胞",
          resultText: "0~5",
          numericValue: 0,
          referenceLow: 0,
          referenceHigh: 5,
          evidence: [{ pageNumber: 1, quote: "白细胞 | - | 0~5" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const observation = execution.result.fields.observations[0];
    assert.equal(observation.sectionName, "便常规");
    assert.equal(observation.resultText, "-");
    assert.equal(observation.numericValue, null);
    assert.equal(observation.unit, null);
    assert.equal(observation.referenceLow, 0);
    assert.equal(observation.referenceHigh, 5);
  }, () => [
    "【便常规】",
    "项目 | 本次结果 | 参考值",
    "白细胞 | - | 0~5"
  ]);
});

test("corrects a historical numeric value to the table's current-result cell", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        observations: [{
          sectionName: "血常规",
          itemName: "体重指数BMI",
          resultText: "24.8",
          numericValue: 24.8,
          referenceLow: 18.5,
          referenceHigh: 23.9,
          abnormalFlag: "high",
          evidence: [{
            pageNumber: 1,
            quote: "体重指数BMI | 24.9 ↑ | 18.5~23.9 | 24.8 ↑"
          }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const observation = execution.result.fields.observations[0];
    assert.equal(observation.sectionName, "一般检查");
    assert.equal(observation.resultText, "24.9 ↑");
    assert.equal(observation.numericValue, 24.9);
    assert.equal(observation.abnormalFlag, "high");
  }, () => [
    "【一般检查】",
    "项目 | 本次结果 | 参考值 | 历史结果",
    "体重指数BMI | 24.9 ↑ | 18.5~23.9 | 24.8 ↑"
  ]);
});

test("inherits a urine section across page boundaries", async () => {
  await withReport(2, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [{
          itemName: "镜检白细胞",
          resultText: "2",
          numericValue: 2,
          unit: "Cell/HP",
          evidence: [{ pageNumber: 2, quote: "镜检白细胞 | 2 | Cell/HP | 0~5" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.match(execution.result.fields.observations[0].sectionName || "", /尿常规/);
  }, (pageNumber) => pageNumber === 1 ? [
    "【尿常规15项】",
    "项目 | 本次结果 | 单位 | 参考值",
    "尿蛋白 | 阴性 | | 阴性"
  ] : [
    "镜检白细胞 | 2 | Cell/HP | 0~5"
  ]);
});

test("merges summary and detailed morphology for the same lesion while preserving distinct sizes", () => {
  const base = {
    sectionName: "超声检查",
    region: null,
    laterality: "right" as const,
    findingType: "斑块",
    findingName: "右侧锁骨下动脉斑块",
    presence: "present" as const,
    findingCount: 1,
    measurements: [],
    morphology: null,
    attributes: {},
    classification: null,
    comparisonText: null,
    confidence: 0.9
  };
  const merged = deduplicateReportMorphologyFindings([
    {
      ...base,
      region: "右侧",
      organ: "subclavian_artery",
      size: { length: null, width: null, height: null, unit: null },
      rawText: "右侧锁骨下动脉斑块",
      evidence: [{ pageNumber: 2, quote: "右侧锁骨下动脉斑块" }]
    },
    {
      ...base,
      region: "颈部",
      organ: "右侧锁骨下动脉",
      size: { length: 8, width: 2, height: null, unit: "mm" },
      morphology: "低回声斑块",
      rawText: "右侧锁骨下动脉起始段见 8×2 mm 低回声斑块",
      evidence: [{ pageNumber: 15, quote: "右侧锁骨下动脉起始段见 8×2 mm 低回声斑块" }]
    },
    {
      ...base,
      region: "颈部",
      organ: "右侧锁骨下动脉",
      size: { length: 4, width: 2, height: null, unit: "mm" },
      rawText: "右侧锁骨下动脉另见 4×2 mm 斑块",
      evidence: [{ pageNumber: 15, quote: "右侧锁骨下动脉另见 4×2 mm 斑块" }]
    }
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].organ, "锁骨下动脉");
  assert.equal(merged[0].size.length, 8);
  assert.deepEqual(merged[0].evidence.map((item) => item.pageNumber), [2, 15]);
});

test("prefers final-review and examination dates from OCR when persisting a checkup", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const normalized = normalizeAiExtraction({
      reportType: "physical_exam",
      title: "综合体检报告",
      reportIssuedAt: "2026-06-14",
      observations: []
    });
    persistAiExtraction(reportId, jobId, {
      provider: "test",
      model: "test",
      promptVersion: "test",
      ...normalized,
      rawResponseJson: "{}",
      promptTokens: 10,
      completionTokens: 5,
      elapsedMs: 1
    }, 100);
    const report = getDatabase().prepare(`
      SELECT report_issued_at AS reportIssuedAt, examined_at AS examinedAt
      FROM reports WHERE id = ?
    `).get(reportId) as { reportIssuedAt: string; examinedAt: string };
    assert.equal(report.reportIssuedAt, "2026-06-15 10:24:00");
    assert.equal(report.examinedAt, "2026-06-14");
  }, () => [
    "健康体检报告",
    "体检日期：2026年06月14日",
    "终检时间：2026-06-15 10:24"
  ]);
});

test("processes 24 pages and 200 dense indicators end to end without a real provider", async () => {
  await withReport(24, async ({ reportId, jobId }) => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const lines = input.text.split("\n").filter((line) => /^指标\d+-\d+\s/.test(line));
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        title: "高密度综合体检报告",
        reportIssuedAt: "2026-07-29",
        observations: lines.map((line) => {
          const match = line.match(/^(指标\d+-\d+)\s+(\d+(?:\.\d+)?)\s+mmol\/L/);
          assert.ok(match);
          const pageNumber = Number(match[1].split("-")[0].replace("指标", ""));
          return {
            sectionName: "检验检查",
            itemName: match[1],
            resultText: match[2],
            numericValue: Number(match[2]),
            unit: "mmol/L",
            referenceLow: 1,
            referenceHigh: 200,
            evidence: [{ pageNumber, quote: line }]
          };
        })
      });
      return {
        provider: "test-provider",
        model: "test-model",
        promptVersion: "health-record-unit-v3",
        ...normalized,
        rawResponseJson: JSON.stringify(normalized),
        promptTokens: input.inputCharacters,
        completionTokens: lines.length * 40,
        elapsedMs: 5
      };
    };

    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.plan.pageCount, 24);
    assert.equal(execution.plan.unitCount, 5);
    assert.equal(calls, 5);
    assert.equal(maximumActive, 3);
    assert.equal(execution.result.fields.observations.length, 200);
    assert.equal(execution.unmatchedCandidates, 0);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const stored = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM observations WHERE report_id = ?
    `).get(reportId) as { count: number };
    assert.equal(stored.count, 200);
  }, (pageNumber) => {
    const count = pageNumber <= 8 ? 9 : 8;
    return [
      "项目 | 结果 | 单位 | 参考范围",
      ...Array.from({ length: count }, (_, index) =>
        `指标${pageNumber}-${index + 1} ${index + 1}.2 mmol/L 参考范围 1.0-200.0`
      )
    ];
  });
});

test("resumes a concurrently processed extraction without calling completed units again", async () => {
  await withReport(18, async ({ reportId, jobId }) => {
    let calls = 0;
    let failOnce = true;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      if (failOnce && calls === 2) {
        failOnce = false;
        throw Object.assign(new Error("临时网络失败"), { code: "AI_NETWORK_ERROR" });
      }
      return resultForInput(input.text, calls);
    };

    await assert.rejects(() => executeAiExtractionPlan(jobId, reportId, executor), /临时网络失败/);
    const completedBeforeRetry = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM ai_extraction_units WHERE job_id = ? AND status = 'completed'
    `).get(jobId) as { count: number };
    assert.ok(completedBeforeRetry.count >= 1);

    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(calls, execution.plan.unitCount + 1);
    assert.equal(execution.result.fields.observations.length, 18);
    const attempts = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM ai_extraction_attempts WHERE job_id = ?
    `).get(jobId) as { count: number };
    assert.equal(attempts.count, execution.plan.unitCount + 1);
  });
});

test("runs at most three AI extraction units concurrently", async () => {
  await withReport(25, async ({ reportId, jobId }) => {
    let active = 0;
    let maximumActive = 0;
    const executor: AiExecutor = async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return resultForInput(input.text, maximumActive);
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(maximumActive, aiExtractionExecutionPolicy.maxConcurrency);
    assert.equal(execution.result.fields.observations.length, 25);
  });
});

test("merges duplicate indicator variants that resolve to the same OCR source row", async () => {
  await withReport(9, async ({ reportId, jobId }) => {
    let calls = 0;
    let scalarCalls = 0;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      if (input.route !== "scalar") {
        const normalized = normalizeAiExtraction({ reportType: "laboratory" });
        return {
          provider: "test", model: "test", promptVersion: "test", ...normalized,
          rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
        };
      }
      scalarCalls += 1;
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [{
          sectionName: "血常规",
          itemName: scalarCalls === 1 ? "白细胞数目(WBC)" : "白细胞数目",
          resultText: scalarCalls === 1 ? "5.00" : "5",
          numericValue: 5,
          unit: "10^9/L",
          referenceLow: scalarCalls === 1 ? 3.5 : null,
          referenceHigh: scalarCalls === 1 ? 9.5 : null,
          evidence: [{ pageNumber: 1, quote: "指标1 1.2 mmol/L 参考范围 1.0-20.0" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(calls, execution.plan.unitCount);
    assert.equal(execution.result.fields.observations.length, 1);
    assert.equal(execution.result.fields.observations[0].referenceLow, 3.5);
    assert.equal(execution.result.fields.observations[0].referenceHigh, 9.5);
  }, (pageNumber) => [
    pageNumber === 1
      ? "指标1 1.2 mmol/L 参考范围 1.0-20.0"
      : `第${pageNumber}页普通说明`
  ]);
});

test("deduplicates the same normalized indicator across report pages before persistence", async () => {
  await withReport(9, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async (input) => {
      const pageNumber = input.text.includes("白细胞数目(WBC)") ? 1 : 9;
      const itemName = pageNumber === 1 ? "白细胞数目(WBC)" : "白细胞数目";
      const resultText = pageNumber === 1 ? "5.0" : "5.00";
      const quote = `${itemName} ${resultText} 10^9/L 参考范围 3.5-9.5`;
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [{
          sectionName: "血常规",
          itemName,
          resultText,
          numericValue: 5,
          unit: "10^9/L",
          referenceLow: pageNumber === 1 ? null : 3.5,
          referenceHigh: pageNumber === 1 ? null : 9.5,
          evidence: [{ pageNumber, quote }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.observations.length, 2);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);

    const stored = getDatabase().prepare(`
      SELECT item_name AS itemName, numeric_value AS numericValue,
        reference_low AS referenceLow, reference_high AS referenceHigh,
        evidence_json AS evidenceJson
      FROM observations WHERE report_id = ?
    `).all(reportId) as Array<{
      itemName: string;
      numericValue: number;
      referenceLow: number | null;
      referenceHigh: number | null;
      evidenceJson: string;
    }>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].numericValue, 5);
    assert.equal(stored[0].referenceLow, 3.5);
    assert.equal(stored[0].referenceHigh, 9.5);
    assert.deepEqual(
      (JSON.parse(stored[0].evidenceJson) as Array<{ pageNumber: number }>).map((item) => item.pageNumber),
      [1, 9]
    );
  }, (pageNumber) => [
    pageNumber === 1
      ? "白细胞数目(WBC) 5.0 10^9/L 参考范围 3.5-9.5"
      : pageNumber === 9
        ? "白细胞数目 5.00 10^9/L 参考范围 3.5-9.5"
        : `第${pageNumber}页普通说明`
  ]);
});

test("does not merge same-valued indicators when explicit methods conflict", async () => {
  await withReport(1, async ({ reportId }) => {
    const base = {
      sectionName: "检验检查",
      itemCode: null,
      itemName: "空腹血糖",
      normalizedName: null,
      resultText: "5.2",
      numericValue: 5.2,
      unit: "mmol/L",
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      abnormalFlag: null,
      evidence: [{ pageNumber: 1, quote: "空腹血糖 5.2 mmol/L" }]
    };
    const deduplicated = deduplicateReportObservations(reportId, [
      { ...base, method: "己糖激酶法" },
      { ...base, method: "葡萄糖氧化酶法" }
    ]);
    assert.equal(deduplicated.length, 2);
  });
});

test("keeps distinct indicators from the same OCR source row while removing cross-unit repeats", async () => {
  await withReport(9, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        observations: [
          {
            sectionName: "一般检查", itemName: "收缩压", resultText: "120",
            numericValue: 120, unit: "mmHg",
            evidence: [{ pageNumber: 1, quote: "血压 120/80 mmHg" }]
          },
          {
            sectionName: "一般检查", itemName: "舒张压", resultText: "80",
            numericValue: 80, unit: "mmHg",
            evidence: [{ pageNumber: 1, quote: "血压 120/80 mmHg" }]
          }
        ]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(
      execution.result.fields.observations.map((item) => item.itemName).sort(),
      ["收缩压", "舒张压"]
    );
  }, (pageNumber) => [
    pageNumber === 1 ? "血压 120/80 mmHg" : `第${pageNumber}页普通说明`
  ]);
});

test("retries invalid JSON once with strict JSON mode", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const modes: Array<string | undefined> = [];
    const executor: AiExecutor = async (input) => {
      modes.push(input.promptMode);
      if (modes.length === 1) {
        throw Object.assign(new Error("AI 返回内容不是有效 JSON"), { code: "AI_INVALID_JSON" });
      }
      return resultForInput(input.text, modes.length);
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(modes, ["standard", "json_retry"]);
    assert.equal(execution.result.fields.observations.length, 1);
    const attempts = getDatabase().prepare(`
      SELECT attempt_type AS attemptType, status FROM ai_extraction_attempts
      WHERE job_id = ? ORDER BY created_at, id
    `).all(jobId) as Array<{ attemptType: string; status: string }>;
    assert.deepEqual(attempts.map((item) => item.attemptType).sort(), ["format_retry", "main"]);
    assert.deepEqual(attempts.map((item) => item.status).sort(), ["completed", "failed"]);
  });
});

test("persists provider token usage when a unit output is truncated", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      throw Object.assign(new Error("AI 输出达到模型长度上限，当前解析单元需要缩小"), {
        code: "AI_OUTPUT_TRUNCATED",
        provider: "provider.example",
        model: "model-with-limit",
        promptTokens: 1800,
        completionTokens: 8192,
        elapsedMs: 65000
      });
    };
    await assert.rejects(
      () => executeAiExtractionPlan(jobId, reportId, executor),
      /输出达到模型长度上限/
    );
    const attempt = getDatabase().prepare(`
      SELECT provider, model, prompt_tokens AS promptTokens,
        completion_tokens AS completionTokens, elapsed_ms AS elapsedMs, error_code AS errorCode
      FROM ai_extraction_attempts WHERE job_id = ?
    `).get(jobId) as {
      provider: string; model: string; promptTokens: number;
      completionTokens: number; elapsedMs: number; errorCode: string;
    };
    assert.deepEqual({ ...attempt }, {
      provider: "provider.example",
      model: "model-with-limit",
      promptTokens: 1800,
      completionTokens: 8192,
      elapsedMs: 65000,
      errorCode: "AI_OUTPUT_TRUNCATED"
    });
  });
});

test("raises the output budget before splitting a truncated unit", async () => {
  await withReport(2, async ({ reportId, jobId }) => {
    const scales: number[] = [];
    const executor: AiExecutor = async (input) => {
      if (input.route !== "scalar") return resultForInput(input.text, 0);
      scales.push(input.outputTokenScale || 1);
      if (scales.length === 1) {
        throw Object.assign(new Error("AI 输出达到当前预算"), {
          code: "AI_OUTPUT_TRUNCATED",
          requestedMaxTokens: 16_384,
          modelMaxOutputTokens: 384_000
        });
      }
      return resultForInput(input.text, scales.length);
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(scales, [1, 2]);
    assert.equal(execution.result.fields.observations.length, 2);
  });
});

test("splits only the current unit when a larger output budget is still truncated", async () => {
  await withReport(2, async ({ reportId, jobId }) => {
    const calls: Array<{ pages: number; scale: number }> = [];
    const executor: AiExecutor = async (input) => {
      if (input.route !== "scalar") return resultForInput(input.text, 0);
      calls.push({ pages: input.pageCount, scale: input.outputTokenScale || 1 });
      if (input.pageCount > 1) {
        throw Object.assign(new Error("AI 输出达到当前预算"), {
          code: "AI_OUTPUT_TRUNCATED",
          requestedMaxTokens: input.outputTokenScale === 2 ? 32_768 : 16_384,
          modelMaxOutputTokens: 384_000
        });
      }
      return resultForInput(input.text, calls.length);
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(calls.slice(0, 2), [{ pages: 2, scale: 1 }, { pages: 2, scale: 2 }]);
    assert.equal(calls.filter((item) => item.pages === 1).length, 2);
    assert.equal(execution.result.fields.observations.length, 2);
    const splitUnits = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM ai_extraction_units
      WHERE job_id = ? AND unit_type = 'page_chunk' AND status = 'completed'
    `).get(jobId) as { count: number };
    assert.equal(splitUnits.count, 2);
  });
});

test("merges unit results without dropping observations above the old response limit", () => {
  const results = Array.from({ length: 3 }, (_, resultIndex) => {
    const normalized = normalizeAiExtraction({
      observations: Array.from({ length: 250 }, (_, itemIndex) => ({
        itemName: `指标-${resultIndex}-${itemIndex}`,
        resultText: String(itemIndex),
        numericValue: itemIndex,
        evidence: [{ pageNumber: resultIndex + 1, quote: `指标-${resultIndex}-${itemIndex}` }]
      }))
    });
    return {
      provider: "test", model: "test", promptVersion: "test", ...normalized,
      rawResponseJson: "{}", promptTokens: null, completionTokens: null, elapsedMs: 1
    } satisfies AiExtractionResult;
  });
  assert.equal(mergeAiExtractionResults(results).fields.observations.length, 750);
});

test("accepts the compact observation output used to reduce completion tokens", () => {
  const normalized = normalizeAiExtraction({
    reportType: "laboratory",
    observations: [{
      s: "血常规", c: "WBC", n: "白细胞数目(WBC)", r: "5.0",
      v: 5, u: "10^9/L", lo: 3.5, hi: 9.5, f: "normal",
      p: 3, q: "白细胞数目(WBC) 5.0 10^9/L 3.5-9.5"
    }]
  });
  assert.deepEqual(normalized.fields.observations[0], {
    sectionName: "血常规",
    itemCode: "WBC",
    itemName: "白细胞数目(WBC)",
    normalizedName: null,
    resultText: "5.0",
    numericValue: 5,
    unit: "10^9/L",
    referenceLow: 3.5,
    referenceHigh: 9.5,
    referenceText: null,
    abnormalFlag: "normal",
    method: null,
    evidence: [{ pageNumber: 3, quote: "白细胞数目(WBC) 5.0 10^9/L 3.5-9.5" }]
  });
});

test("accepts only known nonempty report sections with compact evidence", () => {
  const normalized = normalizeAiExtraction({
    reportSections: [
      {
        sectionKey: "pathology_immunohistochemistry",
        title: "免疫组化",
        content: "Ki-67 约5%",
        p: 2,
        q: "免疫组化：Ki-67 约5%"
      },
      {
        sectionKey: "unknown_section",
        title: "未知",
        content: "不应保留",
        p: 2,
        q: "未知：不应保留"
      },
      {
        sectionKey: "pathology_stage",
        title: "病理分期",
        content: ""
      }
    ]
  });
  assert.deepEqual(normalized.fields.reportSections, [{
    sectionKey: "pathology_immunohistochemistry",
    title: "免疫组化",
    content: "Ki-67 约5%",
    evidence: [{ pageNumber: 2, quote: "免疫组化：Ki-67 约5%" }]
  }]);
});

test("fills explicit basic measurements locally before omission supplements", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let calls = 0;
    const executor: AiExecutor = async () => {
      calls += 1;
      const normalized = normalizeAiExtraction({ reportType: "physical_exam", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const values = Object.fromEntries(execution.result.fields.observations.map((item) => [item.itemName, item.numericValue]));
    assert.deepEqual(values, {
      身高: 170,
      体重: 65,
      体重指数: 22.5,
      腰围: 80,
      臀围: 92,
      脉搏: 72,
      收缩压: 120,
      舒张压: 80
    });
    assert.equal(calls, 1);
    assert.equal(execution.unmatchedCandidates, 0);
  }, () => [
    "一般检查",
    "身高 170 cm | 体重 65 kg | BMI 22.5 kg/m2",
    "腰围 80 cm | 臀围 92 cm | 脉搏 72 bpm | 血压 120/80 mmHg"
  ]);
});

test("does not treat a BMI-only line as a body-weight measurement", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({ reportType: "physical_exam", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(execution.result.fields.observations.map((item) => ({
      itemName: item.itemName,
      numericValue: item.numericValue,
      unit: item.unit
    })), [{
      itemName: "体重指数",
      numericValue: 24.9,
      unit: "kg/m2"
    }]);
  }, () => [
    "一般检查",
    "体重指数 24.9 kg/m2"
  ]);
});

test("restores the full BMI item name and unit from table evidence", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "physical_exam",
        observations: [{
          itemName: "体重",
          normalizedName: "体重",
          resultText: "24.9",
          numericValue: 24.9,
          unit: "kg",
          evidence: [{
            pageNumber: 1,
            quote: "体重指数BMI | 24.9 kg/m2 | 18.5~23.9"
          }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.result.fields.observations.length, 1);
    assert.equal(execution.result.fields.observations[0].itemName, "体重指数BMI");
    assert.equal(execution.result.fields.observations[0].normalizedName, "体重指数");
    assert.equal(execution.result.fields.observations[0].numericValue, 24.9);
    assert.equal(execution.result.fields.observations.some((item) => item.itemName === "体重"), false);
  }, () => [
    "【一般检查】",
    "项目 | 本次结果 | 参考值",
    "体重指数BMI | 24.9 kg/m2 | 18.5~23.9"
  ]);
});

test("fills bilateral ABI and baPWV locally and removes a generic value from the same evidence", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let calls = 0;
    const executor: AiExecutor = async () => {
      calls += 1;
      const normalized = normalizeAiExtraction({
        reportType: "functional",
        observations: [{
          itemName: "肱踝脉搏波传导速度",
          resultText: "1315",
          numericValue: 1315,
          unit: "cm/s",
          evidence: [{ pageNumber: 1, quote: "右：1315 | 左：1395 | PWV(cm/s)" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    const values = Object.fromEntries(execution.result.fields.observations.map((item) => [item.itemName, item.numericValue]));
    assert.deepEqual(values, {
      右侧肱踝脉搏波传导速度: 1315,
      左侧肱踝脉搏波传导速度: 1395,
      右侧踝肱指数: 1.07,
      左侧踝肱指数: 1.08
    });
    assert.equal(calls, 1);
    assert.equal(execution.unmatchedCandidates, 0);
  }, () => [
    "动脉阻塞与僵硬度检测报告单",
    "您的动脉硬化吗（baPWV）？",
    "右：1315 | 左：1395 | PWV(cm/s)",
    "您的动脉阻塞吗（ABI）？",
    "右踝：1.07 | 左踝：1.08"
  ]);
});

test("supplements only unmatched candidate rows once per page", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const modes: Array<string | undefined> = [];
    const executor: AiExecutor = async (input) => {
      modes.push(input.promptMode);
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: input.promptMode === "supplement" ? [{
          itemName: "总胆固醇", resultText: "5.3", numericValue: 5.3, unit: "mmol/L",
          referenceLow: 0, referenceHigh: 5.2,
          evidence: [{ pageNumber: 1, quote: "总胆固醇 5.3 mmol/L 参考范围 0-5.2" }]
        }] : []
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(modes, ["standard", "supplement"]);
    assert.equal(execution.result.fields.observations[0]?.itemName, "总胆固醇");
    assert.equal(execution.unmatchedCandidates, 0);
    const unitTypes = getDatabase().prepare(`
      SELECT unit_type AS unitType FROM ai_extraction_units WHERE job_id = ? ORDER BY unit_index
    `).all(jobId) as Array<{ unitType: string }>;
    assert.deepEqual(unitTypes.map((item) => item.unitType), ["complete_pages", "supplement"]);
  }, () => ["血脂", "总胆固醇 5.3 mmol/L 参考范围 0-5.2"]);
});

test("processes every omission candidate when one page contains more than thirty rows", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let supplementCalls = 0;
    const executor: AiExecutor = async (input) => {
      if (input.promptMode === "supplement") supplementCalls += 1;
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: input.promptMode === "supplement"
          ? (input.candidateFacts || []).map((fact) => {
            const match = fact.sourceText.match(/^(专项指标\d+)\s+(\d+(?:\.\d+)?)\s+U\/L/);
            assert.ok(match);
            return {
              itemName: match[1],
              resultText: match[2],
              numericValue: Number(match[2]),
              unit: "U/L",
              evidence: [{ pageNumber: fact.pageNumber, quote: fact.sourceText }]
            };
          })
          : []
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.ok(supplementCalls >= 2);
    assert.equal(execution.result.fields.observations.length, 65);
    assert.equal(execution.unmatchedCandidates, 0);
  }, () => [
    "【检验检查】",
    "项目 | 本次结果 | 单位 | 参考值",
    ...Array.from({ length: 65 }, (_, index) =>
      `专项指标${index + 1} ${index + 1}.2 U/L 参考范围 0~100`
    )
  ]);
});

test("finishes with a warning when an omission supplement still cannot be parsed", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async (input) => {
      if (input.promptMode === "supplement") {
        throw Object.assign(new Error("补提取失败"), { code: "AI_NETWORK_ERROR" });
      }
      const normalized = normalizeAiExtraction({ reportType: "laboratory", observations: [] });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(execution.warningUnits, 1);
    assert.equal(execution.unmatchedCandidates, 1);
    assert.equal(execution.result.fields.observations.length, 0);
  }, () => ["血脂", "总胆固醇 5.3 mmol/L 参考范围 0-5.2"]);
});

test("rejects fabricated observations and canonicalizes valid evidence to the OCR line", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const executor: AiExecutor = async () => {
      const normalized = normalizeAiExtraction({
        reportType: "laboratory",
        observations: [
          {
            itemName: "总胆固醇", resultText: "5.3", numericValue: 5.3, unit: "mmol/L",
            evidence: [{ pageNumber: 1, quote: "总胆固醇 5.3" }]
          },
          {
            itemName: "不存在指标", resultText: "99", numericValue: 99, unit: "mmol/L",
            evidence: [{ pageNumber: 1, quote: "不存在指标 99 mmol/L" }]
          }
        ]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(execution.result.fields.observations.map((item) => item.itemName), ["总胆固醇"]);
    assert.equal(
      execution.result.fields.observations[0].evidence[0].quote,
      "总胆固醇 5.3 mmol/L 参考范围 0-5.2"
    );
    assert.equal(execution.result.evidenceValidation?.rejectedObservations, 1);
    assert.equal(execution.warningUnits, 1);
  }, () => ["血脂", "总胆固醇 5.3 mmol/L 参考范围 0-5.2"]);
});

test("passes dictionary facts and keeps scalar and morphology output in separate calls", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    const calls: Array<{ mode: string | undefined; candidates: number }> = [];
    const executor: AiExecutor = async (input) => {
      calls.push({ mode: input.extractionMode, candidates: input.candidateFacts?.length || 0 });
      const normalized = normalizeAiExtraction(input.extractionMode === "morphology" ? {
        morphologyFindings: [{
          sectionName: "超声检查",
          organ: "右肾",
          findingType: "囊肿",
          findingName: "右肾囊肿",
          presence: "present",
          rawText: "右肾见囊肿，大小约 8×6 mm",
          evidence: [{ pageNumber: 1, quote: "右肾见囊肿，大小约 8×6 mm" }]
        }],
        observations: [{
          itemName: "错误注入指标", resultText: "1",
          evidence: [{ pageNumber: 1, quote: "右肾见囊肿，大小约 8×6 mm" }]
        }]
      } : {
        observations: [{
          itemName: "总胆固醇", resultText: "5.3", numericValue: 5.3, unit: "mmol/L",
          evidence: [{ pageNumber: 1, quote: "总胆固醇 5.3 mmol/L 参考范围 0-5.2" }]
        }],
        morphologyFindings: [{
          findingType: "错误形态", findingName: "错误形态",
          rawText: "总胆固醇 5.3 mmol/L 参考范围 0-5.2",
          evidence: [{ pageNumber: 1, quote: "总胆固醇 5.3 mmol/L 参考范围 0-5.2" }]
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.deepEqual(calls.map((call) => call.mode), ["scalar", "morphology"]);
    assert.ok(calls.every((call) => call.candidates > 0));
    assert.deepEqual(execution.result.fields.observations.map((item) => item.itemName), ["总胆固醇"]);
    assert.deepEqual(execution.result.fields.morphologyFindings.map((item) => item.findingName), ["右肾囊肿"]);
    assert.equal(execution.result.evidenceValidation?.rejectedObservations, 1);
    assert.equal(execution.result.evidenceValidation?.rejectedMorphologyFindings, 0);
  }, () => [
    "血脂",
    "总胆固醇 5.3 mmol/L 参考范围 0-5.2",
    "超声检查",
    "右肾见囊肿，大小约 8×6 mm"
  ]);
});

test("routes and persists prescription facts without a separate classification request", async () => {
  await withReport(1, async ({ reportId, jobId }) => {
    let calls = 0;
    const executor: AiExecutor = async (input) => {
      calls += 1;
      assert.equal(input.primaryContentType, "prescription");
      assert.deepEqual(input.contentTypes, ["prescription"]);
      assert.equal(input.documentContentType, "prescription");
      const normalized = normalizeAiExtraction({
        reportType: "prescription",
        title: "门诊处方笺",
        medications: [{
          context: "prescription",
          medicationName: "阿莫西林胶囊",
          specification: "0.25g",
          dose: "0.5",
          doseUnit: "g",
          frequency: "每日3次",
          route: "口服",
          quantity: "24",
          quantityUnit: "粒",
          p: 1,
          q: "阿莫西林胶囊 | 0.25g | 每次0.5g | 每日3次 | 口服 | 24粒"
        }]
      });
      return {
        provider: "test", model: "test", promptVersion: "test", ...normalized,
        rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
      };
    };
    const execution = await executeAiExtractionPlan(jobId, reportId, executor);
    assert.equal(calls, 2);
    assert.equal(execution.result.fields.medications.length, 1);
    persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
    const medication = getDatabase().prepare(`
      SELECT medication_name AS medicationName, frequency, route
      FROM report_medications WHERE report_id = ?
    `).get(reportId) as { medicationName: string; frequency: string; route: string };
    assert.deepEqual({ ...medication }, {
      medicationName: "阿莫西林胶囊",
      frequency: "每日3次",
      route: "口服"
    });
    const route = getDatabase().prepare(`
      SELECT r.primary_content_type AS primaryType, r.document_content_type AS documentType
      FROM ai_extraction_unit_routes r
      JOIN ai_extraction_units u ON u.id = r.unit_id
      WHERE u.job_id = ?
    `).get(jobId) as { primaryType: string; documentType: string };
    assert.deepEqual({ ...route }, { primaryType: "prescription", documentType: "prescription" });
  }, () => [
    "电子处方笺",
    "药品名称 | 规格 | 每次剂量 | 频次 | 给药途径 | 数量",
    "阿莫西林胶囊 | 0.25g | 每次0.5g | 每日3次 | 口服 | 24粒"
  ]);
});

test("routes and persists outpatient inpatient billing vaccination and pathology facts", async () => {
  const scenarios = [
    {
      type: "outpatient",
      lines: ["门诊病历", "门诊诊断：急性上呼吸道感染", "处置：雾化吸入治疗"],
      fields: {
        reportType: "outpatient",
        diagnoses: [{ diagnosisType: "outpatient", diagnosisText: "急性上呼吸道感染", p: 1, q: "门诊诊断：急性上呼吸道感染" }],
        procedures: [{ procedureType: "treatment", procedureName: "雾化吸入治疗", p: 1, q: "处置：雾化吸入治疗" }],
        reportSections: [{ sectionKey: "outpatient_disposition", title: "处置", content: "雾化吸入治疗", p: 1, q: "处置：雾化吸入治疗" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_diagnoses").get() as { count: number }).count, 1);
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_procedures").get() as { count: number }).count, 1);
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_structured_sections").get() as { count: number }).count, 1);
      }
    },
    {
      type: "inpatient",
      lines: ["出院小结", "出院诊断：社区获得性肺炎", "出院用药：阿莫西林胶囊"],
      fields: {
        reportType: "inpatient",
        diagnoses: [{ diagnosisType: "discharge", diagnosisText: "社区获得性肺炎", p: 1, q: "出院诊断：社区获得性肺炎" }],
        medications: [{ context: "discharge", medicationName: "阿莫西林胶囊", p: 1, q: "出院用药：阿莫西林胶囊" }],
        reportSections: [{ sectionKey: "inpatient_discharge_instructions", title: "出院医嘱", content: "按时复诊", p: 1, q: "出院用药：阿莫西林胶囊" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_diagnoses").get() as { count: number }).count, 1);
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM report_medications").get() as { count: number }).count, 1);
      }
    },
    {
      type: "billing",
      lines: ["医疗收费票据", "票据号 INV-001", "总金额 128.00 元", "检验费 28.00 元"],
      fields: {
        reportType: "billing",
        billingSummary: { invoiceNumber: "INV-001", totalAmount: 128, currency: "CNY", p: 1, q: "总金额 128.00 元" },
        billingItems: [{ itemName: "检验费", category: "检验", amount: 28, p: 1, q: "检验费 28.00 元" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT total_amount AS total FROM billing_summaries").get() as { total: number }).total, 128);
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM billing_items").get() as { count: number }).count, 1);
      }
    },
    {
      type: "vaccination",
      lines: ["预防接种记录", "流感疫苗 第1剂", "接种部位：左上臂"],
      fields: {
        reportType: "vaccination",
        vaccinations: [{ vaccineName: "流感疫苗", doseNumber: "第1剂", administrationSite: "左上臂", p: 1, q: "流感疫苗 第1剂" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM vaccination_records").get() as { count: number }).count, 1);
      }
    },
    {
      type: "pathology",
      lines: ["病理报告", "病理诊断：结肠腺瘤", "免疫组化：Ki-67 约5%"],
      fields: {
        reportType: "pathology",
        diagnoses: [{ diagnosisType: "pathology", diagnosisText: "结肠腺瘤", p: 1, q: "病理诊断：结肠腺瘤" }],
        reportSections: [{ sectionKey: "pathology_immunohistochemistry", title: "免疫组化", content: "Ki-67 约5%", p: 1, q: "免疫组化：Ki-67 约5%" }]
      },
      verify: () => {
        assert.equal((getDatabase().prepare("SELECT diagnosis_type AS type FROM report_diagnoses").get() as { type: string }).type, "pathology");
        assert.equal((getDatabase().prepare("SELECT section_key AS key FROM report_structured_sections").get() as { key: string }).key, "pathology_immunohistochemistry");
      }
    }
  ] as const;

  for (const scenario of scenarios) {
    await withReport(1, async ({ reportId, jobId }) => {
      let routed = false;
      const executor: AiExecutor = async (input) => {
        if (input.extractionMode === "scalar") {
          routed = true;
          assert.equal(input.primaryContentType, scenario.type);
        }
        const normalized = normalizeAiExtraction(input.extractionMode === "scalar" ? scenario.fields : {});
        return {
          provider: "test", model: "test", promptVersion: "test", ...normalized,
          rawResponseJson: "{}", promptTokens: 10, completionTokens: 5, elapsedMs: 1
        };
      };
      const execution = await executeAiExtractionPlan(jobId, reportId, executor);
      assert.equal(routed, true);
      persistAiExtraction(reportId, jobId, execution.result, execution.inputCharacters);
      scenario.verify();
    }, () => [...scenario.lines]);
  }
});
