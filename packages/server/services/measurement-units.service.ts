import { getDatabase } from "../database/client";
import { ensureCoreDictionaryMaterialized } from "./indicator-dictionary.service";

/*
 * 通用测量单位兜底列表：覆盖常见医学报告单位，字典未覆盖时仍能识别。
 * 与 indicator_catalog 中的 default_unit / allowed_units_json 合并后生成最终匹配模式。
 */
const fallbackUnits = [
  "10\\^?\\d+\\/L",
  "mmol\\/L",
  "μmol\\/L",
  "umol\\/L",
  "nmol\\/L",
  "pmol\\/L",
  "mg\\/dL",
  "mg\\/L",
  "ng\\/mL",
  "μg\\/L",
  "g\\/L",
  "L\\/L",
  "mIU\\/L",
  "μIU\\/mL",
  "IU\\/L",
  "U\\/mL",
  "U\\/L",
  "Cell\\/HP",
  "Cast\\/LP",
  "cells?\\/HPF",
  "\\/HPF",
  "\\/LPF",
  "MPa\\.s",
  "cm\\/s",
  "mm\\/hr",
  "m\\/s",
  "mmHg",
  "bpm",
  "kg\\s*\\/\\s*m(?:2|²|㎡)",
  "kg",
  "cm",
  "mm",
  "mL",
  "mV",
  "ms",
  "Angle",
  "pg",
  "fL",
  "%",
  "℃"
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeUnit(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, "");
}

function dictionaryUnits() {
  ensureCoreDictionaryMaterialized();
  const rows = getDatabase().prepare(`
    SELECT default_unit AS defaultUnit, allowed_units_json AS allowedUnitsJson
    FROM indicator_catalog
    WHERE default_unit IS NOT NULL OR allowed_units_json <> '[]'
  `).all() as Array<{ defaultUnit: string | null; allowedUnitsJson: string }>;
  const units = new Set<string>();
  for (const row of rows) {
    if (row.defaultUnit) units.add(normalizeUnit(row.defaultUnit));
    try {
      const parsed = JSON.parse(row.allowedUnitsJson || "[]") as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item.trim()) units.add(normalizeUnit(item));
        }
      }
    } catch { /* 字典单位损坏时忽略，由通用列表兜底 */ }
  }
  return [...units].filter(Boolean).sort();
}

let cachedPattern: RegExp | null = null;
let cachedUnitsKey = "";

export function measurementUnitPattern() {
  const dynamic = dictionaryUnits();
  const key = dynamic.join("|");
  if (cachedPattern && cachedUnitsKey === key) return cachedPattern;
  const dynamicPatterns = dynamic.map(escapeRegExp);
  /* 长单位必须优先于短单位，否则 m 会提前截断 ms、mg/L、mmHg 等。 */
  const combined = [...new Set([...dynamicPatterns, ...fallbackUnits])]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  cachedPattern = new RegExp(`(?:${combined.join("|")})`, "i");
  cachedUnitsKey = key;
  return cachedPattern;
}

export function measurementUnitStripPattern() {
  return new RegExp(measurementUnitPattern().source, "gi");
}

export function unitFromResultCell(value: string) {
  const matched = value.match(measurementUnitPattern())?.[0];
  return matched ? matched.replace(/\s+/g, "") : null;
}

/*
 * 未知单位不直接判失败：从结果文本中提取疑似单位片段（数字后的非数字、非趋势字符），
 * 保留原文供归一化阶段处理，避免有效指标被保守放弃。
 */
export function inferUnknownUnit(value: string) {
  const cleaned = value.normalize("NFKC").replace(/[↑↓▲▼⬆⬇]/g, "").trim();
  const numericMatch = cleaned.match(/^(?:<|<=|≤|>|>=|≥)?\s*[-+]?\d+(?:\.\d+)?/);
  if (!numericMatch) return null;
  const tail = cleaned.slice(numericMatch[0].length).trim();
  if (!tail || tail.length > 30) return null;
  if (/^[|｜]/.test(tail)) return null;
  return tail;
}
