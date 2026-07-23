import { getDatabase } from "../database/client";
import { builtinIndicators, builtinIndicatorVersion, type BuiltinIndicator } from "../domain/indicator-dictionary/builtin-indicators";
import { createId } from "../utils/identifier";
import type { RequestUser } from "../domain/request-user";
import { createError } from "h3";
import { getAiSettings } from "./ai-settings.service";

const normalizationVersion = `indicator-normalization-${builtinIndicatorVersion}`;
const aiNormalizationPromptVersion = "indicator-normalization-ai-v1";
const maxAiFallbackItems = 50;

type ObservationRow = {
  id: string;
  reportId: string;
  sectionName: string | null;
  itemCode: string | null;
  itemName: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceText: string | null;
  reportType: string;
  hospitalName: string | null;
  performingDepartment: string | null;
  reportingDepartment: string | null;
};

type IndicatorRow = {
  id: string;
  canonicalKey: string;
  displayName: string;
  category: string;
  specimen: string | null;
  defaultUnit: string | null;
  valueType: "numeric" | "text" | "positive_negative";
  trendEnabled: number;
  explanation: string | null;
};

type AliasRow = {
  indicatorId: string;
  canonicalKey: string;
  displayName: string;
  category: string;
  specimen: string | null;
  defaultUnit: string | null;
  valueType: "numeric" | "text" | "positive_negative";
  trendEnabled: number;
  explanation: string | null;
  aliasName: string;
  normalizedAlias: string;
  scope: string;
  confidence: number;
};

export type NormalizationResult = {
  observationId: string;
  indicatorId: string | null;
  canonicalKey: string | null;
  canonicalName: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  confidence: number;
  quality: "high" | "medium" | "low" | "excluded";
  matchedBy: string;
  matchReason: string;
  excludedReason: string | null;
};

export type IndicatorNormalizationMaintenanceResult = {
  scanned: number;
  normalized: number;
  high: number;
  medium: number;
  low: number;
  excluded: number;
  unknown: number;
  ai?: {
    reports: number;
    suggested: number;
    applied: number;
    skipped: number;
    failed: number;
  };
};

export type IndicatorNormalizationIssue = {
  rawName: string;
  normalizedName: string | null;
  unit: string | null;
  sectionName: string | null;
  hospitalName: string | null;
  status: "unknown" | "low" | "excluded";
  reason: string;
  count: number;
  latestReportIssuedAt: string | null;
};

export type AiIndicatorCandidate = {
  observationId: string;
  canonicalName: string | null;
  category: string | null;
  valueType: "numeric" | "text" | "positive_negative" | null;
  trendEnabled: boolean | null;
  canonicalUnit: string | null;
  canonicalValue: number | null;
  confidence: number | null;
  reason: string | null;
};

export type AiIndicatorNormalizationResult = {
  provider: string;
  model: string;
  promptVersion: string;
  candidates: AiIndicatorCandidate[];
  rawResponseJson: string;
  promptTokens: number | null;
  completionTokens: number | null;
  elapsedMs: number;
};

export type AiIndicatorNormalizationInput = {
  reportId: string;
  reportType: string;
  hospitalName: string | null;
  items: Array<{
    observationId: string;
    sectionName: string | null;
    itemName: string;
    normalizedName: string | null;
    resultText: string;
    numericValue: number | null;
    unit: string | null;
    referenceText: string | null;
  }>;
};

export type AiIndicatorExecutor = (input: AiIndicatorNormalizationInput) => Promise<AiIndicatorNormalizationResult>;

function compactIndicatorKey(value: string | null | undefined) {
  return (value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/\s+/g, "")
    .replace(/[：:，,。.;；、_\-]/g, "")
    .replace(/[＋]/g, "+")
    .trim();
}

function normalizeUnit(value: string | null | undefined) {
  if (!value) return null;
  const unit = value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[／⁄]/g, "/")
    .replace(/[×xX*]/g, "×")
    .replace(/[μµ]/g, "μ")
    .replace(/﹪/g, "%");
  const lower = unit.toLocaleLowerCase();
  const aliases: Record<string, string> = {
    "mmol/l": "mmol/L",
    "μmol/l": "μmol/L",
    "umol/l": "μmol/L",
    "mg/dl": "mg/dL",
    "mg/l": "mg/L",
    "g/l": "g/L",
    "g/dl": "g/dL",
    "u/l": "U/L",
    "iu/l": "U/L",
    "miu/l": "mIU/L",
    "uiu/ml": "μIU/mL",
    "μiu/ml": "μIU/mL",
    "pmol/l": "pmol/L",
    "pg/ml": "pg/mL",
    "ng/dl": "ng/dL",
    "meq/l": "mEq/L",
    "iu/ml": "IU/mL",
    "copies/ml": "copies/mL",
    "kg/m2": "kg/m²",
    "kg/m²": "kg/m²",
    "kg/㎡": "kg/m²",
    "cm": "cm",
    "mm": "mm",
    "10^9/l": "10^9/L",
    "10*9/l": "10^9/L",
    "×10^9/l": "10^9/L",
    "10^12/l": "10^12/L",
    "10*12/l": "10^12/L",
    "×10^12/l": "10^12/L",
    "10^3/μl": "10^3/μL",
    "10^6/μl": "10^6/μL",
    "%": "%"
  };
  return aliases[lower] || unit || null;
}

