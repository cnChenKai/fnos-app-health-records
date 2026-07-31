import { createHash } from "node:crypto";
import { getDatabase } from "../database/client";
import { createId } from "../utils/identifier";
import {
  aiInputPlanningPolicy,
  buildAiExtractionPlan,
  estimateAiUnitOutputTokens,
  splitAiExtractionUnit,
  type AiExtractionPlan,
  type AiExtractionUnit
} from "./ai-input-planner.service";
import { getAiTaskSettings } from "./ai-settings.service";
import {
  normalizeAiExtraction,
  type AiEvidence,
  type AiExecutor,
  type AiExtractionFields,
  type AiExtractionInput,
  type AiExtractionResult,
  type AiMorphologyFinding,
  type AiObservation,
  aiExtractionPromptVersion
} from "./ai-extraction.service";
import { indicatorNameCandidates } from "./indicator-normalization.service";
import {
  mergeContentClassifications,
  reportContentClassifierVersion
} from "./report-content-classifier.service";

export const aiExtractionExecutionPolicy = {
  maxConcurrency: 3
} as const;

type UnitRow = {
  id: string;
  unitKey: string;
  unitIndex: number;
  inputHash: string;
  promptVersion: string | null;
  status: string;
  attempts: number;
  resultJson: string | null;
};

export type AiExtractionUnitEvent = {
  type: "unit_started" | "unit_completed" | "format_retry" | "output_retry" | "unit_split" | "unit_failed";
  message: string;
  detail: Record<string, unknown>;
};

type ExecuteOptions = {
  onEvent?: (event: AiExtractionUnitEvent) => void;
  shouldContinue?: () => boolean;
};

function configuredConcurrency() {
  const configured = Number(process.env.AI_EXTRACTION_CONCURRENCY);
  if (!Number.isFinite(configured)) return aiExtractionExecutionPolicy.maxConcurrency;
  return Math.max(1, Math.min(aiExtractionExecutionPolicy.maxConcurrency, Math.floor(configured)));
}

async function mapConcurrent<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: { stopOnError?: boolean } = {}
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;
  const runWorker = async () => {
    while (nextIndex < items.length && !(options.stopOnError && firstError)) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
        if (!options.stopOnError) continue;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(configuredConcurrency(), items.length) },
    () => runWorker()
  ));
  if (firstError && options.stopOnError) throw firstError;
  return results;
}

function errorDetails(error: unknown) {
  return {
    code: String((error as { code?: string })?.code || "AI_EXTRACTION_FAILED").slice(0, 80),
    message: (error instanceof Error ? error.message : "AI 整理失败").slice(0, 500)
  };
}

function configuredProvider() {
  const settings = getAiTaskSettings("report_extraction", true);
  let provider: string | null = null;
  try { provider = new URL(settings.baseUrl).host; } catch { provider = null; }
  return { provider, model: settings.model || null };
}

