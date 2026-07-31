import { getDatabase } from "../database/client";
import { createHash } from "node:crypto";
import { createId } from "../utils/identifier";
import type { RequestUser } from "../domain/request-user";
import { createError } from "h3";
import {
  activeIndicatorDictionaryVersion,
  ensureCoreDictionaryMaterialized
} from "./indicator-dictionary.service";

function normalizationVersion() {
  return `indicator-normalization-${activeIndicatorDictionaryVersion()}`;
}

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
  allowedUnitsJson: string | null;
  sectionHintsJson: string | null;
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
  if (protectedBracket) candidates.add(compactQualifiedIndicatorKey(raw));
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

/** 括号内的测量条件（如高切/低切/中切）是指标本体，不能剥掉后合并趋势。 */
function compactQualifiedIndicatorKey(value: string | null | undefined) {
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
    "nmol/l": "nmol/L",
    "ng/ml": "ng/mL",
    "μg/l": "μg/L",
    "pg/ml": "pg/mL",
    "ng/dl": "ng/dL",
    "meq/l": "mEq/L",
    "iu/ml": "IU/mL",
    "kiu/l": "IU/mL",
    "copies/ml": "copies/mL",
    "kg/m2": "kg/m²",
    "kg/m²": "kg/m²",
    "kg/㎡": "kg/m²",
    "mmhg": "mmHg",
    "bpm": "次/分",
    "次/min": "次/分",
    "次/分钟": "次/分",
    "次/分": "次/分",
    "fl": "fL",
    "pg": "pg",
    "l/l": "L/L",
    "ml/min/1.73m2": "mL/min/1.73m²",
    "ml/min/1.73m²": "mL/min/1.73m²",
    "/hpf": "/HPF",
    "cell/hp": "/HPF",
    "/lpf": "/LPF",
    "cast/lp": "/LPF",
    "个/lpf": "/LPF",
    "个/hpf": "/HPF",
    "cells/hpf": "/HPF",
    "个/μl": "个/μL",
    "cells/μl": "个/μL",
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

function canConvertIndicatorUnit(canonicalKey: string, fromUnit: string, toUnit: string) {
  if (fromUnit === toUnit) return true;
  const pair = `${fromUnit}->${toUnit}`;
  if (["body_weight"].includes(canonicalKey) && ["g->kg", "kg->g"].includes(pair)) return true;
  if (["body_height", "body_waist_circumference", "body_hip_circumference"].includes(canonicalKey)
    && ["m->cm", "cm->m"].includes(pair)) return true;
  if (["cm->mm", "mm->cm"].includes(pair)) return true;
  if (["lipid_tc", "lipid_hdl_c", "lipid_ldl_c", "lipid_tg", "glucose_fasting",
    "glucose_postprandial_2h", "glucose_random"].includes(canonicalKey)
    && ["mg/dL->mmol/L", "mmol/L->mg/dL"].includes(pair)) return true;
  if (["cbc_hgb", "cbc_mchc", "liver_total_protein", "liver_albumin", "liver_globulin"].includes(canonicalKey)
    && ["g/dL->g/L", "g/L->g/dL"].includes(pair)) return true;
  if (canonicalKey === "cbc_hct" && ["L/L->%", "%->L/L"].includes(pair)) return true;
  if (["renal_creatinine", "renal_uric_acid", "liver_tbil", "liver_dbil", "liver_ibil"].includes(canonicalKey)
    && ["mg/dL->μmol/L", "μmol/L->mg/dL"].includes(pair)) return true;
  if (["renal_urea", "renal_bun"].includes(canonicalKey)
    && ["mg/dL->mmol/L", "mmol/L->mg/dL"].includes(pair)) return true;
  return false;
}

function parseStringList(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function textHasAny(value: string, hints: string[]) {
  const compact = compactIndicatorKey(value);
  return hints.some((hint) => compact.includes(compactIndicatorKey(hint)));
}

function allowedUnitsFor(row: AliasRow) {
  return new Set(parseStringList(row.allowedUnitsJson).map((unit) => normalizeUnit(unit)).filter(Boolean));
}

export function convertUnit(canonicalKey: string, value: number, fromUnit: string | null, toUnit: string | null) {
  if (value === null || !fromUnit || !toUnit || fromUnit === toUnit) return value;
  const lipidKeys = new Set(["lipid_tc", "lipid_hdl_c", "lipid_ldl_c"]);
  if (lipidKeys.has(canonicalKey) && fromUnit === "mg/dL" && toUnit === "mmol/L") return value / 38.67;
  if (lipidKeys.has(canonicalKey) && fromUnit === "mmol/L" && toUnit === "mg/dL") return value * 38.67;
  if (canonicalKey === "lipid_tg" && fromUnit === "mg/dL" && toUnit === "mmol/L") return value / 88.57;
  if (canonicalKey === "lipid_tg" && fromUnit === "mmol/L" && toUnit === "mg/dL") return value * 88.57;
  if (["glucose_fasting", "glucose_postprandial_2h", "glucose_random"].includes(canonicalKey)
    && fromUnit === "mg/dL" && toUnit === "mmol/L") return value / 18.018;
  if (["glucose_fasting", "glucose_postprandial_2h", "glucose_random"].includes(canonicalKey)
    && fromUnit === "mmol/L" && toUnit === "mg/dL") return value * 18.018;
  if (["cbc_hgb", "cbc_mchc", "liver_total_protein", "liver_albumin", "liver_globulin"].includes(canonicalKey)
    && fromUnit === "g/dL" && toUnit === "g/L") return value * 10;
  if (["cbc_hgb", "cbc_mchc", "liver_total_protein", "liver_albumin", "liver_globulin"].includes(canonicalKey)
    && fromUnit === "g/L" && toUnit === "g/dL") return value / 10;
  if (canonicalKey === "cbc_hct" && fromUnit === "L/L" && toUnit === "%") return value * 100;
  if (canonicalKey === "cbc_hct" && fromUnit === "%" && toUnit === "L/L") return value / 100;
  if (canonicalKey === "renal_creatinine" && fromUnit === "mg/dL" && toUnit === "μmol/L") return value * 88.4;
  if (canonicalKey === "renal_creatinine" && fromUnit === "μmol/L" && toUnit === "mg/dL") return value / 88.4;
  if (canonicalKey === "renal_uric_acid" && fromUnit === "mg/dL" && toUnit === "μmol/L") return value * 59.48;
  if (canonicalKey === "renal_uric_acid" && fromUnit === "μmol/L" && toUnit === "mg/dL") return value / 59.48;
  if (canonicalKey === "renal_urea" && fromUnit === "mg/dL" && toUnit === "mmol/L") return value * 0.1665;
  if (canonicalKey === "renal_urea" && fromUnit === "mmol/L" && toUnit === "mg/dL") return value / 0.1665;
  if (canonicalKey === "renal_bun" && fromUnit === "mg/dL" && toUnit === "mmol/L") return value * 0.357;
  if (canonicalKey === "renal_bun" && fromUnit === "mmol/L" && toUnit === "mg/dL") return value / 0.357;
  if (["liver_tbil", "liver_dbil", "liver_ibil"].includes(canonicalKey)
    && fromUnit === "mg/dL" && toUnit === "μmol/L") return value * 17.104;
  if (["liver_tbil", "liver_dbil", "liver_ibil"].includes(canonicalKey)
    && fromUnit === "μmol/L" && toUnit === "mg/dL") return value / 17.104;
  if (canonicalKey === "body_weight" && fromUnit === "g" && toUnit === "kg") return value / 1000;
  if (canonicalKey === "body_weight" && fromUnit === "kg" && toUnit === "g") return value * 1000;
  if (["body_height", "body_waist_circumference", "body_hip_circumference"].includes(canonicalKey)
    && fromUnit === "m" && toUnit === "cm") return value * 100;
  if (["body_height", "body_waist_circumference", "body_hip_circumference"].includes(canonicalKey)
    && fromUnit === "cm" && toUnit === "m") return value / 100;
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
  ensureCoreDictionaryMaterialized();
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
      a.normalized_alias AS normalizedAlias, a.scope, a.confidence,
      c.allowed_units_json AS allowedUnitsJson, c.section_hints_json AS sectionHintsJson
    FROM indicator_aliases a
    JOIN indicator_catalog c ON c.id = a.indicator_id
    WHERE a.enabled = 1 AND a.normalized_alias IN (${placeholders})
  `).all(...names) as AliasRow[];
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
  const stoolContext = /便常规|粪便|大便/.test(context);
  const urineContext = /尿常规|尿沉渣|尿镜检|尿液|尿标本/.test(context);
  const ecgContext = /心电图|心电检查|静态心电|动态心电/.test(context);
  const generalPulseContext = /一般检查|基础测量|生命体征|内科/.test(context);
  for (const alias of aliases) {
    const allowedUnits = allowedUnitsFor(alias);
    const defaultUnit = normalizeUnit(alias.defaultUnit);
    const unitCompatible = !rawUnit
      || (!defaultUnit && allowedUnits.size === 0)
      || allowedUnits.has(rawUnit)
      || rawUnit === defaultUnit
      || Boolean(defaultUnit && canConvertIndicatorUnit(alias.canonicalKey, rawUnit, defaultUnit));
    const hasSectionHint = textHasAny(context, parseStringList(alias.sectionHintsJson));
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
    const hasNumericResult = (row.numericValue ?? parseNumericResultText(row.resultText)) !== null;
    if (hasNumericResult && alias.valueType === "numeric") {
      score += 15;
      reasons.push("结果类型为数值");
    } else if (hasNumericResult && alias.valueType !== "numeric") {
      score -= 15;
      reasons.push("结果类型与定性指标不符");
    } else if (!hasNumericResult && alias.valueType !== "numeric") {
      score += 10;
      reasons.push("结果类型为定性");
    }
    if (alias.canonicalKey === "glucose_fasting" && /尿|尿常规|尿液/i.test(context + row.itemName + (row.normalizedName || ""))) {
      score -= 80;
      reasons.push("尿液上下文不归入血糖趋势");
    }
    if (alias.canonicalKey === "renal_uric_acid" && /尿常规|尿液/i.test(context)) {
      score -= 35;
      reasons.push("尿液上下文降低置信度");
    }
    if ((stoolContext || urineContext) && /^cbc_/.test(alias.canonicalKey)) {
      score -= 120;
      reasons.push(stoolContext ? "便常规项目不得归入血常规" : "尿液项目不得归入血常规");
    }
    if (stoolContext && !/^stool_/.test(alias.canonicalKey)
      && ["白细胞", "红细胞", "白细胞计数", "红细胞计数", "WBC", "RBC"].some((name) =>
        indicatorNameCandidates(row.itemName).includes(compactIndicatorKey(name))
      )) {
      score -= 80;
      reasons.push("便常规同名项目只匹配便检指标");
    }
    if (urineContext && /^stool_/.test(alias.canonicalKey)) {
      score -= 120;
      reasons.push("尿液项目不得归入便常规");
    }
    if (ecgContext && alias.canonicalKey === "vital_pulse") {
      score -= 120;
      reasons.push("心电图心率不得归入一般脉搏");
    }
    if (generalPulseContext && !ecgContext && alias.canonicalKey === "ecg_heart_rate") {
      score -= 120;
      reasons.push("一般检查脉搏不得归入心电图心率");
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
    normalizationVersion()
  );
  updateUnmatchedNameOccurrence(result.observationId, result.canonicalKey);
  return migrateTrendPinsAfterNormalizationChange({
    memberId: previous?.memberId || null,
    oldCanonicalKey: previous?.canonicalKey || null,
    oldCanonicalUnit: normalizeUnit(previous?.canonicalUnit),
    newCanonicalKey: result.canonicalKey,
    newCanonicalUnit: normalizeUnit(result.canonicalUnit)
  });
}

function unmatchedFingerprint(rawName: string, unit: string | null, sectionName: string | null) {
  const identity = [
    compactIndicatorKey(rawName),
    normalizeUnit(unit) || "",
    compactIndicatorKey(sectionName)
  ].join("\u0000");
  return createHash("sha256").update(identity).digest("hex");
}

function resolveEmptyUnmatchedPoolItem(fingerprint: string | null | undefined) {
  if (!fingerprint) return;
  const db = getDatabase();
  const remaining = db.prepare(`
    SELECT COUNT(*) AS count
    FROM indicator_unmatched_occurrences
    WHERE fingerprint = ?
  `).get(fingerprint) as { count: number };
  if (Number(remaining.count) === 0) {
    db.prepare(`
      UPDATE indicator_unmatched_names
      SET status = CASE WHEN status = 'open' THEN 'resolved' ELSE status END,
        updated_at = CURRENT_TIMESTAMP
      WHERE fingerprint = ?
    `).run(fingerprint);
  }
}

function updateUnmatchedNameOccurrence(observationId: string, canonicalKey: string | null) {
  const db = getDatabase();
  const previous = db.prepare(`
    SELECT fingerprint FROM indicator_unmatched_occurrences WHERE observation_id = ?
  `).get(observationId) as { fingerprint: string } | undefined;
  if (canonicalKey) {
    db.prepare("DELETE FROM indicator_unmatched_occurrences WHERE observation_id = ?").run(observationId);
    resolveEmptyUnmatchedPoolItem(previous?.fingerprint);
    return;
  }
  const row = db.prepare(`
    SELECT o.report_id AS reportId, o.item_name AS rawName, o.normalized_name AS normalizedName,
      o.unit, o.section_name AS sectionName, o.result_text AS resultText
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    WHERE o.id = ? AND r.status <> 'trashed'
  `).get(observationId) as {
    reportId: string;
    rawName: string;
    normalizedName: string | null;
    unit: string | null;
    sectionName: string | null;
    resultText: string;
  } | undefined;
  if (!row) {
    db.prepare("DELETE FROM indicator_unmatched_occurrences WHERE observation_id = ?").run(observationId);
    resolveEmptyUnmatchedPoolItem(previous?.fingerprint);
    return;
  }
  const normalizedName = compactIndicatorKey(row.normalizedName || row.rawName);
  const fingerprint = unmatchedFingerprint(row.normalizedName || row.rawName, row.unit, row.sectionName);
  db.prepare(`
    INSERT INTO indicator_unmatched_names (
      fingerprint, normalized_name, raw_name, unit, section_name, sample_result,
      status, first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(fingerprint) DO UPDATE SET
      normalized_name = excluded.normalized_name,
      raw_name = excluded.raw_name,
      unit = excluded.unit,
      section_name = excluded.section_name,
      sample_result = excluded.sample_result,
      status = CASE WHEN indicator_unmatched_names.status = 'resolved' THEN 'open' ELSE indicator_unmatched_names.status END,
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    fingerprint,
    normalizedName,
    row.rawName,
    normalizeUnit(row.unit),
    row.sectionName,
    row.resultText.slice(0, 300)
  );
  db.prepare(`
    INSERT INTO indicator_unmatched_occurrences (observation_id, fingerprint, report_id)
    VALUES (?, ?, ?)
    ON CONFLICT(observation_id) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      report_id = excluded.report_id
  `).run(observationId, fingerprint, row.reportId);
  if (previous?.fingerprint && previous.fingerprint !== fingerprint) {
    resolveEmptyUnmatchedPoolItem(previous.fingerprint);
  }
}

function synchronizeUnmatchedNamePool() {
  const db = getDatabase();
  db.prepare(`
    DELETE FROM indicator_unmatched_occurrences
    WHERE observation_id IN (
      SELECT o.id
      FROM observations o
      JOIN reports r ON r.id = o.report_id
      LEFT JOIN observation_normalizations n ON n.observation_id = o.id
      WHERE r.status = 'trashed' OR n.canonical_key IS NOT NULL
    )
  `).run();
  const unmatched = db.prepare(`
    SELECT o.id
    FROM observations o
    JOIN reports r ON r.id = o.report_id
    LEFT JOIN observation_normalizations n ON n.observation_id = o.id
    WHERE r.status <> 'trashed'
      AND (n.observation_id IS NULL OR n.canonical_key IS NULL)
  `).all() as Array<{ id: string }>;
  for (const row of unmatched) updateUnmatchedNameOccurrence(row.id, null);
  db.prepare(`
    UPDATE indicator_unmatched_names
    SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM indicator_unmatched_occurrences occurrence
        WHERE occurrence.fingerprint = indicator_unmatched_names.fingerprint
      )
  `).run();
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
    WHERE r.status <> 'trashed'
      AND r.deleted_at IS NULL
      AND (n.observation_id IS NULL OR n.canonical_key IS NULL OR n.version <> ?)
    ORDER BY o.report_id, o.id
  `).all(normalizationVersion()) as Array<ObservationRow & {
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
    pinsMigrated: 0,
    version: activeIndicatorDictionaryVersion()
  };
  for (const row of rows) {
    const normalized = normalizeObservationWithReadyCatalog(row);
    if (normalized.canonicalKey) {
      result.pinsMigrated += upsertNormalization(normalized);
      result.updated += 1;
      continue;
    }
    result.unmatched += 1;
    upsertNormalization(normalized);
  }
  return result;
}

function normalizePendingReportObservations(reportId: string): IndicatorNormalizationMaintenanceResult {
  return collectNormalizationResult(pendingObservationRowsForReport(reportId));
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

export async function normalizeAllObservationsFromDictionary(
  user: RequestUser,
  options?: {
    full?: boolean;
    taskId?: string;
    onProgress?: (progress: IndicatorNormalizationMaintenanceProgress) => void;
  }
): Promise<IndicatorNormalizationMaintenanceResult> {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可维护指标归一化" });
  ensureBuiltinIndicatorCatalog();
  const trendPinSnapshot = options?.full ? snapshotTrendPinMappings() : [];
  if (options?.full) {
    getDatabase().prepare(`
      DELETE FROM observation_normalizations
      WHERE observation_id IN (
        SELECT observation.id
        FROM observations observation
        JOIN reports report ON report.id = observation.report_id
        WHERE report.status <> 'trashed' AND report.deleted_at IS NULL
      )
    `).run();
  }
  const reportIds = getDatabase().prepare(`
    SELECT DISTINCT observation.report_id AS reportId
    FROM observations observation
    JOIN reports report ON report.id = observation.report_id
    LEFT JOIN observation_normalizations normalization
      ON normalization.observation_id = observation.id
    WHERE report.status <> 'trashed'
      AND report.deleted_at IS NULL
      AND (normalization.observation_id IS NULL OR normalization.canonical_key IS NULL)
    ORDER BY observation.report_id
  `).all() as Array<{ reportId: string }>;
  const total = createEmptyMaintenanceResult();
  options?.onProgress?.({
    totalReports: reportIds.length,
    processedReports: 0,
    result: total
  });
  let processedReports = 0;
  for (const row of reportIds) {
    addMaintenanceResult(total, normalizePendingReportObservations(row.reportId));
    processedReports += 1;
    options?.onProgress?.({
      totalReports: reportIds.length,
      processedReports,
      result: total
    });
  }
  if (options?.full) total.pinsMigrated = migrateTrendPinsFromFullNormalization(trendPinSnapshot);
  synchronizeUnmatchedNamePool();
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, 'maintenance.normalize_indicators', 'observation', NULL, ?)
  `).run(createId("audit"), user.id, JSON.stringify({
    ...total,
    source: "indicator_dictionary",
    dictionaryVersion: activeIndicatorDictionaryVersion(),
    full: options?.full === true,
    taskId: options?.taskId || null
  }));
  return total;
}

export function listIndicatorNormalizationIssues(user: RequestUser): IndicatorNormalizationIssue[] {
  if (!user.isGatewayAdmin) throw createError({ statusCode: 403, statusMessage: "仅管理员可查看指标理解状态" });
  ensureBuiltinIndicatorCatalog();
  synchronizeUnmatchedNamePool();
  return getDatabase().prepare(`
    SELECT
      pool.raw_name AS rawName,
      pool.normalized_name AS normalizedName,
      pool.unit,
      pool.section_name AS sectionName,
      NULL AS hospitalName,
      'unknown' AS status,
      '未命中当前核心或远程指标字典' AS reason,
      COUNT(occurrence.observation_id) AS count,
      MAX(report.report_issued_at) AS latestReportIssuedAt
    FROM indicator_unmatched_names pool
    JOIN indicator_unmatched_occurrences occurrence ON occurrence.fingerprint = pool.fingerprint
    JOIN reports report ON report.id = occurrence.report_id
    WHERE pool.status = 'open'
    GROUP BY pool.fingerprint
    ORDER BY count DESC, pool.last_seen_at DESC
    LIMIT 100
  `).all() as IndicatorNormalizationIssue[];
}