function parseNumericResultText(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").replace(/[<>≤≥]/g, " ");
  const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function textValue(value: unknown, maxLength = 400) {
  if (typeof value !== "string") return null;
  const clean = value.trim().slice(0, maxLength);
  return clean || null;
}

function boolValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === "string") {
    const clean = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(clean)) return true;
    if (["false", "no", "0"].includes(clean)) return false;
  }
  return null;
}

function aiCanonicalKey(candidate: AiIndicatorCandidate) {
  const name = compactIndicatorKey(candidate.canonicalName);
  const valueType = candidate.valueType || "text";
  return name ? `ai:${valueType}:${name}` : null;
}

function textHasAny(value: string, hints: string[]) {
  const compact = compactIndicatorKey(value);
  return hints.some((hint) => compact.includes(compactIndicatorKey(hint)));
}

function allowedUnitsFor(indicator: BuiltinIndicator | null, row: IndicatorRow | AliasRow) {
  const builtin = indicator || builtinIndicators.find((item) => item.canonicalKey === row.canonicalKey) || null;
  return new Set((builtin?.allowedUnits || []).map((unit) => normalizeUnit(unit)).filter(Boolean));
}

function convertUnit(canonicalKey: string, value: number, fromUnit: string | null, toUnit: string | null) {
  if (value === null || !fromUnit || !toUnit || fromUnit === toUnit) return value;
  const lipidKeys = new Set(["lipid_tc", "lipid_hdl_c", "lipid_ldl_c"]);
  if (lipidKeys.has(canonicalKey) && fromUnit === "mg/dL" && toUnit === "mmol/L") return value / 38.67;
  if (lipidKeys.has(canonicalKey) && fromUnit === "mmol/L" && toUnit === "mg/dL") return value * 38.67;
  if (canonicalKey === "lipid_tg" && fromUnit === "mg/dL" && toUnit === "mmol/L") return value / 88.57;
  if (canonicalKey === "lipid_tg" && fromUnit === "mmol/L" && toUnit === "mg/dL") return value * 88.57;
  if (canonicalKey === "glucose_fasting" && fromUnit === "mg/dL" && toUnit === "mmol/L") return value / 18.018;
  if (canonicalKey === "glucose_fasting" && fromUnit === "mmol/L" && toUnit === "mg/dL") return value * 18.018;
  if (canonicalKey === "cbc_hgb" && fromUnit === "g/dL" && toUnit === "g/L") return value * 10;
  if (canonicalKey === "cbc_hgb" && fromUnit === "g/L" && toUnit === "g/dL") return value / 10;
  if (fromUnit === "cm" && toUnit === "mm") return value * 10;
  if (fromUnit === "mm" && toUnit === "cm") return value / 10;
  return value;
}

function classifyQuality(score: number, row: ObservationRow, indicator: AliasRow): NormalizationResult["quality"] {
  if (!indicator.trendEnabled || indicator.valueType !== "numeric") return "excluded";
  const numericValue = row.numericValue ?? parseNumericResultText(row.resultText);
  if (numericValue === null) return "excluded";
  if (score >= 90) return "high";
  if (score >= 65) return "medium";
  return "low";
}

function exclusionReason(row: ObservationRow, indicator: AliasRow, unitCompatible: boolean) {
  if (!indicator.trendEnabled) return "该指标属于状态型或文本型结果，不默认进入折线趋势";
  if (indicator.valueType !== "numeric") return "该指标不是数值型结果，不默认进入折线趋势";
  if ((row.numericValue ?? parseNumericResultText(row.resultText)) === null) return "没有可靠数值";
  if (!unitCompatible) return "单位与标准指标不兼容";
  return null;
}