function syncUnitRoute(
  unitId: string,
  plan: AiExtractionPlan,
  unit: AiExtractionUnit
) {
  getDatabase().prepare(`
    INSERT INTO ai_extraction_unit_routes (
      unit_id, classifier_version, primary_content_type, content_types_json,
      confidence, reasons_json, document_content_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(unit_id) DO UPDATE SET
      classifier_version = excluded.classifier_version,
      primary_content_type = excluded.primary_content_type,
      content_types_json = excluded.content_types_json,
      confidence = excluded.confidence,
      reasons_json = excluded.reasons_json,
      document_content_type = excluded.document_content_type,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    unitId,
    reportContentClassifierVersion,
    unit.classification.primaryType,
    JSON.stringify(unit.classification.contentTypes),
    unit.classification.confidence,
    JSON.stringify(unit.classification.reasons),
    plan.documentClassification.primaryType
  );
}

function syncPlanUnits(jobId: string, reportId: string, plan: AiExtractionPlan) {
  const db = getDatabase();
  const activeKeys = new Set(plan.units.map((unit) => unit.unitKey));
  const existing = db.prepare(`
    SELECT id, unit_key AS unitKey, unit_index AS unitIndex, input_hash AS inputHash,
      status, attempts, prompt_version AS promptVersion, result_json AS resultJson
    FROM ai_extraction_units WHERE job_id = ?
  `).all(jobId) as UnitRow[];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of existing) {
      if (!activeKeys.has(row.unitKey)) {
        db.prepare(`
          UPDATE ai_extraction_units SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status <> 'superseded'
        `).run(row.id);
      }
    }
    const insert = db.prepare(`
      INSERT INTO ai_extraction_units (
        id, job_id, report_id, plan_hash, unit_key, unit_index, unit_type,
        page_numbers_json, page_ranges_json, input_hash, character_count, candidate_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, unit_key) DO UPDATE SET
        plan_hash = excluded.plan_hash,
        unit_index = excluded.unit_index,
        page_numbers_json = excluded.page_numbers_json,
        page_ranges_json = excluded.page_ranges_json,
        character_count = excluded.character_count,
        candidate_count = excluded.candidate_count,
        status = CASE
          WHEN ai_extraction_units.status = 'superseded' AND ai_extraction_units.result_json IS NOT NULL THEN 'completed'
          WHEN ai_extraction_units.status = 'superseded' THEN 'planned'
          ELSE ai_extraction_units.status
        END,
        updated_at = CURRENT_TIMESTAMP
    `);
    plan.units.forEach((unit, index) => {
      insert.run(
        createId("aiunit"), jobId, reportId, plan.planHash, unit.unitKey, index,
        unit.unitType, JSON.stringify(unit.pageNumbers), JSON.stringify(unit.pageRanges),
        unit.inputHash, unit.characterCount, unit.candidateRowCount
      );
      const routeRow = db.prepare(`
        SELECT id FROM ai_extraction_units WHERE job_id = ? AND unit_key = ?
      `).get(jobId, unit.unitKey) as { id: string };
      syncUnitRoute(routeRow.id, plan, unit);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const rows = db.prepare(`
    SELECT id, unit_key AS unitKey, unit_index AS unitIndex, input_hash AS inputHash,
      status, attempts, prompt_version AS promptVersion, result_json AS resultJson
    FROM ai_extraction_units
    WHERE job_id = ? AND plan_hash = ? AND status <> 'superseded'
    ORDER BY unit_index, id
  `).all(jobId, plan.planHash) as UnitRow[];
  return new Map(rows.map((row) => [row.unitKey, row]));
}

function inputForUnit(reportId: string, plan: AiExtractionPlan, unit: AiExtractionUnit, promptMode: AiExtractionInput["promptMode"]): AiExtractionInput {
  return {
    reportId,
    text: unit.text,
    inputCharacters: unit.characterCount,
    pageCount: unit.pageNumbers.length,
    planHash: plan.planHash,
    plannedUnits: plan.unitCount,
    sourceInputCharacters: plan.sourceCharacterCount,
    compatibilityTruncated: false,
    unitKey: unit.unitKey,
    unitType: unit.unitType,
    pageNumbers: unit.pageNumbers,
    promptMode,
    extractionMode: unit.extractionMode,
    route: unit.route,
    allowDocumentFields: unit.allowDocumentFields,
    primaryContentType: unit.classification.primaryType,
    contentTypes: unit.classification.contentTypes,
    classificationConfidence: unit.classification.confidence,
    classificationReasons: unit.classification.reasons,
    documentContentType: plan.documentClassification.primaryType,
    candidateFacts: unit.candidateFacts,
    candidateCount: unit.candidateRowCount
  };
}

function syncDynamicUnit(
  jobId: string,
  reportId: string,
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  unitIndex: number
) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO ai_extraction_units (
      id, job_id, report_id, plan_hash, unit_key, unit_index, unit_type,
      page_numbers_json, page_ranges_json, input_hash, character_count, candidate_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, unit_key) DO UPDATE SET
      unit_index = excluded.unit_index,
      page_numbers_json = excluded.page_numbers_json,
      page_ranges_json = excluded.page_ranges_json,
      input_hash = excluded.input_hash,
      character_count = excluded.character_count,
      candidate_count = excluded.candidate_count,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    createId("aiunit"), jobId, reportId, plan.planHash, unit.unitKey, unitIndex,
    unit.unitType, JSON.stringify(unit.pageNumbers), JSON.stringify(unit.pageRanges),
    unit.inputHash, unit.characterCount, unit.candidateRowCount
  );
  const row = db.prepare(`
    SELECT id, unit_key AS unitKey, unit_index AS unitIndex, input_hash AS inputHash,
      status, attempts, prompt_version AS promptVersion, result_json AS resultJson
    FROM ai_extraction_units WHERE job_id = ? AND unit_key = ?
  `).get(jobId, unit.unitKey) as UnitRow;
  syncUnitRoute(row.id, plan, unit);
  return row;
}

function startUnit(row: UnitRow) {
  getDatabase().prepare(`
    UPDATE ai_extraction_units SET status = 'processing', attempts = attempts + 1,
      error_code = NULL, error_message = NULL,
      started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(row.id);
  row.attempts += 1;
}

function recordAttempt(
  row: UnitRow,
  jobId: string,
  reportId: string,
  attemptType: "main" | "format_retry" | "supplement",
  inputCharacters: number,
  result: AiExtractionResult | null,
  error: unknown = null
) {
  const configured = configuredProvider();
  const failure = error ? errorDetails(error) : null;
  const failedAttempt = error as {
    provider?: string; model?: string; promptTokens?: number | null;
    completionTokens?: number | null; elapsedMs?: number | null;
  } | null;
  getDatabase().prepare(`
    INSERT INTO ai_extraction_attempts (
      id, unit_id, job_id, report_id, attempt_number, attempt_type, status,
      provider, model, prompt_version, input_characters, prompt_tokens,
      completion_tokens, elapsed_ms, error_code, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId("aiattempt"), row.id, jobId, reportId, row.attempts, attemptType,
    result ? "completed" : "failed",
    result?.provider || failedAttempt?.provider || configured.provider,
    result?.model || failedAttempt?.model || configured.model,
    result?.promptVersion || aiExtractionPromptVersion, inputCharacters,
    result?.promptTokens ?? failedAttempt?.promptTokens ?? null,
    result?.completionTokens ?? failedAttempt?.completionTokens ?? null,
    result?.elapsedMs ?? failedAttempt?.elapsedMs ?? null,
    failure?.code || null, failure?.message || null
  );
}

function completeUnit(row: UnitRow, result: AiExtractionResult) {
  getDatabase().prepare(`
    UPDATE ai_extraction_units SET status = 'completed', provider = ?, model = ?,
      prompt_version = ?, result_json = ?, prompt_tokens = ?, completion_tokens = ?,
      elapsed_ms = ?, error_code = NULL, error_message = NULL,
      finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    result.provider, result.model, result.promptVersion, JSON.stringify(result),
    result.promptTokens, result.completionTokens, result.elapsedMs, row.id
  );
}

function failUnit(row: UnitRow, error: unknown) {
  const failure = errorDetails(error);
  getDatabase().prepare(`
    UPDATE ai_extraction_units SET status = 'failed', error_code = ?, error_message = ?,
      finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(failure.code, failure.message, row.id);
}

function parseStoredResult(row: UnitRow) {
  if (row.status !== "completed" || !row.resultJson) return null;
  try { return JSON.parse(row.resultJson) as AiExtractionResult; } catch { return null; }
}

function distinctStrings(values: Array<string | null>) {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const clean = value?.trim();
    if (!clean || seen.has(clean)) return [];
    seen.add(clean);
    return [clean];
  });
}

function pickField<K extends keyof AiExtractionFields>(results: AiExtractionResult[], key: K): AiExtractionFields[K] {
  const candidates = results.flatMap((result, index) => {
    const value = result.fields[key];
    if (value === null || value === undefined || value === "") return [];
    if (Array.isArray(value) && !value.length) return [];
    if (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) return [];
    return [{ value, score: result.confidence[key as string] ?? 0, index }];
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  return (candidates[0]?.value ?? null) as AiExtractionFields[K];
}

function observationKey(item: AiObservation) {
  const evidence = item.evidence.map((entry) => `${entry.pageNumber}:${entry.quote}`).join("|");
  return [item.sectionName, item.itemCode, item.itemName, item.resultText, item.numericValue,
    item.unit, item.referenceLow, item.referenceHigh, item.referenceText, evidence]
    .join("\u0000").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function morphologyKey(item: AiMorphologyFinding) {
  const evidence = item.evidence.map((entry) => `${entry.pageNumber}:${entry.quote}`).join("|");
  return [item.organ, item.region, item.laterality, item.findingType, item.findingName,
    item.presence, item.rawText, evidence]
    .join("\u0000").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function observationSemanticIdentity(item: AiObservation) {
  const candidate = indicatorNameCandidates(item.normalizedName || item.itemName)[0]
    || compactEvidence(item.normalizedName || item.itemName);
  return candidate
    .replace(/百分比|百分率|百分数|比例/g, "比率")
    .replace(/数目/g, "计数");
}

function observationResultIdentity(item: AiObservation) {
  const parsed = item.numericValue ?? (() => {
    const match = item.resultText.match(/[-+]?\d+(?:\.\d+)?/);
    if (!match) return null;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  })();
  if (parsed !== null) return `number:${Number(parsed.toPrecision(12))}`;
  return `text:${compactEvidence(item.resultText)}`;
}

function evidenceSourceKeys(plan: AiExtractionPlan, item: AiObservation) {
  const keys = new Set<string>();
  for (const evidence of item.evidence) {
    const quote = compactEvidence(evidence.quote);
    if (quote.length < 2) continue;
    const page = plan.pages.find((candidate) => candidate.pageNumber === evidence.pageNumber);
    if (!page) continue;
    const matches = page.lines.flatMap((line) => {
      const source = compactEvidence(line.text);
      if (!source) return [];
      if (source === quote) return [{ line, score: 2 }];
      if (source.includes(quote)) return [{ line, score: 1 + quote.length / source.length }];
      if (quote.includes(source)) return [{ line, score: 1 + source.length / quote.length }];
      return [];
    }).sort((left, right) => right.score - left.score || left.line.index - right.line.index);
    if (matches[0] && (!matches[1] || matches[0].score > matches[1].score)) {
      keys.add(`${page.pageId}:${matches[0].line.id}`);
    } else {
      keys.add(`page-${evidence.pageNumber}:quote-${quote}`);
    }
  }
  return [...keys];
}

function exactEvidenceForObservation(
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  item: AiObservation
) {
  const allowedPages = new Set(unit.pageNumbers);
  const itemName = compactEvidence(item.itemName);
  const result = compactEvidence(item.resultText);
  const matches = item.evidence.flatMap((evidence) => {
    if (!allowedPages.has(evidence.pageNumber)) return [];
    const page = plan.pages.find((candidate) => candidate.pageNumber === evidence.pageNumber);
    if (!page) return [];
    const quote = compactEvidence(evidence.quote);
    return page.lines.filter((line) =>
      line.candidateKind === "scalar" && unit.text.includes(line.text)
    ).flatMap((line) => {
      const source = compactEvidence(line.text);
      const quoteMatched = quote.length >= 4 && (source.includes(quote) || quote.includes(source));
      const valueMatched = itemName.length >= 2 && result.length >= 1
        && source.includes(itemName) && source.includes(result);
      return quoteMatched || valueMatched
        ? [{ pageNumber: page.pageNumber, quote: line.text, score: quoteMatched ? 2 : 1 }]
        : [];
    });
  }).sort((left, right) => right.score - left.score);
  return uniqueBy(matches.map(({ pageNumber, quote }) => ({ pageNumber, quote })),
    (entry) => `${entry.pageNumber}:${entry.quote}`);
}

function cleanSectionLabel(value: string) {
  return value.replace(/^【\s*|\s*】$/g, "").replace(/[:：]$/, "").trim();
}

function nearestContext(
  plan: AiExtractionPlan,
  page: AiExtractionPlan["pages"][number],
  lineIndex: number
) {
  let section: string | null = null;
  let reportSection: string | null = null;
  let tableHeader: string | null = null;
  for (const candidatePage of plan.pages) {
    if (candidatePage.pageNumber > page.pageNumber) break;
    for (const line of candidatePage.lines) {
      if (candidatePage.pageNumber === page.pageNumber && line.index >= lineIndex) break;
      if (line.boundary === "section") {
        const label = cleanSectionLabel(line.text);
        if (/(?:检验|检查|体检|超声|心电图|病理|门诊|住院|出院).{0,12}(?:报告|报告单)$/.test(label)) {
          reportSection = label;
          section = null;
          tableHeader = null;
        } else {
          section = label;
          tableHeader = null;
        }
      } else if (line.boundary === "table_header") {
        tableHeader = line.text;
      }
    }
  }
  const sectionLabel = section && reportSection && !section.includes(reportSection)
    ? `${reportSection} / ${section}`
    : section || reportSection;
  return { section: sectionLabel, tableHeader };
}

function correctedTableResult(
  item: AiObservation,
  cells: string[],
  nameCellIndex: number
) {
  const resultCell = nameCellIndex >= 0 ? cells[nameCellIndex + 1] || "" : "";
  if (!resultCell) return item;
  if (/^[-+±]+$/.test(resultCell)) {
    const referenceCell = cells[nameCellIndex + 2] || "";
    const range = referenceCell.match(/([-+]?\d+(?:\.\d+)?)\s*[~～-]\s*([-+]?\d+(?:\.\d+)?)/);
    return {
      ...item,
      resultText: resultCell,
      numericValue: null,
      unit: null,
      referenceLow: range ? Number(range[1]) : item.referenceLow,
      referenceHigh: range ? Number(range[2]) : item.referenceHigh,
      referenceText: range ? referenceCell : item.referenceText,
      abnormalFlag: resultCell.includes("+") ? "abnormal" as const : null
    };
  }
  if (/^(?:阴性|阳性|弱阳性|正常|异常|未见|可见)$/.test(resultCell)) {
    return {
      ...item,
      resultText: resultCell,
      numericValue: null,
      unit: null,
      abnormalFlag: /^(?:阳性|弱阳性|异常|可见)$/.test(resultCell)
        ? "abnormal" as const
        : resultCell === "正常" ? "normal" as const : null
    };
  }
  const numeric = resultCell.match(/[-+]?\d+(?:\.\d+)?/);
  if (!numeric) return item;
  const parsed = Number(numeric[0]);
  if (!Number.isFinite(parsed)) return item;
  const explicitUnit = resultCell.match(
    /(?:10\^?\d+\/L|mmol\/L|μmol\/L|nmol\/L|pmol\/L|mg\/dL|mg\/L|ng\/mL|μg\/L|g\/L|L\/L|U\/L|IU\/L|Cell\/HP|Cast\/LP|\/HPF|\/LPF|cm\/s|mmHg|bpm|次\s*\/\s*分|kg\s*\/\s*m(?:2|²|㎡)|kg|cm|mm|mV|ms|Angle|pg|fL|%)/i
  )?.[0] || null;
  return {
    ...item,
    resultText: resultCell,
    numericValue: parsed,
    unit: explicitUnit || item.unit,
    abnormalFlag: /[↑▲⬆]|偏高/.test(resultCell)
      ? "high" as const
      : /[↓▼⬇]|偏低/.test(resultCell) ? "low" as const : item.abnormalFlag
  };
}

function validatedObservation(
  plan: AiExtractionPlan,
  item: AiObservation,
  evidence: AiEvidence[]
) {
  const firstEvidence = evidence[0];
  const page = plan.pages.find((candidate) => candidate.pageNumber === firstEvidence?.pageNumber);
  const line = page?.lines.find((candidate) => candidate.text === firstEvidence?.quote);
  const inferredContext = page && line ? nearestContext(plan, page, line.index) : null;
  const sectionName = inferredContext?.section || item.sectionName;
  const cells = (firstEvidence?.quote || "").split(/[|｜]/).map((cell) => cell.trim()).filter(Boolean);
  const compactName = compactEvidence(item.itemName);
  const nameCellIndex = cells.findIndex((cell) => {
    const compactCell = compactEvidence(cell);
    return compactCell.length >= 2
      && (compactCell.includes(compactName) || compactName.includes(compactCell));
  });
  const sourceItemName = cells.length > 1 && nameCellIndex >= 0
    ? cells[nameCellIndex]
    : item.itemName;
  const corrected = correctedTableResult({
    ...item,
    sectionName,
    itemName: sourceItemName,
    normalizedName: null
  }, cells, nameCellIndex);
  const currentResultCell = nameCellIndex >= 0 && cells[nameCellIndex + 1]
    ? cells[nameCellIndex + 1]
    : firstEvidence?.quote || "";
  const explicitHigh = /[↑▲⬆]|偏高/.test(currentResultCell);
  const explicitLow = /[↓▼⬇]|偏低/.test(currentResultCell);
  const value = corrected.numericValue;
  const inRange = value !== null
    && (corrected.referenceLow === null || value >= corrected.referenceLow)
    && (corrected.referenceHigh === null || value <= corrected.referenceHigh)
    && (corrected.referenceLow !== null || corrected.referenceHigh !== null);
  const outOfRange = value !== null && (
    (corrected.referenceLow !== null && value < corrected.referenceLow)
    || (corrected.referenceHigh !== null && value > corrected.referenceHigh)
  );
  let abnormalFlag = corrected.abnormalFlag;
  if (abnormalFlag === "high" && inRange && !explicitHigh) abnormalFlag = null;
  if (abnormalFlag === "low" && inRange && !explicitLow) abnormalFlag = null;
  if (abnormalFlag === "normal" && outOfRange) abnormalFlag = null;
  return { ...corrected, abnormalFlag, evidence };
}

function exactEvidenceForMorphology(
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  item: AiMorphologyFinding
) {
  const allowedPages = new Set(unit.pageNumbers);
  const anchors = [
    item.rawText, item.findingName, item.findingType, item.organ,
    ...item.evidence.map((entry) => entry.quote)
  ].map(compactEvidence).filter((value) => value.length >= 2);
  const preferredPages = new Set(item.evidence.map((entry) => entry.pageNumber).filter((page) => allowedPages.has(page)));
  const pages = plan.pages.filter((page) =>
    allowedPages.has(page.pageNumber) && (!preferredPages.size || preferredPages.has(page.pageNumber))
  );
  const matches = pages.flatMap((page) => page.lines
    .filter((line) => unit.text.includes(line.text))
    .flatMap((line) => {
      const source = compactEvidence(line.text);
      const score = Math.max(0, ...anchors.map((anchor) =>
        source.includes(anchor) || anchor.includes(source)
          ? Math.min(source.length, anchor.length) / Math.max(source.length, anchor.length)
          : 0
      ));
      return score >= 0.45 ? [{ pageNumber: page.pageNumber, quote: line.text, score }] : [];
    })).sort((left, right) => right.score - left.score);
  return uniqueBy(matches.slice(0, 5).map(({ pageNumber, quote }) => ({ pageNumber, quote })),
    (entry) => `${entry.pageNumber}:${entry.quote}`);
}

function exactEvidenceForClinicalFact(
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  evidence: AiEvidence[],
  anchors: Array<string | null>
) {
  const allowedPages = new Set(unit.pageNumbers);
  const compactAnchors = [...anchors, ...evidence.map((entry) => entry.quote)]
    .map(compactEvidence)
    .filter((value) => value.length >= 2);
  const preferredPages = new Set(evidence
    .map((entry) => entry.pageNumber)
    .filter((pageNumber) => allowedPages.has(pageNumber)));
  const matches = plan.pages.filter((page) =>
    allowedPages.has(page.pageNumber) && (!preferredPages.size || preferredPages.has(page.pageNumber))
  ).flatMap((page) => page.lines.filter((line) => unit.text.includes(line.text)).flatMap((line) => {
    const source = compactEvidence(line.text);
    const score = Math.max(0, ...compactAnchors.map((anchor) =>
      source.includes(anchor) || anchor.includes(source)
        ? Math.min(source.length, anchor.length) / Math.max(source.length, anchor.length)
        : 0
    ));
    return score >= 0.35 ? [{ pageNumber: page.pageNumber, quote: line.text, score }] : [];
  })).sort((left, right) => right.score - left.score);
  return uniqueBy(matches.slice(0, 5).map(({ pageNumber, quote }) => ({ pageNumber, quote })),
    (entry) => `${entry.pageNumber}:${entry.quote}`);
}

function validateResultEvidence(
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  result: AiExtractionResult
) {
  const observations = (unit.route === "scalar" || (unit.route === "document" && unit.candidateRowCount > 0))
    ? result.fields.observations.flatMap((item) => {
        const evidence = exactEvidenceForObservation(plan, unit, item);
        return evidence.length ? [validatedObservation(plan, item, evidence)] : [];
      })
    : [];
  const morphologyFindings = unit.route === "morphology"
    ? result.fields.morphologyFindings.flatMap((item) => {
        const evidence = exactEvidenceForMorphology(plan, unit, item);
        return evidence.length ? [{ ...item, evidence, rawText: evidence[0].quote }] : [];
      })
    : [];
  const diagnoses = unit.route === "narrative"
    ? result.fields.diagnoses.flatMap((item) => {
        const evidence = exactEvidenceForClinicalFact(plan, unit, item.evidence, [
          item.diagnosisText, item.diagnosisCode, item.sectionName
        ]);
        return evidence.length ? [{ ...item, evidence }] : [];
      })
    : [];
  const medications = unit.route === "narrative"
    ? result.fields.medications.flatMap((item) => {
        const evidence = exactEvidenceForClinicalFact(plan, unit, item.evidence, [
          item.medicationName, item.genericName, item.specification, item.instructions
        ]);
        return evidence.length ? [{ ...item, evidence }] : [];
      })
    : [];
  const procedures = unit.route === "narrative"
    ? result.fields.procedures.flatMap((item) => {
        const evidence = exactEvidenceForClinicalFact(plan, unit, item.evidence, [
          item.procedureName, item.procedureCode, item.resultText
        ]);
        return evidence.length ? [{ ...item, evidence }] : [];
      })
    : [];
  const vaccinations = unit.route === "narrative"
    ? result.fields.vaccinations.flatMap((item) => {
        const evidence = exactEvidenceForClinicalFact(plan, unit, item.evidence, [
          item.vaccineName, item.lotNumber, item.manufacturer
        ]);
        return evidence.length ? [{ ...item, evidence }] : [];
      })
    : [];
  const billingSummaryEvidence = unit.route === "narrative" && result.fields.billingSummary
    ? exactEvidenceForClinicalFact(plan, unit, result.fields.billingSummary.evidence, [
        result.fields.billingSummary.invoiceNumber,
        result.fields.billingSummary.totalAmount === null ? null : String(result.fields.billingSummary.totalAmount)
      ])
    : [];
  const billingSummary = result.fields.billingSummary && billingSummaryEvidence.length
    ? { ...result.fields.billingSummary, evidence: billingSummaryEvidence }
    : null;
  const billingItems = unit.route === "narrative"
    ? result.fields.billingItems.flatMap((item) => {
        const evidence = exactEvidenceForClinicalFact(plan, unit, item.evidence, [
          item.itemName, item.category, item.amount === null ? null : String(item.amount)
        ]);
        return evidence.length ? [{ ...item, evidence }] : [];
      })
    : [];
  const reportSections = unit.route === "narrative"
    ? result.fields.reportSections.flatMap((item) => {
        const evidence = exactEvidenceForClinicalFact(plan, unit, item.evidence, [
          item.title, item.content.slice(0, 300)
        ]);
        return evidence.length ? [{ ...item, evidence }] : [];
      })
    : [];
  const rejectedObservations = result.fields.observations.length - observations.length;
  const rejectedMorphologyFindings = result.fields.morphologyFindings.length - morphologyFindings.length;
  const rejectedClinicalFacts =
    result.fields.diagnoses.length - diagnoses.length
    + result.fields.medications.length - medications.length
    + result.fields.procedures.length - procedures.length
    + result.fields.vaccinations.length - vaccinations.length
    + result.fields.billingItems.length - billingItems.length
    + (result.fields.billingSummary && !billingSummary ? 1 : 0);
  const rejectedStructuredSections = result.fields.reportSections.length - reportSections.length;
  const clinicalFacts = {
    diagnoses,
    medications,
    procedures,
    vaccinations,
    billingSummary,
    billingItems,
    reportSections
  };
  const narrativeFields = {
    clinicalDiagnosis: result.fields.clinicalDiagnosis,
    purpose: result.fields.purpose,
    chiefComplaint: result.fields.chiefComplaint,
    findings: result.fields.findings,
    impression: result.fields.impression,
    summary: result.fields.summary,
    recommendation: result.fields.recommendation
  };
  const source = unit.route === "morphology"
    ? { morphologyFindings }
    : unit.route === "document"
      ? { ...result.fields, observations, morphologyFindings: [], ...clinicalFacts }
      : unit.route === "narrative"
        ? { ...narrativeFields, observations: [], morphologyFindings: [], ...clinicalFacts }
        : { observations, morphologyFindings: [] };
  const normalized = normalizeAiExtraction({
    ...source,
    evidence: unit.route === "document" || unit.route === "narrative" ? result.evidence : {},
    confidence: unit.route === "document" || unit.route === "narrative" ? result.confidence : {}
  });
  return {
    ...result,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields, evidence: normalized.evidence, confidence: normalized.confidence
    }),
    evidenceValidation: {
      rejectedObservations,
      rejectedMorphologyFindings,
      rejectedClinicalFacts,
      rejectedStructuredSections
    }
  };
}

function observationCompleteness(item: AiObservation) {
  const values = [
    item.sectionName, item.itemCode, item.normalizedName, item.numericValue, item.unit,
    item.referenceLow, item.referenceHigh, item.referenceText, item.abnormalFlag, item.method
  ];
  let score = item.evidence.length;
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") score += 1;
  }
  return score;
}

function mergeObservationPair(left: AiObservation, right: AiObservation) {
  const primary = observationCompleteness(right) > observationCompleteness(left) ? right : left;
  const fallback = primary === left ? right : left;
  const fill = <K extends keyof AiObservation>(key: K) => {
    const value = primary[key];
    return value === null || value === undefined || value === "" ? fallback[key] : value;
  };
  return {
    ...primary,
    sectionName: fill("sectionName"),
    itemCode: fill("itemCode"),
    normalizedName: fill("normalizedName"),
    numericValue: fill("numericValue"),
    unit: fill("unit"),
    referenceLow: fill("referenceLow"),
    referenceHigh: fill("referenceHigh"),
    referenceText: fill("referenceText"),
    abnormalFlag: fill("abnormalFlag"),
    method: fill("method"),
    evidence: uniqueBy([...left.evidence, ...right.evidence], (entry) =>
      `${entry.pageNumber}:${compactEvidence(entry.quote)}`
    )
  } satisfies AiObservation;
}

function deduplicateObservationsBySource(plan: AiExtractionPlan, observations: AiObservation[]) {
  const merged: AiObservation[] = [];
  const sourceIndex = new Map<string, number>();
  for (const observation of observations) {
    const semantic = observationSemanticIdentity(observation);
    const result = observationResultIdentity(observation);
    const sources = evidenceSourceKeys(plan, observation);
    const keys = sources.map((source) => `${source}\u0000${semantic}\u0000${result}`);
    const existingIndex = keys.flatMap((key) => {
      const index = sourceIndex.get(key);
      return index === undefined ? [] : [index];
    })[0];
    if (existingIndex === undefined || !keys.length) {
      const index = merged.push(observation) - 1;
      for (const key of keys) sourceIndex.set(key, index);
      continue;
    }
    merged[existingIndex] = mergeObservationPair(merged[existingIndex], observation);
    for (const key of keys) sourceIndex.set(key, existingIndex);
  }
  return merged;
}

function withSourceDeduplication(plan: AiExtractionPlan, result: AiExtractionResult) {
  const observations = deduplicateObservationsBySource(plan, result.fields.observations);
  if (observations.length === result.fields.observations.length) return result;
  const normalized = normalizeAiExtraction({
    ...result.fields,
    observations,
    evidence: result.evidence,
    confidence: result.confidence
  });
  return {
    ...result,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields, evidence: normalized.evidence, confidence: normalized.confidence
    })
  };
}

function compactEvidence(value: unknown) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[（）()，,。.:：;；、|\s_\-]+/g, "");
}

function resultMatchesLine(result: AiExtractionResult, line: string) {
  const compactLine = compactEvidence(line);
  if (!compactLine) return false;
  const evidenceTexts = [
    ...result.fields.observations.flatMap((item) => [
      ...item.evidence.map((entry) => entry.quote),
      `${item.itemName}${item.resultText}`
    ]),
    ...result.fields.morphologyFindings.flatMap((item) => [
      item.rawText,
      item.morphology || "",
      ...item.evidence.map((entry) => entry.quote)
    ]),
    ...result.fields.diagnoses.flatMap((item) => [item.diagnosisText, ...item.evidence.map((entry) => entry.quote)]),
    ...result.fields.medications.flatMap((item) => [item.medicationName, ...item.evidence.map((entry) => entry.quote)]),
    ...result.fields.procedures.flatMap((item) => [item.procedureName, ...item.evidence.map((entry) => entry.quote)]),
    ...result.fields.vaccinations.flatMap((item) => [item.vaccineName, ...item.evidence.map((entry) => entry.quote)]),
    ...(result.fields.billingSummary?.evidence.map((entry) => entry.quote) || []),
    ...result.fields.billingItems.flatMap((item) => [item.itemName, ...item.evidence.map((entry) => entry.quote)])
  ].map(compactEvidence).filter((value) => value.length >= 4);
  return evidenceTexts.some((value) => compactLine.includes(value) || value.includes(compactLine));
}

function unitCandidateLines(plan: AiExtractionPlan, unit: AiExtractionUnit) {
  if (unit.route === "narrative" || (unit.route === "document" && unit.candidateRowCount === 0)) return [];
  return unit.pageRanges.flatMap((range) => {
    const page = plan.pages.find((item) => item.pageId === range.pageId);
    if (!page) return [];
    const rangeLines = unit.unitType === "complete_pages"
      ? page.lines
      : page.lines.filter((line) =>
          line.index >= range.lineStart && line.index <= range.lineEnd
        );
    return rangeLines
      .filter((line) =>
        line.candidateKind === unit.extractionMode
        && !line.localObservation
        && unit.text.includes(line.text)
      )
      .map((line) => ({ page, line }));
  });
}

function supplementUnits(plan: AiExtractionPlan, result: AiExtractionResult) {
  type Candidate = {
    page: AiExtractionPlan["pages"][number];
    line: AiExtractionPlan["pages"][number]["lines"][number];
  };
  type Block = {
    page: AiExtractionPlan["pages"][number];
    pageNumber: number;
    extractionMode: AiExtractionUnit["extractionMode"];
    candidates: Candidate[];
    text: string;
    chunkIndex: number;
    chunkCount: number;
  };
  const byPageAndMode = new Map<string, Candidate[]>();
  for (const unit of plan.units.filter((item) => item.unitType !== "supplement")) {
    for (const candidate of unitCandidateLines(plan, unit)) {
      if (resultMatchesLine(result, candidate.line.text)) continue;
      const key = `${candidate.page.pageNumber}:${unit.extractionMode}`;
      const current = byPageAndMode.get(key) || [];
      if (!current.some((item) => item.line.id === candidate.line.id)) current.push(candidate);
      byPageAndMode.set(key, current);
    }
  }
  const rawBlocks: Block[] = [...byPageAndMode.entries()].flatMap(([key, candidates]) => {
    if (!candidates.length) return [];
    const [pageNumberText, mode] = key.split(":");
    const pageNumber = Number(pageNumberText);
    const extractionMode = mode as AiExtractionUnit["extractionMode"];
    const page = candidates[0].page;
    const contexts = candidates.map((item) => nearestContext(plan, page, item.line.index));
    const sections = distinctStrings(contexts.map((item) => item.section));
    const headers = distinctStrings(contexts.map((item) => item.tableHeader));
    return [{
      page,
      pageNumber,
      extractionMode,
      candidates,
      chunkIndex: 1,
      chunkCount: 1,
      text: [
        `[第 ${pageNumber} 页 · ${extractionMode === "morphology" ? "形态发现" : "指标"}遗漏候选补提取]`,
        ...sections.map((item) => `[章节：${item.replace(/[:：]$/, "")}]`),
        ...headers.map((item) => `[表头：${item}]`),
        ...candidates.map((item) => item.line.text)
      ].join("\n")
    }];
  });
  const blocks = rawBlocks.flatMap((block) => {
    const maximum = block.extractionMode === "morphology" ? 16 : 30;
    const chunkCount = Math.max(1, Math.ceil(block.candidates.length / maximum));
    return Array.from({ length: chunkCount }, (_, index): Block => {
      const candidates = block.candidates.slice(index * maximum, (index + 1) * maximum);
      return {
        ...block,
        candidates,
        chunkIndex: index + 1,
        chunkCount,
        text: [
          `[第 ${block.pageNumber} 页 · ${block.extractionMode === "morphology" ? "形态发现" : "指标"}遗漏候选补提取${chunkCount > 1 ? ` · ${index + 1}/${chunkCount}` : ""}]`,
          ...distinctStrings(candidates.map((item) => nearestContext(plan, block.page, item.line.index).section))
            .map((item) => `[章节：${item.replace(/[:：]$/, "")}]`),
          ...distinctStrings(candidates.map((item) => nearestContext(plan, block.page, item.line.index).tableHeader))
            .map((item) => `[表头：${item}]`),
          ...candidates.map((item) => item.line.text)
        ].join("\n")
      };
    });
  });
  const units: AiExtractionUnit[] = [];
  let pending: typeof blocks = [];
  const flush = () => {
    if (!pending.length) return;
    const extractionMode = pending[0].extractionMode;
    const text = pending.map((block) => block.text).join("\n\n");
    const inputHash = createHash("sha256").update([
      aiInputPlanningPolicy.version,
      "supplement",
      extractionMode,
      text
    ].join("\u0000")).digest("hex");
    const pageNumbers = [...new Set(pending.map((block) => block.pageNumber))];
    const candidateRowCount = pending.reduce((sum, block) => sum + block.candidates.length, 0);
    const morphologyCandidateCount = extractionMode === "morphology" ? candidateRowCount : 0;
    const candidateFacts = pending.flatMap((block) => block.candidates.map((item) => ({
      pageNumber: block.pageNumber,
      kind: extractionMode,
      sourceText: item.line.text,
      dictionaryFacts: item.line.dictionaryFacts
    })));
    units.push({
      unitKey: `unit_${createHash("sha256").update(`supplement|${extractionMode}|${pageNumbers.join(",")}|${inputHash}`).digest("hex").slice(0, 24)}`,
      inputHash,
      unitType: "supplement",
      extractionMode,
      route: extractionMode,
      allowDocumentFields: false,
      classification: mergeContentClassifications(
        pending.map((block) => block.page.classification)
      ),
      pageNumbers,
      pageRanges: pending.map((block) => ({
        pageId: block.page.pageId,
        pageNumber: block.pageNumber,
        lineStart: Math.min(...block.candidates.map((item) => item.line.index)),
        lineEnd: Math.max(...block.candidates.map((item) => item.line.index)),
        chunkIndex: block.chunkIndex,
        chunkCount: block.chunkCount
      })),
      characterCount: text.length,
      candidateRowCount,
      morphologyCandidateCount,
      localObservationCount: 0,
      estimatedOutputTokens: estimateAiUnitOutputTokens({
        pageCount: pageNumbers.length,
        characterCount: text.length,
        candidateRowCount,
        morphologyCandidateCount
      }),
      lineCount: pending.reduce((sum, block) => sum + block.candidates.length, 0),
      text,
      candidateFacts
    });
    pending = [];
  };
  for (const block of blocks) {
    if (pending.length && pending[0].extractionMode !== block.extractionMode) flush();
    const combinedCharacters = [...pending, block].map((item) => item.text).join("\n\n").length;
    const combinedCandidates = [...pending, block].reduce((sum, item) => sum + item.candidates.length, 0);
    const combinedMorphologyCandidates = block.extractionMode === "morphology"
      ? combinedCandidates : 0;
    const estimatedOutputTokens = estimateAiUnitOutputTokens({
      pageCount: new Set([...pending, block].map((item) => item.pageNumber)).size,
      characterCount: combinedCharacters,
      candidateRowCount: combinedCandidates,
      morphologyCandidateCount: combinedMorphologyCandidates
    });
    if (
      pending.length
      && (
        pending.length >= aiInputPlanningPolicy.maxPagesPerUnit
        || combinedCharacters > aiInputPlanningPolicy.targetCharacters
        || estimatedOutputTokens > aiInputPlanningPolicy.targetOutputTokens
        || combinedCandidates > aiInputPlanningPolicy.maxCandidateRowsPerUnit
      )
    ) flush();
    pending.push(block);
  }
  flush();
  return units;
}

const basicMeasurements = [
  { name: "身高", aliases: /(?:身高|height)/i, unit: /(cm|mm|m)\b/i, minimum: 30, maximum: 260 },
  { name: "体重", aliases: /(?:体重(?!指数)|weight)/i, unit: /(kg(?!\s*\/)|公斤|千克)\b/i, minimum: 2, maximum: 400 },
  { name: "体重指数", aliases: /(?:体重指数|BMI)/i, unit: /(kg\s*\/\s*m(?:2|²))\b/i, minimum: 5, maximum: 100, unitOptional: true },
  { name: "腰围", aliases: /腰围/i, unit: /(cm|mm|m)\b/i, minimum: 20, maximum: 250 },
  { name: "臀围", aliases: /臀围/i, unit: /(cm|mm|m)\b/i, minimum: 20, maximum: 300 },
  { name: "脉搏", aliases: /(?:脉搏|心率|pulse)/i, unit: /(bpm|次\s*\/\s*分)/i, minimum: 20, maximum: 250, unitOptional: true }
] as const;

function deterministicTableObservations(plan: AiExtractionPlan): AiObservation[] {
  const seen = new Set<string>();
  return plan.pages.flatMap((page) => page.lines.flatMap((line) => {
    const fact = line.localObservation;
    if (!fact) return [];
    const key = `${fact.pageNumber}:${fact.sourceLineId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      sectionName: fact.sectionName,
      itemCode: null,
      itemName: fact.itemName,
      normalizedName: fact.normalizedName,
      resultText: fact.resultText,
      numericValue: fact.numericValue,
      unit: fact.unit,
      referenceLow: fact.referenceLow,
      referenceHigh: fact.referenceHigh,
      referenceText: fact.referenceText,
      abnormalFlag: fact.abnormalFlag,
      method: null,
      evidence: [{ pageNumber: fact.pageNumber, quote: fact.sourceText }]
    }];
  }));
}

