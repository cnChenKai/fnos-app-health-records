import { getDatabase } from "../database/client";
import { builtinIndicators, builtinIndicatorVersion, type BuiltinIndicator } from "../domain/indicator-dictionary/builtin-indicators";
import { createId } from "../utils/identifier";
import type { RequestUser } from "../domain/request-user";
import { createError } from "h3";
import { getAiSettings } from "./ai-settings.service";
import { configuredRequestTimeout, fetchWithTimeout } from "../utils/outbound-request";

const normalizationVersion = `indicator-normalization-${builtinIndicatorVersion}`;
const aiNormalizationPromptVersion = "indicator-normalization-ai-v4";
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
  canonicalCategory: string | null;
  canonicalExplanation: string | null;
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
  pinsMigrated?: number;
  ai?: {
    reports: number;
    suggested: number;
    applied: number;
    skipped: number;
    failed: number;
  };
};

export type IndicatorNormalizationMaintenanceProgress = {
  totalReports: number;
  processedReports: number;
  result: IndicatorNormalizationMaintenanceResult;
};

export type BuiltinIndicatorBackfillResult = {
  scanned: number;
  updated: number;
  unmatched: number;
  preserved: number;
  pinsMigrated: number;
  version: string;
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
  existingCanonicalKey?: string | null;
  canonicalName: string | null;
  category: string | null;
  explanation: string | null;
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
  catalogCandidates: Array<{
    canonicalKey: string;
    displayName: string;
    category: string;
    defaultUnit: string | null;
    valueType: "numeric" | "text" | "positive_negative";
    trendEnabled: boolean;
    aliases: string[];
  }>;
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

const protectedIndicatorQualifiers = /高切|中切|低切|空腹|餐后|随机|卧位|立位|吸气|呼气|左侧|右侧|双侧|直接|间接|总量|定性|定量|绝对值|百分比|百分率|百分数|比例|比率/i;
const indicatorCodePattern = /^[A-Za-z][A-Za-z0-9.+-]{0,15}[#%]?$/;

/**
 * 生成跨机构通用名称候选。只拆解形如 WBC、NEUT%、ALT 的指标代码，
 * 不移除空腹/餐后、高切/低切、百分比/绝对值等医学条件。
 */
export function indicatorNameCandidates(value: string | null | undefined) {
  const raw = (value || "").normalize("NFKC").trim();
  if (!raw) return [];
  const candidates = new Set<string>();
  const add = (candidate: string | null | undefined) => {
    const compact = compactIndicatorKey(candidate);
    if (compact) candidates.add(compact);
  };
  const brackets = [...raw.matchAll(/[（(]([^（）()]*)[）)]/g)];
  const protectedBracket = brackets.some((match) => protectedIndicatorQualifiers.test(match[1] || ""));
  if (protectedBracket) candidates.add(compactAiIndicatorKey(raw));
  else add(raw);

  let withoutCodes = raw;
  for (const match of brackets) {
    const content = (match[1] || "").trim();
    if (!indicatorCodePattern.test(content)) continue;
    add(content);
    withoutCodes = withoutCodes.replace(match[0], " ");
  }
  if (withoutCodes !== raw) add(withoutCodes);

  const prefixCode = raw.match(/^\s*([A-Za-z][A-Za-z0-9.+-]{0,15}[#%]?)\s*[-:：/\\]?\s*([\u3400-\u9fff].*)$/);
  if (prefixCode) {
    add(prefixCode[1]);
    add(prefixCode[2]);
  }
  const suffixCode = raw.match(/^(.+?[\u3400-\u9fff）)])\s*[-:：/\\]?\s*([A-Za-z][A-Za-z0-9.+-]{0,15}[#%]?)\s*$/);
  if (suffixCode) {
    add(suffixCode[1]);
    add(suffixCode[2]);
  }
  if (indicatorCodePattern.test(raw)) add(raw);
  return [...candidates];
}

/** AI 归一化键保留括号内容：括号内的测量条件（如 高切/低切/中切）是指标本体，剥掉会把不同测量并为一个趋势系列 */
function compactAiIndicatorKey(value: string | null | undefined) {
  return (value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
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
    "kg": "kg",
    "千克": "kg",
    "公斤": "kg",
    "g": "g",
    "克": "g",
    "m": "m",
    "米": "m",
    "cm": "cm",
    "厘米": "cm",
    "mm": "mm",
    "毫米": "mm",
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
  const name = compactAiIndicatorKey(candidate.canonicalName);
  const valueType = candidate.valueType || "text";
  return name ? `ai:${valueType}:${name}` : null;
}

function canConvertIndicatorUnit(canonicalKey: string, fromUnit: string, toUnit: string) {
  if (fromUnit === toUnit) return true;
  const pair = `${fromUnit}->${toUnit}`;
  if (["body_weight"].includes(canonicalKey) && ["g->kg", "kg->g"].includes(pair)) return true;
  if (["body_height", "body_waist_circumference"].includes(canonicalKey) && ["m->cm", "cm->m"].includes(pair)) return true;
  if (["cm->mm", "mm->cm"].includes(pair)) return true;
  if (["lipid_tc", "lipid_hdl_c", "lipid_ldl_c", "lipid_tg", "glucose_fasting"].includes(canonicalKey)
    && ["mg/dL->mmol/L", "mmol/L->mg/dL"].includes(pair)) return true;
  if (canonicalKey === "cbc_hgb" && ["g/dL->g/L", "g/L->g/dL"].includes(pair)) return true;
  return false;
}

function catalogUnitCompatible(row: ObservationRow, indicator: IndicatorRow) {
  const rawUnit = normalizeUnit(row.unit);
  const defaultUnit = normalizeUnit(indicator.defaultUnit);
  if (!rawUnit || !defaultUnit) return true;
  const builtin = builtinIndicators.find((item) => item.canonicalKey === indicator.canonicalKey) || null;
  const allowedUnits = new Set((builtin?.allowedUnits || []).map(normalizeUnit).filter(Boolean));
  return allowedUnits.has(rawUnit)
    || rawUnit === defaultUnit
    || canConvertIndicatorUnit(indicator.canonicalKey, rawUnit, defaultUnit);
}

function textHasAny(value: string, hints: string[]) {
  const compact = compactIndicatorKey(value);
  return hints.some((hint) => compact.includes(compactIndicatorKey(hint)));
}

function allowedUnitsFor(indicator: BuiltinIndicator | null, row: IndicatorRow | AliasRow) {
  const builtin = indicator || builtinIndicators.find((item) => item.canonicalKey === row.canonicalKey) || null;
  return new Set((builtin?.allowedUnits || []).map((unit) => normalizeUnit(unit)).filter(Boolean));
}

export function convertUnit(canonicalKey: string, value: number, fromUnit: string | null, toUnit: string | null) {
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
  if (canonicalKey === "body_weight" && fromUnit === "g" && toUnit === "kg") return value / 1000;
  if (canonicalKey === "body_weight" && fromUnit === "kg" && toUnit === "g") return value * 1000;
  if (["body_height", "body_waist_circumference"].includes(canonicalKey) && fromUnit === "m" && toUnit === "cm") return value * 100;
  if (["body_height", "body_waist_circumference"].includes(canonicalKey) && fromUnit === "cm" && toUnit === "m") return value / 100;
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
  const names = new Set(baseNames.flatMap(indicatorNameCandidates).filter(Boolean));
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

export function globalIndicatorCatalogForAi(): AiIndicatorNormalizationInput["catalogCandidates"] {
  ensureBuiltinIndicatorCatalog();
  const db = getDatabase();
  const indicators = db.prepare(`
    SELECT id, canonical_key AS canonicalKey, display_name AS displayName, category,
      default_unit AS defaultUnit, value_type AS valueType, trend_enabled AS trendEnabled
    FROM indicator_catalog
    ORDER BY CASE source WHEN 'builtin' THEN 0 ELSE 1 END, display_name, canonical_key
  `).all() as Array<{
    id: string;
    canonicalKey: string;
    displayName: string;
    category: string;
    defaultUnit: string | null;
    valueType: "numeric" | "text" | "positive_negative";
    trendEnabled: number;
  }>;
  const aliases = db.prepare(`
    SELECT indicator_id AS indicatorId, alias_name AS aliasName
    FROM indicator_aliases
    WHERE enabled = 1 AND scope = 'global'
    ORDER BY confidence DESC, alias_name
  `).all() as Array<{ indicatorId: string; aliasName: string }>;
  const aliasesByIndicator = new Map<string, string[]>();
  for (const alias of aliases) {
    const current = aliasesByIndicator.get(alias.indicatorId) || [];
    if (!current.includes(alias.aliasName)) current.push(alias.aliasName);
    aliasesByIndicator.set(alias.indicatorId, current);
  }
  return indicators.map((indicator) => ({
    canonicalKey: indicator.canonicalKey,
    displayName: indicator.displayName,
    category: indicator.category,
    defaultUnit: normalizeUnit(indicator.defaultUnit),
    valueType: indicator.valueType,
    trendEnabled: indicator.trendEnabled === 1,
    aliases: (aliasesByIndicator.get(indicator.id) || []).slice(0, 30)
  }));
}

function normalizeObservationWithReadyCatalog(row: ObservationRow): NormalizationResult {
  const aliases = candidateAliases(row);
  if (!aliases.length) {
    return {
      observationId: row.id,
      indicatorId: null,
      canonicalKey: null,
      canonicalName: null,
      canonicalValue: null,
      canonicalUnit: null,
      canonicalCategory: null,
      canonicalExplanation: null,
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
    const defaultUnit = normalizeUnit(alias.defaultUnit);
    const unitCompatible = !rawUnit
      || (!defaultUnit && allowedUnits.size === 0)
      || allowedUnits.has(rawUnit)
      || rawUnit === defaultUnit
      || Boolean(defaultUnit && canConvertIndicatorUnit(alias.canonicalKey, rawUnit, defaultUnit));
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
    canonicalCategory: selected.alias.category,
    canonicalExplanation: selected.alias.explanation,
    confidence: Math.max(0, Math.min(1, selected.score / 100)),
    quality,
    matchedBy: selected.alias.scope === "global" ? "builtin_alias" : `${selected.alias.scope}_alias`,
    matchReason: selected.reasons.join("；"),
    excludedReason
  };
}

export function normalizeObservation(row: ObservationRow): NormalizationResult {
  ensureBuiltinIndicatorCatalog();
  return normalizeObservationWithReadyCatalog(row);
}

function indicatorAiSystemPrompt() {
  return `你是健康报告指标归一化助手，只能基于输入里的指标事实做命名归一化和通俗指标说明，不得诊断、不得解释个人疾病风险、不得预测异常、不得生成治疗或用药建议。
返回 JSON 对象，不要 Markdown，格式为：
{"candidates":[{"observationId":"原ID","existingCanonicalKey":"输入目录中的标准Key或null","canonicalName":"标准名称或null","category":"分类或null","explanation":"不超过80字的通俗指标说明或null","valueType":"numeric|text|positive_negative","trendEnabled":true/false,"canonicalUnit":"标准单位或null","canonicalValue":数值或null,"confidence":0到1,"reason":"简短依据"}]}
规则：
1. observationId 必须原样来自输入，不能新增 ID。
2. 必须先从 catalogCandidates 选择同一医学指标；能复用时返回其 existingCanonicalKey、displayName、category、defaultUnit 和 valueType，不得仅因机构写法或英文缩写不同创建新名称。
3. 百分比与绝对值、空腹与餐后、直接与间接、高切与低切等属于不同指标；单位不兼容时不得复用同一个 existingCanonicalKey。
4. 只有明确是单一数值指标时 valueType=numeric 且 trendEnabled=true，例如 BMI、尿酸、病毒核酸定量。
5. 影像/超声/心电/耳鼻喉的文字发现、定性筛查、阳性发现、分级描述，valueType 应为 text 或 positive_negative，trendEnabled=false。
6. canonicalName 使用中文常用医学报告名称；高切/低切、空腹/餐后、卧位/立位、百分比/绝对值等测量条件必须保留。
7. 如果无法确定标准名称，existingCanonicalKey=null、canonicalName=null，confidence 不高于 0.5。
8. category 优先使用：基础测量、内科检查、外科检查、眼科检查、耳鼻喉检查、口腔检查、妇科检查、血常规、尿常规、肝功能、肾功能、血脂、血糖、电解质、甲状腺功能、感染及免疫、功能检查、影像检查、其他检查。
9. explanation 只说明“该指标是什么、通常用于观察什么”，不得结合本次结果下结论；无法可靠说明时返回 null。
10. 医院名称不参与指标归一化；同一医学指标必须跨机构使用同一个 existingCanonicalKey。
11. 不输出姓名、身份证、电话、住址。`;
}

function parseAiJsonContent(content: string) {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(clean) as unknown;
}

function normalizeAiIndicatorCandidates(
  value: unknown,
  allowedIds: Set<string>,
  allowedCanonicalKeys: Set<string>
): AiIndicatorCandidate[] {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rows = Array.isArray(source.candidates) ? source.candidates : [];
  return rows.slice(0, maxAiFallbackItems).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const observationId = textValue(row.observationId, 120);
    if (!observationId || !allowedIds.has(observationId)) return [];
    const valueType = textValue(row.valueType, 40);
    const canonicalName = textValue(row.canonicalName, 120);
    const requestedCanonicalKey = textValue(row.existingCanonicalKey, 160);
    const confidence = numberValue(row.confidence);
    return [{
      observationId,
      existingCanonicalKey: requestedCanonicalKey && allowedCanonicalKeys.has(requestedCanonicalKey)
        ? requestedCanonicalKey
        : null,
      canonicalName,
      category: textValue(row.category, 80),
      explanation: textValue(row.explanation, 500),
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
  const timeoutMs = configuredRequestTimeout("AI_REQUEST_TIMEOUT_MS", 3 * 60_000);
  const response = await fetchWithTimeout(`${settings.baseUrl}/chat/completions`, {
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
  }, {
    timeoutMs,
    timeoutCode: "AI_NORMALIZE_TIMEOUT",
    timeoutMessage: `AI 服务在 ${Math.round(timeoutMs / 1000)} 秒内未完成指标归一化`,
    networkCode: "AI_NORMALIZE_NETWORK_ERROR",
    networkMessage: "无法连接 AI 服务完成指标归一化，请检查 NAS 网络和模型状态"
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
  const candidates = normalizeAiIndicatorCandidates(
    parsed,
    new Set(input.items.map((item) => item.observationId)),
    new Set(input.catalogCandidates.map((item) => item.canonicalKey))
  );
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

function migrateTrendPinsAfterNormalizationChange(input: {
  memberId: string | null;
  oldCanonicalKey: string | null;
  oldCanonicalUnit: string | null;
  newCanonicalKey: string | null;
  newCanonicalUnit: string | null;
}) {
  if (!input.memberId || !input.oldCanonicalKey || !input.newCanonicalKey) return 0;
  const oldUnitKey = input.oldCanonicalUnit || "";
  const newUnitKey = input.newCanonicalUnit || "";
  if (input.oldCanonicalKey === input.newCanonicalKey && oldUnitKey === newUnitKey) return 0;
  const db = getDatabase();
  const remaining = db.prepare(`
    SELECT COUNT(*) AS count
    FROM observation_normalizations n
    JOIN observations o ON o.id = n.observation_id
    JOIN reports r ON r.id = o.report_id
    WHERE r.member_id = ?
      AND n.canonical_key = ?
      AND COALESCE(n.canonical_unit, '') = ?
  `).get(input.memberId, input.oldCanonicalKey, oldUnitKey) as { count: number };
  if (Number(remaining.count) > 0) return 0;
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO user_trend_pins (
      user_id, member_id, indicator_key, unit_key, created_at, updated_at
    )
    SELECT user_id, member_id, ?, ?, created_at, CURRENT_TIMESTAMP
    FROM user_trend_pins
    WHERE member_id = ? AND indicator_key = ? AND unit_key = ?
  `).run(
    input.newCanonicalKey,
    newUnitKey,
    input.memberId,
    input.oldCanonicalKey,
    oldUnitKey
  );
  db.prepare(`
    DELETE FROM user_trend_pins
    WHERE member_id = ? AND indicator_key = ? AND unit_key = ?
  `).run(input.memberId, input.oldCanonicalKey, oldUnitKey);
  return Number(inserted.changes);
}

function upsertNormalization(result: NormalizationResult) {
  const db = getDatabase();
  const previous = db.prepare(`
    SELECT n.canonical_key AS canonicalKey, n.canonical_unit AS canonicalUnit, r.member_id AS memberId
    FROM observation_normalizations n
    JOIN observations o ON o.id = n.observation_id
    JOIN reports r ON r.id = o.report_id
    WHERE n.observation_id = ?
  `).get(result.observationId) as {
    canonicalKey: string | null;
    canonicalUnit: string | null;
    memberId: string;
  } | undefined;
  db.prepare(`
    INSERT INTO observation_normalizations (
      observation_id, indicator_id, canonical_key, canonical_name, canonical_value, canonical_unit,
      canonical_category, canonical_explanation, confidence, quality, matched_by, match_reason,
      excluded_reason, version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(observation_id) DO UPDATE SET
      indicator_id = excluded.indicator_id,
      canonical_key = excluded.canonical_key,
      canonical_name = excluded.canonical_name,
      canonical_value = excluded.canonical_value,
      canonical_unit = excluded.canonical_unit,
      canonical_category = excluded.canonical_category,
      canonical_explanation = excluded.canonical_explanation,
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
    result.canonicalCategory,
    result.canonicalExplanation,
    result.confidence,
    result.quality,
    result.matchedBy,
    result.matchReason,
    result.excludedReason,
    normalizationVersion
  );
  return migrateTrendPinsAfterNormalizationChange({
    memberId: previous?.memberId || null,
    oldCanonicalKey: previous?.canonicalKey || null,
    oldCanonicalUnit: normalizeUnit(previous?.canonicalUnit),
    newCanonicalKey: result.canonicalKey,
    newCanonicalUnit: normalizeUnit(result.canonicalUnit)
  });
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

function staleBuiltinNormalizationRows() {
  return getDatabase().prepare(`
    SELECT o.id, o.report_id AS reportId, o.section_name AS sectionName, o.item_code AS itemCode,
      o.item_name AS itemName, o.normalized_name AS normalizedName, o.result_text AS resultText,
      o.numeric_value AS numericValue, o.unit, o.reference_text AS referenceText,
      r.report_type AS reportType, r.hospital_name_raw AS hospitalName,
      r.performing_department AS performingDepartment, r.reporting_department AS reportingDepartment,
      n.canonical_key AS existingCanonicalKey, n.matched_by AS existingMatchedBy
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE n.observation_id IS NULL OR n.canonical_key IS NULL OR n.version <> ?
    ORDER BY o.report_id, o.id
  `).all(normalizationVersion) as Array<ObservationRow & {
    existingCanonicalKey: string | null;
    existingMatchedBy: string | null;
  }>;
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
  ensureBuiltinIndicatorCatalog();
  const result = createEmptyMaintenanceResult();
  result.scanned = rows.length;
  for (const row of rows) {
    const normalized = normalizeObservationWithReadyCatalog(row);
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

export function backfillBuiltinIndicatorNormalizations(): BuiltinIndicatorBackfillResult {
  ensureBuiltinIndicatorCatalog();
  const rows = staleBuiltinNormalizationRows();
  const result: BuiltinIndicatorBackfillResult = {
    scanned: rows.length,
    updated: 0,
    unmatched: 0,
    preserved: 0,
    pinsMigrated: 0,
    version: builtinIndicatorVersion
  };
  for (const row of rows) {
    const normalized = normalizeObservationWithReadyCatalog(row);
    if (normalized.canonicalKey) {
      result.pinsMigrated += upsertNormalization(normalized);
      result.updated += 1;
      continue;
    }
    result.unmatched += 1;
    if (row.existingCanonicalKey || row.existingMatchedBy === "ai_suggestion") {
      result.preserved += 1;
      continue;
    }
    upsertNormalization(normalized);
  }
  return result;
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

function indicatorByCanonicalKey(canonicalKey: string | null | undefined) {
  if (!canonicalKey) return null;
  return (getDatabase().prepare(`
    SELECT id, canonical_key AS canonicalKey, display_name AS displayName, category, specimen,
      default_unit AS defaultUnit, value_type AS valueType, trend_enabled AS trendEnabled, explanation
    FROM indicator_catalog
    WHERE canonical_key = ?
  `).get(canonicalKey) as IndicatorRow | undefined) || null;
}

function findExistingCatalogIndicator(row: ObservationRow, candidate: AiIndicatorCandidate) {
  const candidateNames = [
    candidate.canonicalName,
    row.normalizedName,
    row.itemName,
    row.itemCode
  ].flatMap(indicatorNameCandidates);
  const names = [...new Set(candidateNames.filter(Boolean))];
  if (!names.length) return null;
  const placeholders = names.map(() => "?").join(",");
  const matches = getDatabase().prepare(`
    SELECT c.id, c.canonical_key AS canonicalKey, c.display_name AS displayName, c.category, c.specimen,
      c.default_unit AS defaultUnit, c.value_type AS valueType, c.trend_enabled AS trendEnabled,
      c.explanation, a.normalized_alias AS normalizedAlias, a.confidence,
      CASE c.source WHEN 'builtin' THEN 0 ELSE 1 END AS sourceOrder
    FROM indicator_aliases a
    JOIN indicator_catalog c ON c.id = a.indicator_id
    WHERE a.enabled = 1 AND a.scope = 'global' AND a.normalized_alias IN (${placeholders})
    ORDER BY sourceOrder, a.confidence DESC, c.display_name
  `).all(...names) as Array<IndicatorRow & {
    normalizedAlias: string;
    confidence: number;
    sourceOrder: number;
  }>;
  const compatible = matches.filter((match) => catalogUnitCompatible(row, match));
  for (const name of names) {
    const matched = compatible.find((item) => item.normalizedAlias === name);
    if (matched) return matched;
  }
  return null;
}

function hasIncompatibleCatalogNameMatch(row: ObservationRow, candidate: AiIndicatorCandidate) {
  const names = [...new Set([
    candidate.canonicalName,
    row.normalizedName,
    row.itemName,
    row.itemCode
  ].flatMap(indicatorNameCandidates).filter(Boolean))];
  if (!names.length) return false;
  const placeholders = names.map(() => "?").join(",");
  const matches = getDatabase().prepare(`
    SELECT DISTINCT c.id, c.canonical_key AS canonicalKey, c.display_name AS displayName, c.category,
      c.specimen, c.default_unit AS defaultUnit, c.value_type AS valueType,
      c.trend_enabled AS trendEnabled, c.explanation
    FROM indicator_aliases a
    JOIN indicator_catalog c ON c.id = a.indicator_id
    WHERE a.enabled = 1 AND a.scope = 'global' AND a.normalized_alias IN (${placeholders})
  `).all(...names) as IndicatorRow[];
  return matches.length > 0 && matches.every((match) => !catalogUnitCompatible(row, match));
}

function createAiManagedIndicator(row: ObservationRow, candidate: AiIndicatorCandidate) {
  if (!candidate.canonicalName
    || !candidate.valueType
    || candidate.trendEnabled === null
    || candidate.trendEnabled === undefined
    || (candidate.confidence ?? 0) < 0.92) return null;
  const baseKey = aiCanonicalKey(candidate);
  if (!baseKey) return null;
  const db = getDatabase();
  const rawUnit = normalizeUnit(row.unit);
  const canonicalUnit = normalizeUnit(candidate.canonicalUnit) || rawUnit;
  let canonicalKey = baseKey;
  const collision = indicatorByCanonicalKey(canonicalKey);
  if (collision && !catalogUnitCompatible(row, collision)) {
    const unitKey = compactAiIndicatorKey(canonicalUnit || "unitless");
    canonicalKey = `${baseKey}:${unitKey || "unitless"}`;
  }
  const existing = indicatorByCanonicalKey(canonicalKey);
  if (existing) return catalogUnitCompatible(row, existing) ? existing : null;
  const indicatorId = createId("indicator");
  db.prepare(`
    INSERT INTO indicator_catalog (
      id, canonical_key, display_name, category, specimen, default_unit, value_type,
      trend_enabled, explanation, source, ai_managed, builtin_version, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'user', 1, NULL, CURRENT_TIMESTAMP)
  `).run(
    indicatorId,
    canonicalKey,
    candidate.canonicalName,
    candidate.category || "其他检查",
    canonicalUnit,
    candidate.valueType,
    candidate.trendEnabled ? 1 : 0,
    candidate.explanation
  );
  return indicatorByCanonicalKey(canonicalKey);
}

function upsertGlobalAiAliases(indicatorId: string, row: ObservationRow, candidate: AiIndicatorCandidate) {
  const confidence = Math.max(0, Math.min(1, candidate.confidence ?? 0));
  if (confidence < 0.92) return 0;
  const rawAliases = [
    candidate.canonicalName,
    row.itemName,
    row.normalizedName,
    row.itemCode
  ].filter((value): value is string => Boolean(value?.trim()));
  const aliases = new Map<string, string>();
  for (const aliasName of rawAliases) {
    for (const normalizedAlias of indicatorNameCandidates(aliasName)) {
      if (normalizedAlias.length < 2) continue;
      if (!aliases.has(normalizedAlias)) aliases.set(normalizedAlias, aliasName.trim());
    }
  }
  const db = getDatabase();
  const findAlias = db.prepare(`
    SELECT id, indicator_id AS indicatorId, source
    FROM indicator_aliases
    WHERE normalized_alias = ? AND scope = 'global' AND enabled = 1
    ORDER BY confidence DESC
  `);
  const insertAlias = db.prepare(`
    INSERT INTO indicator_aliases (
      id, indicator_id, alias_name, normalized_alias, scope, source, confidence, enabled, updated_at
    ) VALUES (?, ?, ?, ?, 'global', 'ai_suggestion', ?, 1, CURRENT_TIMESTAMP)
  `);
  const updateAlias = db.prepare(`
    UPDATE indicator_aliases
    SET alias_name = ?, confidence = MAX(confidence, ?), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND source = 'ai_suggestion'
  `);
  let changed = 0;
  for (const [normalizedAlias, aliasName] of aliases) {
    const existing = findAlias.all(normalizedAlias) as Array<{
      id: string;
      indicatorId: string;
      source: string;
    }>;
    if (existing.some((alias) => alias.indicatorId !== indicatorId)) continue;
    const same = existing.find((alias) => alias.indicatorId === indicatorId);
    if (same) {
      if (same.source === "ai_suggestion") changed += Number(updateAlias.run(aliasName, confidence, same.id).changes);
      continue;
    }
    changed += Number(insertAlias.run(createId("alias"), indicatorId, aliasName, normalizedAlias, confidence).changes);
  }
  return changed;
}

function aiResultToNormalization(row: ObservationRow, candidate: AiIndicatorCandidate): NormalizationResult | null {
  if ((candidate.confidence ?? 0) < 0.7) return null;
  let indicator = indicatorByCanonicalKey(candidate.existingCanonicalKey);
  const rejectedExistingCanonicalKey = Boolean(indicator && !catalogUnitCompatible(row, indicator));
  let matchedBy = "ai_catalog";
  let matchReason = candidate.reason || "AI 从全局指标目录中选择了同一医学指标";
  if (rejectedExistingCanonicalKey) {
    indicator = null;
    matchReason = "AI 返回的全局指标单位不兼容，已拒绝复用";
  }
  if (!indicator) {
    indicator = findExistingCatalogIndicator(row, candidate);
    if (indicator) {
      matchedBy = "ai_catalog_alias";
      matchReason = candidate.reason || "AI 建议名称命中已有全局指标别名";
    }
  }
  if (!indicator) {
    if (rejectedExistingCanonicalKey || hasIncompatibleCatalogNameMatch(row, candidate)) return null;
    indicator = createAiManagedIndicator(row, candidate);
    matchedBy = "ai_catalog_created";
    matchReason = candidate.reason || "AI 高置信识别为新指标，已加入全局指标目录";
  }
  if (!indicator) return null;
  if (!catalogUnitCompatible(row, indicator)) return null;
  const rawUnit = normalizeUnit(row.unit);
  const canonicalUnit = normalizeUnit(indicator.defaultUnit) || normalizeUnit(candidate.canonicalUnit) || rawUnit;
  const numericValue = candidate.canonicalValue ?? row.numericValue ?? parseNumericResultText(row.resultText);
  const catalogCandidate: AiIndicatorCandidate = {
    ...candidate,
    canonicalName: indicator.displayName,
    category: indicator.category,
    explanation: indicator.explanation,
    valueType: indicator.valueType,
    trendEnabled: indicator.trendEnabled === 1,
    canonicalUnit
  };
  const quality = fallbackQuality(row, catalogCandidate);
  upsertGlobalAiAliases(indicator.id, row, catalogCandidate);
  return {
    observationId: row.id,
    indicatorId: indicator.id,
    canonicalKey: indicator.canonicalKey,
    canonicalName: indicator.displayName,
    canonicalValue: numericValue === null ? null : convertUnit(indicator.canonicalKey, numericValue, rawUnit, canonicalUnit),
    canonicalUnit,
    canonicalCategory: indicator.category,
    canonicalExplanation: indicator.explanation,
    confidence: Math.max(0, Math.min(1, candidate.confidence ?? 0)),
    quality,
    matchedBy,
    matchReason,
    excludedReason: quality === "excluded" ? fallbackExcludedReason(row, catalogCandidate) : null
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
    catalogCandidates: globalIndicatorCatalogForAi(),
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
    catalogCandidates: globalIndicatorCatalogForAi(),
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

type TrendPinMigrationSnapshot = {
  observationId: string;
  memberId: string;
  canonicalKey: string;
  canonicalUnit: string | null;
};

function snapshotTrendPinMappings(): TrendPinMigrationSnapshot[] {
  return getDatabase().prepare(`
    SELECT n.observation_id AS observationId, r.member_id AS memberId,
      n.canonical_key AS canonicalKey, n.canonical_unit AS canonicalUnit
    FROM observation_normalizations n
    JOIN observations o ON o.id = n.observation_id
    JOIN reports r ON r.id = o.report_id
    WHERE n.canonical_key IS NOT NULL
  `).all() as TrendPinMigrationSnapshot[];
}

function migrateTrendPinsFromFullNormalization(snapshot: TrendPinMigrationSnapshot[]) {
  if (!snapshot.length) return 0;
  const oldByObservation = new Map(snapshot.map((row) => [row.observationId, row]));
  const mappings = new Map<string, {
    memberId: string;
    oldCanonicalKey: string;
    oldCanonicalUnit: string | null;
    targets: Set<string>;
  }>();
  const current = getDatabase().prepare(`
    SELECT n.observation_id AS observationId, n.canonical_key AS canonicalKey,
      n.canonical_unit AS canonicalUnit
    FROM observation_normalizations n
    WHERE n.canonical_key IS NOT NULL
  `).all() as Array<{
    observationId: string;
    canonicalKey: string;
    canonicalUnit: string | null;
  }>;
  for (const row of current) {
    const old = oldByObservation.get(row.observationId);
    if (!old) continue;
    const sourceKey = JSON.stringify([old.memberId, old.canonicalKey, normalizeUnit(old.canonicalUnit) || ""]);
    const targetKey = JSON.stringify([row.canonicalKey, normalizeUnit(row.canonicalUnit) || ""]);
    const mapping = mappings.get(sourceKey) || {
      memberId: old.memberId,
      oldCanonicalKey: old.canonicalKey,
      oldCanonicalUnit: normalizeUnit(old.canonicalUnit),
      targets: new Set<string>()
    };
    mapping.targets.add(targetKey);
    mappings.set(sourceKey, mapping);
  }
  let migrated = 0;
  for (const mapping of mappings.values()) {
    if (mapping.targets.size !== 1) continue;
    const [newCanonicalKey, newCanonicalUnit] = JSON.parse([...mapping.targets][0]) as [string, string];
    migrated += migrateTrendPinsAfterNormalizationChange({
      memberId: mapping.memberId,
      oldCanonicalKey: mapping.oldCanonicalKey,
      oldCanonicalUnit: mapping.oldCanonicalUnit,
      newCanonicalKey,
      newCanonicalUnit: newCanonicalUnit || null
    });
  }
  return migrated;
}

export async function normalizeAllObservationsWithAiFallback(
  user: RequestUser,
  executor: AiIndicatorExecutor = requestAiIndicatorNormalization,
  options?: {
    full?: boolean;
    taskId?: string;
    onProgress?: (progress: IndicatorNormalizationMaintenanceProgress) => void;
  }
): Promise<IndicatorNormalizationMaintenanceResult> {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可维护指标归一化" });
  ensureBuiltinIndicatorCatalog();
  const trendPinSnapshot = options?.full ? snapshotTrendPinMappings() : [];
  /* 全量重跑：清空已有归一化结果（含 AI 兜底写错的），让字典和 AI 兜底重新整理所有指标 */
  if (options?.full) {
    getDatabase().prepare("DELETE FROM observation_normalizations").run();
  }
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
  options?.onProgress?.({
    totalReports: reportIds.length,
    processedReports: 0,
    result: total
  });
  let processedReports = 0;
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
    processedReports += 1;
    options?.onProgress?.({
      totalReports: reportIds.length,
      processedReports,
      result: total
    });
  }
  if (options?.full) total.pinsMigrated = migrateTrendPinsFromFullNormalization(trendPinSnapshot);
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'maintenance.normalize_indicators', 'observation', NULL, ?)
  `).run(createId("audit"), user.id, JSON.stringify({
    ...total,
    full: options?.full === true,
    taskId: options?.taskId || null
  }));
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