export function ensureBuiltinIndicatorCatalog() {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const upsertIndicator = db.prepare(`
      INSERT INTO indicator_catalog (
        id, canonical_key, display_name, category, specimen, default_unit, value_type,
        trend_enabled, explanation, source, builtin_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'builtin', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(canonical_key) DO UPDATE SET
        display_name = excluded.display_name,
        category = excluded.category,
        specimen = excluded.specimen,
        default_unit = excluded.default_unit,
        value_type = excluded.value_type,
        trend_enabled = excluded.trend_enabled,
        explanation = excluded.explanation,
        builtin_version = excluded.builtin_version,
        updated_at = CURRENT_TIMESTAMP
    `);
    const upsertAlias = db.prepare(`
      INSERT INTO indicator_aliases (
        id, indicator_id, alias_name, normalized_alias, scope, source, confidence, enabled, updated_at
      ) VALUES (?, ?, ?, ?, 'global', 'builtin', 1, 1, CURRENT_TIMESTAMP)
    `);
    const existingAlias = db.prepare(`
      SELECT id FROM indicator_aliases WHERE indicator_id = ? AND normalized_alias = ? AND scope = 'global' LIMIT 1
    `);
    for (const indicator of builtinIndicators) {
      const existing = db.prepare("SELECT id FROM indicator_catalog WHERE canonical_key = ?").get(indicator.canonicalKey) as { id: string } | undefined;
      const indicatorId = existing?.id || createId("indicator");
      upsertIndicator.run(
        indicatorId,
        indicator.canonicalKey,
        indicator.displayName,
        indicator.category,
        indicator.specimen,
        indicator.defaultUnit,
        indicator.valueType,
        indicator.trendEnabled ? 1 : 0,
        indicator.explanation,
        builtinIndicatorVersion
      );
      for (const alias of new Set([indicator.displayName, ...indicator.aliases])) {
        const normalizedAlias = compactIndicatorKey(alias);
        if (!normalizedAlias) continue;
        if (existingAlias.get(indicatorId, normalizedAlias)) continue;
        upsertAlias.run(createId("alias"), indicatorId, alias, normalizedAlias);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function candidateAliases(row: ObservationRow) {
  const baseNames = [
    row.normalizedName,
    row.itemName,
    row.itemCode,
    `${row.itemName}${row.itemCode || ""}`,
    `${row.normalizedName || ""}${row.itemCode || ""}`
  ];
  const names = new Set(baseNames.map(compactIndicatorKey).filter(Boolean));
  for (const name of [...names]) {
    const withoutTirads = name
      .replace(/c?tirads\d+[a-z]?类?/gi, "")
      .replace(/甲状腺影像报告和数据系统\d+[a-z]?类?/g, "");
    if (withoutTirads && withoutTirads !== name) names.add(withoutTirads);
  }
  if (!names.size) return [];
  const placeholders = [...names].map(() => "?").join(",");
  return getDatabase().prepare(`
    SELECT a.indicator_id AS indicatorId, c.canonical_key AS canonicalKey, c.display_name AS displayName,
      c.category, c.specimen, c.default_unit AS defaultUnit, c.value_type AS valueType,
      c.trend_enabled AS trendEnabled, c.explanation, a.alias_name AS aliasName,
      a.normalized_alias AS normalizedAlias, a.scope, a.confidence
    FROM indicator_aliases a
    JOIN indicator_catalog c ON c.id = a.indicator_id
    WHERE a.enabled = 1 AND a.normalized_alias IN (${placeholders})
  `).all(...names) as AliasRow[];
}

export function normalizeObservation(row: ObservationRow): NormalizationResult {
  ensureBuiltinIndicatorCatalog();
  const aliases = candidateAliases(row);
  if (!aliases.length) {
    return {
      observationId: row.id,
      indicatorId: null,
      canonicalKey: null,
      canonicalName: null,
      canonicalValue: null,
      canonicalUnit: null,
      confidence: 0,
      quality: "low",
      matchedBy: "none",
      matchReason: "未命中内置指标字典",
      excludedReason: "未命中内置指标字典"
    };
  }

  let best: { alias: AliasRow; score: number; reasons: string[]; unitCompatible: boolean } | null = null;
  const rawUnit = normalizeUnit(row.unit);
  const context = [row.sectionName, row.reportType, row.performingDepartment, row.reportingDepartment].filter(Boolean).join(" ");
  for (const alias of aliases) {
    const builtin = builtinIndicators.find((item) => item.canonicalKey === alias.canonicalKey) || null;
    const allowedUnits = allowedUnitsFor(builtin, alias);
    const unitCompatible = !rawUnit || allowedUnits.size === 0 || allowedUnits.has(rawUnit) || rawUnit === normalizeUnit(alias.defaultUnit);
    const hasSectionHint = builtin ? textHasAny(context, builtin.sectionHints) : false;
    let score = 55;
    const reasons = [`名称命中「${alias.aliasName}」`];
    if (alias.scope !== "global") {
      score += 15;
      reasons.push("机构/上下文规则命中");
    }
    if (rawUnit && unitCompatible) {
      score += 25;
      reasons.push(`单位兼容「${rawUnit}」`);
    } else if (rawUnit && !unitCompatible) {
      score -= 55;
      reasons.push(`单位不兼容「${rawUnit}」`);
    }
    if (hasSectionHint) {
      score += 15;
      reasons.push(`报告章节匹配「${alias.category}」`);
    }
    if (alias.canonicalKey === "glucose_fasting" && /尿|尿常规|尿液/i.test(context + row.itemName + (row.normalizedName || ""))) {
      score -= 80;
      reasons.push("尿液上下文不归入血糖趋势");
    }
    if (alias.canonicalKey === "renal_uric_acid" && /尿常规|尿液/i.test(context)) {
      score -= 35;
      reasons.push("尿液上下文降低置信度");
    }
    if (!best || score > best.score) best = { alias, score, reasons, unitCompatible };
  }

  const selected = best!;
  const numericValue = row.numericValue ?? parseNumericResultText(row.resultText);
  const quality = classifyQuality(selected.score, row, selected.alias);
  const canonicalUnit = normalizeUnit(selected.alias.defaultUnit) || rawUnit;
  const canonicalValue = numericValue === null ? null : convertUnit(selected.alias.canonicalKey, numericValue, rawUnit, canonicalUnit);
  const excludedReason = quality === "excluded" ? exclusionReason(row, selected.alias, selected.unitCompatible) : null;
  return {
    observationId: row.id,
    indicatorId: selected.alias.indicatorId,
    canonicalKey: selected.alias.canonicalKey,
    canonicalName: selected.alias.displayName,
    canonicalValue,
    canonicalUnit,
    confidence: Math.max(0, Math.min(1, selected.score / 100)),
    quality,
    matchedBy: selected.alias.scope === "global" ? "builtin_alias" : `${selected.alias.scope}_alias`,
    matchReason: selected.reasons.join("；"),
    excludedReason
  };
}

function indicatorAiSystemPrompt() {
  return `你是健康报告指标归一化助手，只能基于输入里的指标事实做命名归一化，不得诊断、不得解释疾病风险、不得生成治疗建议。
返回 JSON 对象，不要 Markdown，格式为：
{"candidates":[{"observationId":"原ID","canonicalName":"标准名称或null","category":"分类或null","valueType":"numeric|text|positive_negative","trendEnabled":true/false,"canonicalUnit":"标准单位或null","canonicalValue":数值或null,"confidence":0到1,"reason":"简短依据"}]}
规则：
1. observationId 必须原样来自输入，不能新增 ID。
2. 只有明确是单一数值指标时 valueType=numeric 且 trendEnabled=true，例如 BMI、尿酸、内膜厚度、病毒核酸定量。
3. 影像/超声/心电/耳鼻喉的文字发现、定性筛查、阳性发现、分级描述，valueType 应为 text 或 positive_negative，trendEnabled=false。
4. canonicalName 使用中文常用医学报告名称，去掉左右侧、程度、分级、括号里的“定性”等修饰，保留指标本体。
5. 如果无法确定标准名称，canonicalName=null，confidence 不高于 0.5。
6. 不输出姓名、身份证、电话、住址。`;
}

function parseAiJsonContent(content: string) {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(clean) as unknown;
}

function normalizeAiIndicatorCandidates(value: unknown, allowedIds: Set<string>): AiIndicatorCandidate[] {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rows = Array.isArray(source.candidates) ? source.candidates : [];
  return rows.slice(0, maxAiFallbackItems).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const observationId = textValue(row.observationId, 120);
    if (!observationId || !allowedIds.has(observationId)) return [];
    const valueType = textValue(row.valueType, 40);
    const canonicalName = textValue(row.canonicalName, 120);
    const confidence = numberValue(row.confidence);
    return [{
      observationId,
      canonicalName,
      category: textValue(row.category, 80),
      valueType: valueType && ["numeric", "text", "positive_negative"].includes(valueType)
        ? valueType as AiIndicatorCandidate["valueType"]
        : null,
      trendEnabled: boolValue(row.trendEnabled),
      canonicalUnit: textValue(row.canonicalUnit, 60),
      canonicalValue: numberValue(row.canonicalValue),
      confidence: confidence === null ? null : Math.max(0, Math.min(1, confidence)),
      reason: textValue(row.reason, 300)
    }];
  });
}

export const requestAiIndicatorNormalization: AiIndicatorExecutor = async (input) => {
  const settings = getAiSettings(true);
  if (!settings.enabled || !settings.apiKey || !settings.textModel) {
    throw Object.assign(new Error("AI 解析尚未完整配置"), { code: "AI_NOT_CONFIGURED" });
  }
  const started = Date.now();
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: settings.textModel,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: indicatorAiSystemPrompt() },
        { role: "user", content: JSON.stringify(input) }
      ]
    })
  });
  if (!response.ok) throw Object.assign(new Error(`AI 指标归一化返回 ${response.status}`), { code: `AI_NORMALIZE_HTTP_${response.status}` });
  const payload = await response.json() as {
    model?: string;
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const contentValue = payload.choices?.[0]?.message?.content;
  const content = typeof contentValue === "string"
    ? contentValue
    : Array.isArray(contentValue) ? contentValue.map((part) => part.text || "").join("") : "";
  if (!content) throw Object.assign(new Error("AI 指标归一化未返回内容"), { code: "AI_NORMALIZE_EMPTY_RESPONSE" });
  let parsed: unknown;
  try { parsed = parseAiJsonContent(content); }
  catch { throw Object.assign(new Error("AI 指标归一化返回内容不是有效 JSON"), { code: "AI_NORMALIZE_INVALID_JSON" }); }
  const candidates = normalizeAiIndicatorCandidates(parsed, new Set(input.items.map((item) => item.observationId)));
  return {
    provider: new URL(settings.baseUrl).host,
    model: payload.model || settings.textModel,
    promptVersion: aiNormalizationPromptVersion,
    candidates,
    rawResponseJson: JSON.stringify({ candidates }),
    promptTokens: numberValue(payload.usage?.prompt_tokens),
    completionTokens: numberValue(payload.usage?.completion_tokens),
    elapsedMs: Date.now() - started
  };
};