function deterministicBasicObservations(plan: AiExtractionPlan, fields: AiExtractionFields) {
  const existing = new Set(fields.observations.map((item) => compactEvidence(item.itemName)));
  for (const definition of basicMeasurements) {
    if (fields.observations.some((item) => definition.aliases.test(item.itemName))) {
      existing.add(compactEvidence(definition.name));
    }
  }
  if (fields.observations.some((item) => /收缩压/.test(item.itemName))) existing.add(compactEvidence("收缩压"));
  if (fields.observations.some((item) => /舒张压/.test(item.itemName))) existing.add(compactEvidence("舒张压"));
  const additions: AiObservation[] = [];
  const add = (item: AiObservation) => {
    const key = compactEvidence(item.itemName);
    if (existing.has(key)) return;
    existing.add(key);
    additions.push(item);
  };
  for (const page of plan.pages) {
    for (const line of page.lines) {
      for (const definition of basicMeasurements) {
        if (existing.has(compactEvidence(definition.name))) continue;
        const alias = line.text.match(definition.aliases);
        if (!alias || alias.index === undefined) continue;
        const suffix = line.text.slice(alias.index + alias[0].length, alias.index + alias[0].length + 48);
        const valueMatch = suffix.match(/^[^\d+-]{0,12}([-+]?\d+(?:\.\d+)?)/);
        if (!valueMatch || /参考|范围/.test(suffix.slice(0, valueMatch.index))) continue;
        const value = Number(valueMatch[1]);
        if (!Number.isFinite(value) || value < definition.minimum || value > definition.maximum) continue;
        const afterValue = suffix.slice((valueMatch.index || 0) + valueMatch[0].length);
        const unitMatch = afterValue.match(definition.unit);
        if (!unitMatch && !("unitOptional" in definition && definition.unitOptional)) continue;
        add({
          sectionName: "一般检查",
          itemCode: null,
          itemName: definition.name,
          normalizedName: definition.name,
          resultText: valueMatch[1],
          numericValue: value,
          unit: unitMatch?.[1]?.replace(/\s+/g, "") || null,
          referenceLow: null,
          referenceHigh: null,
          referenceText: null,
          abnormalFlag: /[↑▲]|偏高/.test(line.text) ? "high" : /[↓▼]|偏低/.test(line.text) ? "low" : null,
          method: null,
          evidence: [{ pageNumber: page.pageNumber, quote: line.text }]
        });
      }
      if (!["收缩压", "舒张压"].every((name) => existing.has(compactEvidence(name)))) {
        const bloodPressure = line.text.match(/(?:血压|BP)[^\d]{0,12}(\d{2,3})\s*[\/／]\s*(\d{2,3})\s*(mmHg)?/i);
        if (bloodPressure) {
          const systolic = Number(bloodPressure[1]);
          const diastolic = Number(bloodPressure[2]);
          if (systolic >= 50 && systolic <= 280 && diastolic >= 30 && diastolic <= 180) {
            for (const [name, value] of [["收缩压", systolic], ["舒张压", diastolic]] as const) add({
              sectionName: "一般检查", itemCode: null, itemName: name, normalizedName: name,
              resultText: String(value), numericValue: value, unit: "mmHg",
              referenceLow: null, referenceHigh: null, referenceText: null,
              abnormalFlag: null, method: null,
              evidence: [{ pageNumber: page.pageNumber, quote: line.text }]
            });
          }
        }
      }
    }
  }
  return additions;
}

type VascularMetric = "abi" | "bapwv";
type VascularSide = "left" | "right";

function vascularMetricFromText(text: string): VascularMetric | null {
  if (/ba\s*PWV|肱踝脉搏波|臂踝脉搏波|\bPWV\b/i.test(text)) return "bapwv";
  if (/\bABI\b|踝肱指数|踝臂指数/i.test(text)) return "abi";
  return null;
}

function vascularSideFromText(text: string): VascularSide | null {
  if (/右(?:侧|踝)?/.test(text)) return "right";
  if (/左(?:侧|踝)?/.test(text)) return "left";
  return null;
}

function vascularSideValue(text: string, side: VascularSide) {
  const label = side === "right" ? "右(?:侧|踝)?" : "左(?:侧|踝)?";
  const afterSide = text.match(new RegExp(
    `${label}\\s*(?:(?:ba\\s*PWV|PWV|ABI|踝肱指数|踝臂指数)\\s*)?[:：]?\\s*(\\d+(?:\\.\\d+)?)`,
    "i"
  ));
  const beforeSide = text.match(new RegExp(
    `(?:ba\\s*PWV|PWV|ABI|踝肱指数|踝臂指数)\\s*[（(]?${side === "right" ? "右" : "左"}[）)]?\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`,
    "i"
  ));
  const value = Number(afterSide?.[1] || beforeSide?.[1]);
  return Number.isFinite(value) ? value : null;
}