function upsertNormalization(result: NormalizationResult) {
  getDatabase().prepare(`
    INSERT INTO observation_normalizations (
      observation_id, indicator_id, canonical_key, canonical_name, canonical_value, canonical_unit,
      confidence, quality, matched_by, match_reason, excluded_reason, version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(observation_id) DO UPDATE SET
      indicator_id = excluded.indicator_id,
      canonical_key = excluded.canonical_key,
      canonical_name = excluded.canonical_name,
      canonical_value = excluded.canonical_value,
      canonical_unit = excluded.canonical_unit,
      confidence = excluded.confidence,
      quality = excluded.quality,
      matched_by = excluded.matched_by,
      match_reason = excluded.match_reason,
      excluded_reason = excluded.excluded_reason,
      version = excluded.version,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    result.observationId,
    result.indicatorId,
    result.canonicalKey,
    result.canonicalName,
    result.canonicalValue,
    result.canonicalUnit,
    result.confidence,
    result.quality,
    result.matchedBy,
    result.matchReason,
    result.excludedReason,
    normalizationVersion
  );
}

function observationRowsForReport(reportId: string) {
  return getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_text AS referenceText,
      r.report_type AS reportType, r.hospital_name_raw AS hospitalName,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    WHERE o.report_id = ?
  `).all(reportId) as ObservationRow[];
}