function deterministicVascularObservations(plan: AiExtractionPlan, fields: AiExtractionFields) {
  const existing = new Set<string>();
  for (const observation of fields.observations) {
    const metric = vascularMetricFromText(observation.itemName);
    const side = vascularSideFromText(observation.itemName);
    if (metric && side) existing.add(`${metric}:${side}`);
  }
  const additions: AiObservation[] = [];
  const bilateralEvidence = new Set<string>();
  for (const page of plan.pages) {
    let activeMetric: VascularMetric | null = null;
    for (const line of page.lines) {
      const explicitMetric = vascularMetricFromText(line.text);
      if (explicitMetric) activeMetric = explicitMetric;
      const metric = explicitMetric || activeMetric;
      if (!metric) continue;
      const right = vascularSideValue(line.text, "right");
      const left = vascularSideValue(line.text, "left");
      if (right !== null && left !== null) bilateralEvidence.add(compactEvidence(line.text));
      for (const [side, value] of [["right", right], ["left", left]] as const) {
        if (value === null || existing.has(`${metric}:${side}`)) continue;
        if (metric === "abi" && (value < 0.2 || value > 3)) continue;
        if (metric === "bapwv" && (value < 100 || value > 5000)) continue;
        const sideLabel = side === "right" ? "右侧" : "左侧";
        const itemName = metric === "abi" ? `${sideLabel}踝肱指数` : `${sideLabel}肱踝脉搏波传导速度`;
        existing.add(`${metric}:${side}`);
        additions.push({
          sectionName: "动脉功能检查",
          itemCode: metric === "abi" ? "ABI" : "baPWV",
          itemName,
          normalizedName: itemName,
          resultText: String(value),
          numericValue: value,
          unit: metric === "bapwv" ? "cm/s" : null,
          referenceLow: null,
          referenceHigh: null,
          referenceText: null,
          abnormalFlag: null,
          method: null,
          evidence: [{ pageNumber: page.pageNumber, quote: line.text }]
        });
      }
    }
  }
  return { additions, bilateralEvidence };
}