function pendingObservationRowsForReport(reportId: string) {
  return getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_text AS referenceText,
      r.report_type AS reportType, r.hospital_name_raw AS hospitalName,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE o.report_id = ?
      AND (n.observation_id IS NULL OR n.canonical_key IS NULL)
  `).all(reportId) as ObservationRow[];
}

function createEmptyMaintenanceResult(): IndicatorNormalizationMaintenanceResult {
  return {
    scanned: 0,
    normalized: 0,
    high: 0,
    medium: 0,
    low: 0,
    excluded: 0,
    unknown: 0
  };
}

function collectNormalizationResult(rows: ObservationRow[]): IndicatorNormalizationMaintenanceResult {
  const result = createEmptyMaintenanceResult();
  result.scanned = rows.length;
  for (const row of rows) {
    const normalized = normalizeObservation(row);
    upsertNormalization(normalized);
    result[normalized.quality] += 1;
    if (!normalized.canonicalKey) result.unknown += 1;
    if (normalized.canonicalKey && ["high", "medium"].includes(normalized.quality)) result.normalized += 1;
  }
  return result;
}

function addMaintenanceResult(
  total: IndicatorNormalizationMaintenanceResult,
  partial: Pick<IndicatorNormalizationMaintenanceResult, "scanned" | "normalized" | "high" | "medium" | "low" | "excluded" | "unknown">
) {
  total.scanned += partial.scanned;
  total.normalized += partial.normalized;
  total.high += partial.high;
  total.medium += partial.medium;
  total.low += partial.low;
  total.excluded += partial.excluded;
  total.unknown += partial.unknown;
}

export function normalizeReportObservations(reportId: string): IndicatorNormalizationMaintenanceResult {
  return collectNormalizationResult(observationRowsForReport(reportId));
}

function normalizePendingReportObservations(reportId: string): IndicatorNormalizationMaintenanceResult {
  return collectNormalizationResult(pendingObservationRowsForReport(reportId));
}

function fallbackQuality(row: ObservationRow, candidate: AiIndicatorCandidate): NormalizationResult["quality"] {
  const confidence = candidate.confidence ?? 0;
  const valueType = candidate.valueType || "text";
  if (candidate.trendEnabled !== true || valueType !== "numeric") return "excluded";
  const numericValue = candidate.canonicalValue ?? row.numericValue ?? parseNumericResultText(row.resultText);
  if (numericValue === null) return "excluded";
  if (confidence >= 0.92) return "high";
  if (confidence >= 0.86) return "medium";
  return "low";
}

function fallbackExcludedReason(row: ObservationRow, candidate: AiIndicatorCandidate) {
  const valueType = candidate.valueType || "text";
  if (candidate.trendEnabled !== true) return "AI 判断该项目不适合进入折线趋势";
  if (valueType !== "numeric") return "AI 判断该项目不是单一数值指标";
  const numericValue = candidate.canonicalValue ?? row.numericValue ?? parseNumericResultText(row.resultText);
  if (numericValue === null) return "没有可靠数值";
  if ((candidate.confidence ?? 0) < 0.86) return "AI 归一化置信度不足";
  return null;
}

function aiResultToNormalization(row: ObservationRow, candidate: AiIndicatorCandidate): NormalizationResult | null {
  if (!candidate.canonicalName || (candidate.confidence ?? 0) < 0.7) return null;
  const canonicalKey = aiCanonicalKey(candidate);
  if (!canonicalKey) return null;
  const rawUnit = normalizeUnit(row.unit);
  const canonicalUnit = normalizeUnit(candidate.canonicalUnit) || rawUnit;
  const numericValue = candidate.canonicalValue ?? row.numericValue ?? parseNumericResultText(row.resultText);
  const quality = fallbackQuality(row, candidate);
  return {
    observationId: row.id,
    indicatorId: null,
    canonicalKey,
    canonicalName: candidate.canonicalName,
    canonicalValue: numericValue === null ? null : convertUnit(canonicalKey, numericValue, rawUnit, canonicalUnit),
    canonicalUnit,
    confidence: Math.max(0, Math.min(1, candidate.confidence ?? 0)),
    quality,
    matchedBy: "ai_suggestion",
    matchReason: candidate.reason || "AI 根据指标名称、单位、结果和报告上下文建议归一化",
    excludedReason: quality === "excluded" ? fallbackExcludedReason(row, candidate) : null
  };
}

function aiFallbackRowsForReport(reportId: string) {
  return getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_text AS referenceText,
      r.report_type AS reportType, r.hospital_name_raw AS hospitalName,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE o.report_id = ?
      AND (n.observation_id IS NULL OR n.canonical_key IS NULL)
    ORDER BY o.section_name, o.id
    LIMIT ?
  `).all(reportId, maxAiFallbackItems) as ObservationRow[];
}

function updateAiExtractionTokenAudit(jobId: string | null | undefined, result: AiIndicatorNormalizationResult) {
  if (!jobId) return;
  const existing = getDatabase().prepare("SELECT confidence_json AS confidenceJson FROM report_extractions WHERE job_id = ?")
    .get(jobId) as { confidenceJson: string } | undefined;
  if (!existing) return;
  let confidence: Record<string, unknown> = {};
  try {
    confidence = JSON.parse(existing.confidenceJson || "{}") as Record<string, unknown>;
  } catch {
    confidence = {};
  }
  confidence.indicatorNormalization = {
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
    candidateCount: result.candidates.length
  };
  getDatabase().prepare(`
    UPDATE report_extractions
    SET prompt_tokens = COALESCE(prompt_tokens, 0) + ?,
      completion_tokens = COALESCE(completion_tokens, 0) + ?,
      elapsed_ms = COALESCE(elapsed_ms, 0) + ?,
      confidence_json = ?
    WHERE job_id = ?
  `).run(
    result.promptTokens || 0,
    result.completionTokens || 0,
    result.elapsedMs,
    JSON.stringify(confidence),
    jobId
  );
}

function reportAuditTarget(reportId: string) {
  return getDatabase().prepare("SELECT title FROM reports WHERE id = ?")
    .get(reportId) as { title: string } | undefined;
}