function withDeterministicFallback(plan: AiExtractionPlan, result: AiExtractionResult) {
  const tableAdditions = deterministicTableObservations(plan).filter((local) =>
    !result.fields.observations.some((existing) =>
      (
        compactEvidence(existing.itemName) === compactEvidence(local.itemName)
        || compactEvidence(existing.normalizedName) === compactEvidence(local.normalizedName)
      )
      && compactEvidence(existing.resultText) === compactEvidence(local.resultText)
      && existing.evidence.some((entry) =>
        local.evidence.some((candidate) =>
          entry.pageNumber === candidate.pageNumber
          && compactEvidence(entry.quote) === compactEvidence(candidate.quote)
        )
      )
    )
  );
  const fieldsWithTables = {
    ...result.fields,
    observations: [...result.fields.observations, ...tableAdditions]
  };
  const basicAdditions = deterministicBasicObservations(plan, fieldsWithTables);
  const vascular = deterministicVascularObservations(plan, fieldsWithTables);
  const observations = fieldsWithTables.observations.filter((observation) => {
    if (vascularSideFromText(observation.itemName)) return true;
    if (!vascularMetricFromText(observation.itemName)) return true;
    return !observation.evidence.some((item) => vascular.bilateralEvidence.has(compactEvidence(item.quote)));
  });
  const additions = [...basicAdditions, ...vascular.additions];
  if (!additions.length && observations.length === result.fields.observations.length) return result;
  const normalized = normalizeAiExtraction({
    ...result.fields,
    observations: [...observations, ...additions],
    evidence: result.evidence,
    confidence: result.confidence
  });
  return {
    ...result,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields, evidence: normalized.evidence, confidence: normalized.confidence
    })
  };
}

function withLocalDocumentClassification(plan: AiExtractionPlan, result: AiExtractionResult) {
  const local = plan.documentClassification;
  if (local.primaryType === "other" || local.confidence < 0.5) return result;
  const anchoredCheckup = local.primaryType === "checkup"
    && local.reasons.includes("整份文档包含体检封面或总检章节");
  if (result.fields.reportType && !anchoredCheckup) return result;
  const normalized = normalizeAiExtraction({
    ...result.fields,
    reportType: local.primaryType,
    evidence: result.evidence,
    confidence: {
      ...result.confidence,
      reportType: Math.max(result.confidence.reportType || 0, local.confidence)
    }
  });
  return {
    ...result,
    ...normalized,
    rawResponseJson: JSON.stringify({
      ...normalized.fields, evidence: normalized.evidence, confidence: normalized.confidence
    })
  };
}