function insertIndicatorAiAuditEvent(input: {
  actorUserId: string;
  reportId: string;
  status: "completed" | "failed";
  inputCharacters: number;
  result?: AiIndicatorNormalizationResult;
  error?: unknown;
  detail?: Record<string, unknown>;
}) {
  const error = input.error as { code?: unknown; message?: unknown } | undefined;
  getDatabase().prepare(`
    INSERT INTO ai_audit_events (
      id, source, actor_user_id, report_id, target_title, status, attempts,
      provider, model, prompt_version, prompt_tokens, completion_tokens, elapsed_ms,
      input_characters, error_code, error_message, detail_json
    ) VALUES (?, 'indicator_normalization', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId("ai_audit"),
    input.actorUserId,
    input.reportId,
    reportAuditTarget(input.reportId)?.title || "指标归一化",
    input.status,
    input.result?.provider ?? null,
    input.result?.model ?? null,
    input.result?.promptVersion ?? aiNormalizationPromptVersion,
    input.result?.promptTokens ?? null,
    input.result?.completionTokens ?? null,
    input.result?.elapsedMs ?? null,
    input.inputCharacters,
    typeof error?.code === "string" ? error.code : input.status === "failed" ? "AI_INDICATOR_NORMALIZATION_FAILED" : null,
    error instanceof Error ? error.message : typeof error?.message === "string" ? error.message : null,
    JSON.stringify(input.detail || {})
  );
}

export async function normalizeReportObservationsWithAiFallback(
  reportId: string,
  jobId?: string | null,
  executor: AiIndicatorExecutor = requestAiIndicatorNormalization
) {
  const baseline = normalizeReportObservations(reportId);
  const rows = aiFallbackRowsForReport(reportId);
  if (!rows.length) return { ...baseline, ai: { skipped: true, reason: "没有未命中字典的指标", suggested: 0, applied: 0 } };
  if (executor === requestAiIndicatorNormalization) {
    const settings = getAiSettings(true);
    if (!settings.enabled || !settings.apiKey || !settings.textModel || !settings.baseUrl) {
      return { ...baseline, ai: { skipped: true, reason: "AI 未启用或配置不完整", suggested: 0, applied: 0 } };
    }
  }
  const report = rows[0];
  const input: AiIndicatorNormalizationInput = {
    reportId,
    reportType: report.reportType,
    hospitalName: report.hospitalName,
    items: rows.map((row) => ({
      observationId: row.id,
      sectionName: row.sectionName,
      itemName: row.itemName,
      normalizedName: row.normalizedName,
      resultText: row.resultText,
      numericValue: row.numericValue,
      unit: row.unit,
      referenceText: row.referenceText
    }))
  };
  const aiResult = await executor(input);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  let applied = 0;
  for (const candidate of aiResult.candidates) {
    const row = rowById.get(candidate.observationId);
    if (!row) continue;
    const normalized = aiResultToNormalization(row, candidate);
    if (!normalized) continue;
    upsertNormalization(normalized);
    applied += 1;
  }
  updateAiExtractionTokenAudit(jobId, aiResult);
  return {
    ...baseline,
    ai: {
      skipped: false,
      suggested: aiResult.candidates.length,
      applied,
      provider: aiResult.provider,
      model: aiResult.model,
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
      elapsedMs: aiResult.elapsedMs
    }
  };
}

async function normalizePendingReportObservationsWithAiFallback(
  reportId: string,
  actorUserId: string,
  executor: AiIndicatorExecutor = requestAiIndicatorNormalization
) {
  const baseline = normalizePendingReportObservations(reportId);
  const rows = aiFallbackRowsForReport(reportId);
  if (!rows.length) return { ...baseline, ai: { skipped: true, reason: "没有未命中字典的指标", suggested: 0, applied: 0 } };
  if (executor === requestAiIndicatorNormalization) {
    const settings = getAiSettings(true);
    if (!settings.enabled || !settings.apiKey || !settings.textModel || !settings.baseUrl) {
      return { ...baseline, ai: { skipped: true, reason: "AI 未启用或配置不完整", suggested: 0, applied: 0 } };
    }
  }
  const report = rows[0];
  const input: AiIndicatorNormalizationInput = {
    reportId,
    reportType: report.reportType,
    hospitalName: report.hospitalName,
    items: rows.map((row) => ({
      observationId: row.id,
      sectionName: row.sectionName,
      itemName: row.itemName,
      normalizedName: row.normalizedName,
      resultText: row.resultText,
      numericValue: row.numericValue,
      unit: row.unit,
      referenceText: row.referenceText
    }))
  };
  const inputCharacters = JSON.stringify(input).length;
  let aiResult: AiIndicatorNormalizationResult;
  try {
    aiResult = await executor(input);
  } catch (error) {
    insertIndicatorAiAuditEvent({
      actorUserId,
      reportId,
      status: "failed",
      inputCharacters,
      error,
      detail: { itemCount: rows.length }
    });
    throw error;
  }
  const rowById = new Map(rows.map((row) => [row.id, row]));
  let applied = 0;
  for (const candidate of aiResult.candidates) {
    const row = rowById.get(candidate.observationId);
    if (!row) continue;
    const normalized = aiResultToNormalization(row, candidate);
    if (!normalized) continue;
    upsertNormalization(normalized);
    applied += 1;
  }
  insertIndicatorAiAuditEvent({
    actorUserId,
    reportId,
    status: "completed",
    inputCharacters,
    result: aiResult,
    detail: { itemCount: rows.length, suggested: aiResult.candidates.length, applied }
  });
  return {
    ...baseline,
    ai: {
      skipped: false,
      suggested: aiResult.candidates.length,
      applied,
      provider: aiResult.provider,
      model: aiResult.model,
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
      elapsedMs: aiResult.elapsedMs
    }
  };
}

export function normalizeAllObservations(user: RequestUser): IndicatorNormalizationMaintenanceResult {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可维护指标归一化" });
  ensureBuiltinIndicatorCatalog();
  const reportIds = getDatabase().prepare(`
    SELECT DISTINCT report_id AS reportId FROM observations ORDER BY report_id
  `).all() as Array<{ reportId: string }>;
  const total = createEmptyMaintenanceResult();
  for (const row of reportIds) {
    const partial = normalizeReportObservations(row.reportId);
    addMaintenanceResult(total, partial);
  }
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'maintenance.normalize_indicators', 'observation', NULL, ?)
  `).run(createId("audit"), user.id, JSON.stringify(total));
  return total;
}

export async function normalizeAllObservationsWithAiFallback(
  user: RequestUser,
  executor: AiIndicatorExecutor = requestAiIndicatorNormalization
): Promise<IndicatorNormalizationMaintenanceResult> {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可维护指标归一化" });
  ensureBuiltinIndicatorCatalog();
  const reportIds = getDatabase().prepare(`
    SELECT DISTINCT o.report_id AS reportId
    FROM observations o
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE n.observation_id IS NULL OR n.canonical_key IS NULL
    ORDER BY o.report_id
  `).all() as Array<{ reportId: string }>;
  const total: IndicatorNormalizationMaintenanceResult = {
    scanned: 0,
    normalized: 0,
    high: 0,
    medium: 0,
    low: 0,
    excluded: 0,
    unknown: 0,
    ai: { reports: 0, suggested: 0, applied: 0, skipped: 0, failed: 0 }
  };
  for (const row of reportIds) {
    try {
      const partial = await normalizePendingReportObservationsWithAiFallback(row.reportId, user.id, executor);
      addMaintenanceResult(total, partial);
      total.ai!.reports += 1;
      total.ai!.suggested += Number(partial.ai.suggested || 0);
      total.ai!.applied += Number(partial.ai.applied || 0);
      if (partial.ai.skipped) total.ai!.skipped += 1;
    } catch {
      total.ai!.failed += 1;
    }
  }
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'maintenance.normalize_indicators', 'observation', NULL, ?)
  `).run(createId("audit"), user.id, JSON.stringify(total));
  return total;
}

export function listIndicatorNormalizationIssues(user: RequestUser): IndicatorNormalizationIssue[] {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看指标理解状态" });
  ensureBuiltinIndicatorCatalog();
  return getDatabase().prepare(`
    SELECT
      o.item_name AS rawName,
      o.normalized_name AS normalizedName,
      o.unit,
      o.section_name AS sectionName,
      r.hospital_name_raw AS hospitalName,
      CASE
        WHEN n.observation_id IS NULL OR n.canonical_key IS NULL THEN 'unknown'
        WHEN n.quality = 'excluded' THEN 'excluded'
        ELSE 'low'
      END AS status,
      COALESCE(
        n.excluded_reason,
        n.match_reason,
        '未命中内置指标字典'
      ) AS reason,
      COUNT(*) AS count,
      MAX(r.report_issued_at) AS latestReportIssuedAt
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE r.status <> 'trashed'
      AND (
        n.observation_id IS NULL
        OR n.canonical_key IS NULL
        OR n.quality IN ('low', 'excluded')
      )
    GROUP BY rawName, normalizedName, o.unit, sectionName, hospitalName, status, reason
    ORDER BY count DESC, latestReportIssuedAt DESC
    LIMIT 30
  `).all() as IndicatorNormalizationIssue[];
}