function updateCandidateQuality(jobId: string, plan: AiExtractionPlan, result: AiExtractionResult) {
  let unmatched = 0;
  for (const unit of plan.units.filter((item) => item.unitType !== "supplement")) {
    const candidates = unitCandidateLines(plan, unit);
    const matched = candidates.filter((item) => resultMatchesLine(result, item.line.text)).length;
    unmatched += Math.max(0, candidates.length - matched);
    getDatabase().prepare(`
      UPDATE ai_extraction_units SET candidate_count = ?, matched_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND unit_key = ?
    `).run(candidates.length, matched, jobId, unit.unitKey);
  }
  return unmatched;
}

function mergeEvidence(results: AiExtractionResult[]) {
  const merged: Record<string, AiEvidence[]> = {};
  for (const result of results) {
    for (const [key, entries] of Object.entries(result.evidence)) {
      merged[key] = uniqueBy([...(merged[key] || []), ...entries], (entry) => `${entry.pageNumber}:${entry.quote}`);
    }
  }
  return merged;
}

export function mergeAiExtractionResults(results: AiExtractionResult[]): AiExtractionResult {
  if (!results.length) throw Object.assign(new Error("AI 没有生成可合并的解析结果"), { code: "AI_EMPTY_RESULT" });
  const narrativeKeys = new Set<keyof AiExtractionFields>([
    "clinicalDiagnosis", "purpose", "chiefComplaint", "findings", "impression", "summary", "recommendation"
  ]);
  const mergedSource: Record<string, unknown> = {};
  for (const key of Object.keys(results[0].fields) as Array<keyof AiExtractionFields>) {
    if (key === "observations" || key === "morphologyFindings" || key === "bodyParts"
      || key === "identifiers" || key === "clinicians" || key === "diagnoses"
      || key === "medications" || key === "procedures" || key === "vaccinations"
      || key === "billingSummary" || key === "billingItems" || key === "reportSections") continue;
    mergedSource[key] = narrativeKeys.has(key)
      ? distinctStrings(results.map((result) => result.fields[key] as string | null)).join("\n") || null
      : pickField(results, key);
  }
  mergedSource.bodyParts = uniqueBy(results.flatMap((result) => result.fields.bodyParts), (item) =>
    [item.raw, item.name, item.parent, item.laterality].join("\u0000").toLocaleLowerCase("zh-CN")
  );
  mergedSource.identifiers = Object.assign({}, ...results.map((result) => result.fields.identifiers));
  mergedSource.clinicians = Object.assign({}, ...results.map((result) => result.fields.clinicians));
  mergedSource.observations = uniqueBy(results.flatMap((result) => result.fields.observations), observationKey);
  mergedSource.morphologyFindings = uniqueBy(results.flatMap((result) => result.fields.morphologyFindings), morphologyKey);
  mergedSource.diagnoses = uniqueBy(results.flatMap((result) => result.fields.diagnoses), (item) =>
    [item.diagnosisType, compactEvidence(item.diagnosisText), item.diagnosisCode || ""].join("\u0000")
  );
  mergedSource.medications = uniqueBy(results.flatMap((result) => result.fields.medications), (item) =>
    [item.context, compactEvidence(item.medicationName), compactEvidence(item.specification || ""),
      compactEvidence(item.dose || ""), compactEvidence(item.frequency || ""), compactEvidence(item.route || "")]
      .join("\u0000")
  );
  mergedSource.procedures = uniqueBy(results.flatMap((result) => result.fields.procedures), (item) =>
    [item.procedureType, compactEvidence(item.procedureName), item.performedAt || "",
      compactEvidence(item.bodyPart || "")].join("\u0000")
  );
  mergedSource.vaccinations = uniqueBy(results.flatMap((result) => result.fields.vaccinations), (item) =>
    [compactEvidence(item.vaccineName), item.doseNumber || "", item.administeredAt || "",
      item.lotNumber || ""].join("\u0000")
  );
  const billingSummaries = results.flatMap((result) =>
    result.fields.billingSummary ? [result.fields.billingSummary] : []
  );
  mergedSource.billingSummary = billingSummaries.length ? {
    invoiceNumber: billingSummaries.find((item) => item.invoiceNumber)?.invoiceNumber || null,
    totalAmount: billingSummaries.find((item) => item.totalAmount !== null)?.totalAmount ?? null,
    insuranceAmount: billingSummaries.find((item) => item.insuranceAmount !== null)?.insuranceAmount ?? null,
    selfPayAmount: billingSummaries.find((item) => item.selfPayAmount !== null)?.selfPayAmount ?? null,
    currency: billingSummaries.find((item) => item.currency)?.currency || "CNY",
    evidence: uniqueBy(billingSummaries.flatMap((item) => item.evidence),
      (entry) => `${entry.pageNumber}:${compactEvidence(entry.quote)}`)
  } : null;
  mergedSource.billingItems = uniqueBy(results.flatMap((result) => result.fields.billingItems), (item) =>
    [compactEvidence(item.itemName), compactEvidence(item.category || ""),
      item.amount === null ? "" : String(item.amount), item.quantity === null ? "" : String(item.quantity)]
      .join("\u0000")
  );
  mergedSource.reportSections = [...results
    .flatMap((result) => result.fields.reportSections)
    .reduce((sections, item) => {
      const existing = sections.get(item.sectionKey);
      if (!existing) {
        sections.set(item.sectionKey, { ...item, evidence: [...item.evidence] });
        return sections;
      }
      const contents = distinctStrings([existing.content, item.content]);
      existing.content = contents.join("\n");
      existing.evidence = uniqueBy(
        [...existing.evidence, ...item.evidence],
        (entry) => `${entry.pageNumber}:${compactEvidence(entry.quote)}`
      );
      return sections;
    }, new Map<string, AiExtractionResult["fields"]["reportSections"][number]>())
    .values()];
  const evidence = mergeEvidence(results);
  const confidenceKeys = [...new Set(results.flatMap((result) => Object.keys(result.confidence)))];
  const confidence = Object.fromEntries(confidenceKeys
    .map((key) => [key, Math.max(...results.map((result) => result.confidence[key] ?? 0))]));
  const normalized = normalizeAiExtraction({ ...mergedSource, evidence, confidence });
  return {
    provider: results[0].provider,
    model: results[0].model,
    promptVersion: aiExtractionPromptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify({ ...normalized.fields, evidence: normalized.evidence, confidence: normalized.confidence }),
    promptTokens: results.some((result) => result.promptTokens !== null)
      ? results.reduce((sum, result) => sum + (result.promptTokens || 0), 0) : null,
    completionTokens: results.some((result) => result.completionTokens !== null)
      ? results.reduce((sum, result) => sum + (result.completionTokens || 0), 0) : null,
    elapsedMs: results.reduce((sum, result) => sum + result.elapsedMs, 0),
    evidenceValidation: {
      rejectedObservations: results.reduce((sum, result) =>
        sum + (result.evidenceValidation?.rejectedObservations || 0), 0),
      rejectedMorphologyFindings: results.reduce((sum, result) =>
        sum + (result.evidenceValidation?.rejectedMorphologyFindings || 0), 0),
      rejectedClinicalFacts: results.reduce((sum, result) =>
        sum + (result.evidenceValidation?.rejectedClinicalFacts || 0), 0),
      rejectedStructuredSections: results.reduce((sum, result) =>
        sum + (result.evidenceValidation?.rejectedStructuredSections || 0), 0)
    }
  };
}

async function executeUnit(
  jobId: string,
  reportId: string,
  plan: AiExtractionPlan,
  unit: AiExtractionUnit,
  row: UnitRow,
  executor: AiExecutor,
  options: ExecuteOptions
) {
  const stored = parseStoredResult(row);
  if (
    stored
    && row.inputHash === unit.inputHash
    && row.promptVersion === aiExtractionPromptVersion
    && stored.promptVersion === aiExtractionPromptVersion
  ) return stored;

  const run = async (
    attemptType: "main" | "format_retry" | "supplement",
    outputTokenScale = 1
  ) => {
    startUnit(row);
    const input = inputForUnit(
      reportId,
      plan,
      unit,
      attemptType === "format_retry" ? "json_retry" : attemptType === "supplement" ? "supplement" : "standard"
    );
    input.outputTokenScale = outputTokenScale;
    options.onEvent?.({
      type: attemptType === "format_retry" ? "format_retry" : "unit_started",
      message: attemptType === "format_retry"
        ? "AI 返回格式无效，正在按严格 JSON 重试"
        : attemptType === "supplement"
          ? `AI 补提取第 ${unit.pageNumbers.join("、")} 页遗漏候选`
          : `AI 整理单元 ${row.unitIndex + 1}/${plan.unitCount}`,
      detail: { unitKey: unit.unitKey, unitIndex: row.unitIndex, unitType: unit.unitType,
        route: unit.route,
        pageNumbers: unit.pageNumbers, characterCount: unit.characterCount, candidateCount: unit.candidateRowCount,
        morphologyCandidateCount: unit.morphologyCandidateCount,
        primaryContentType: unit.classification.primaryType,
        contentTypes: unit.classification.contentTypes,
        classificationConfidence: unit.classification.confidence,
        estimatedOutputTokens: unit.estimatedOutputTokens,
        attemptType, unitAttempt: row.attempts, outputTokenScale }
    });
    try {
      const result = validateResultEvidence(plan, unit, await executor(input));
      recordAttempt(row, jobId, reportId, attemptType, unit.characterCount, result);
      return result;
    } catch (error) {
      recordAttempt(row, jobId, reportId, attemptType, unit.characterCount, null, error);
      throw error;
    }
  };

  const splitAndRun = async (cause: unknown) => {
    const children = splitAiExtractionUnit(plan, unit);
    if (children.length < 2) throw cause;
    options.onEvent?.({
      type: "unit_split",
      message: `AI 输出仍超限，已将第 ${unit.pageNumbers.join("、")} 页当前单元拆分后继续处理`,
      detail: {
        unitKey: unit.unitKey,
        pageNumbers: unit.pageNumbers,
        childUnits: children.map((child) => ({
          unitKey: child.unitKey,
          pageNumbers: child.pageNumbers,
          characterCount: child.characterCount,
          candidateCount: child.candidateRowCount,
          estimatedOutputTokens: child.estimatedOutputTokens
        }))
      }
    });
    const childResults = await mapConcurrent(children, async (child, childIndex) => {
      const childRow = syncDynamicUnit(
        jobId, reportId, plan, child, row.unitIndex * 1_000 + childIndex + 1
      );
      return executeUnit(jobId, reportId, plan, child, childRow, executor, options);
    }, { stopOnError: true });
    return mergeAiExtractionResults(childResults);
  };

  const recover = async (
    error: unknown,
    outputTokenScale: number,
    allowFormatRetry: boolean
  ): Promise<AiExtractionResult> => {
    const code = errorDetails(error).code;
    if (code === "AI_INVALID_JSON" && allowFormatRetry) {
      try {
        return await run("format_retry", outputTokenScale);
      } catch (retryError) {
        return recover(retryError, outputTokenScale, false);
      }
    }
    if (code === "AI_OUTPUT_TRUNCATED") {
      const truncation = error as { requestedMaxTokens?: number; modelMaxOutputTokens?: number };
      const canRaise = outputTokenScale < 2 && (
        !truncation.requestedMaxTokens
        || !truncation.modelMaxOutputTokens
        || truncation.requestedMaxTokens < truncation.modelMaxOutputTokens
      );
      if (canRaise) {
        options.onEvent?.({
          type: "output_retry",
          message: "AI 输出达到当前预算，正在扩大输出空间重试当前单元",
          detail: {
            unitKey: unit.unitKey,
            pageNumbers: unit.pageNumbers,
            previousMaxTokens: truncation.requestedMaxTokens || null,
            modelMaxOutputTokens: truncation.modelMaxOutputTokens || null,
            outputTokenScale: 2
          }
        });
        try {
          return await run(unit.unitType === "supplement" ? "supplement" : "main", 2);
        } catch (retryError) {
          return recover(retryError, 2, true);
        }
      }
      return splitAndRun(error);
    }
    throw error;
  };

  let result: AiExtractionResult;
  try {
    result = await run(unit.unitType === "supplement" ? "supplement" : "main");
  } catch (error) {
    try {
      result = await recover(error, 1, true);
    } catch (finalError) {
      failUnit(row, finalError);
      options.onEvent?.({ type: "unit_failed", message: errorDetails(finalError).message,
        detail: { unitKey: unit.unitKey, pageNumbers: unit.pageNumbers, ...errorDetails(finalError) } });
      throw finalError;
    }
  }
  completeUnit(row, result);
  options.onEvent?.({
    type: "unit_completed",
    message: `AI 整理单元 ${row.unitIndex + 1}/${plan.unitCount} 完成`,
    detail: { unitKey: unit.unitKey, unitIndex: row.unitIndex, pageNumbers: unit.pageNumbers,
      extractionMode: unit.extractionMode,
      route: unit.route,
      primaryContentType: unit.classification.primaryType,
      contentTypes: unit.classification.contentTypes,
      promptTokens: result.promptTokens, completionTokens: result.completionTokens, elapsedMs: result.elapsedMs,
      rejectedObservations: result.evidenceValidation?.rejectedObservations || 0,
      rejectedMorphologyFindings: result.evidenceValidation?.rejectedMorphologyFindings || 0,
      rejectedClinicalFacts: result.evidenceValidation?.rejectedClinicalFacts || 0,
      rejectedStructuredSections: result.evidenceValidation?.rejectedStructuredSections || 0 }
  });
  return result;
}

export async function executeAiExtractionPlan(
  jobId: string,
  reportId: string,
  executor: AiExecutor,
  options: ExecuteOptions = {}
) {
  const plan = buildAiExtractionPlan(reportId);
  const rows = syncPlanUnits(jobId, reportId, plan);
  const results = await mapConcurrent(plan.units, async (unit) => {
    if (options.shouldContinue && !options.shouldContinue()) {
      throw Object.assign(new Error("报告任务已取消"), { code: "AI_TASK_CANCELLED" });
    }
    const row = rows.get(unit.unitKey);
    if (!row) throw new Error(`AI 解析单元未持久化：${unit.unitKey}`);
    return executeUnit(jobId, reportId, plan, unit, row, executor, options);
  }, { stopOnError: true });
  let merged = withLocalDocumentClassification(plan, withDeterministicFallback(
    plan,
    withSourceDeduplication(plan, mergeAiExtractionResults(results))
  ));
  const supplements = supplementUnits(plan, merged);
  let effectivePlan = plan;
  if (supplements.length) {
    const units = [...plan.units, ...supplements];
    effectivePlan = {
      ...plan,
      units,
      unitCount: units.length,
      planHash: createHash("sha256").update(units.map((unit) => `${unit.unitKey}:${unit.inputHash}`).join("|")).digest("hex")
    };
    const supplementRows = syncPlanUnits(jobId, reportId, effectivePlan);
    const supplementResults = await mapConcurrent(supplements, async (unit) => {
      if (options.shouldContinue && !options.shouldContinue()) {
        throw Object.assign(new Error("报告任务已取消"), { code: "AI_TASK_CANCELLED" });
      }
      const row = supplementRows.get(unit.unitKey);
      if (!row) return null;
      try {
        return await executeUnit(jobId, reportId, effectivePlan, unit, row, executor, options);
      } catch (error) {
        const failure = errorDetails(error);
        getDatabase().prepare(`
          UPDATE ai_extraction_units SET status = 'warning', error_code = ?, error_message = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(failure.code, failure.message, row.id);
        return null;
      }
    }, { stopOnError: true });
    results.push(...supplementResults.filter((result): result is AiExtractionResult => result !== null));
    merged = withLocalDocumentClassification(plan, withDeterministicFallback(
      plan,
      withSourceDeduplication(plan, mergeAiExtractionResults(results))
    ));
  }
  const unmatchedCandidates = updateCandidateQuality(jobId, plan, merged);
  let warningUnits = results.filter((result) =>
    Boolean(
      (result.evidenceValidation?.rejectedObservations || 0)
      + (result.evidenceValidation?.rejectedMorphologyFindings || 0)
      + (result.evidenceValidation?.rejectedClinicalFacts || 0)
      + (result.evidenceValidation?.rejectedStructuredSections || 0)
    )
  ).length;
  for (const unit of supplements) {
    const unresolved = unitCandidateLines(plan, unit)
      .filter((item) => !resultMatchesLine(merged, item.line.text)).length;
    if (!unresolved) continue;
    warningUnits += 1;
    getDatabase().prepare(`
      UPDATE ai_extraction_units SET status = 'warning',
        error_code = COALESCE(error_code, 'AI_UNMATCHED_CANDIDATES'),
        error_message = COALESCE(error_message, ?), updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND unit_key = ?
    `).run(`补提取后仍有 ${unresolved} 个候选行待核对`, jobId, unit.unitKey);
  }
  return {
    plan: effectivePlan,
    result: merged,
    inputCharacters: effectivePlan.units.reduce((sum, unit) => sum + unit.characterCount, 0),
    unmatchedCandidates,
    warningUnits
  };
}
