import { createHash } from "node:crypto";
import { createError } from "h3";
import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { assertMemberManage } from "./member.service";
import { ensureCoreDictionaryMaterialized } from "./indicator-dictionary.service";
import {
  classifyReportContent,
  classifyReportDocument,
  mergeContentClassifications,
  type ReportContentClassification
} from "./report-content-classifier.service";

export const aiInputPlanningPolicy = {
  version: "ocr-unit-plan-v11",
  targetCharacters: 8_000,
  maxPagesPerUnit: 12,
  maxSparsePagesPerUnit: 24,
  targetOutputTokens: 12_000,
  maxCandidateRowsPerUnit: 60
} as const;

type RawOcrLine = {
  id?: unknown;
  text?: unknown;
  confidence?: unknown;
  box?: unknown;
};

export type DictionaryCandidateFact = {
  canonicalKey: string;
  displayName: string;
  kind: "quantitative" | "categorical";
  valueType: "numeric" | "text" | "positive_negative";
  alias: string;
};

export type OcrLineRole =
  | "metadata"
  | "scalar"
  | "morphology"
  | "narrative"
  | "table_header"
  | "section_heading"
  | "noise"
  | "uncertain";

export type LocalObservationFact = {
  pageNumber: number;
  sourceLineId: string;
  sectionName: string | null;
  itemName: string;
  normalizedName: string;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  sourceText: string;
};

export type PlannedOcrLine = {
  id: string;
  sourceLineIds: string[];
  index: number;
  text: string;
  confidence: number | null;
  box: unknown;
  candidate: boolean;
  candidateKind: "scalar" | "morphology" | null;
  dictionaryFacts: DictionaryCandidateFact[];
  boundary: "section" | "table_header" | null;
  role: OcrLineRole;
  localObservation: LocalObservationFact | null;
  sectionName?: string | null;
  reportSectionName?: string | null;
  tableHeaderText?: string | null;
};

export type RebuiltOcrPage = {
  pageId: string;
  pageNumber: number;
  lineCount: number;
  characterCount: number;
  candidateRowCount: number;
  morphologyCandidateCount: number;
  narrativeLineCount: number;
  localObservationCount: number;
  sourceLineCount: number;
  removedLineCount: number;
  repeatedRemovedLineCount: number;
  noiseRemovedLineCount: number;
  text: string;
  lines: PlannedOcrLine[];
  classification: ReportContentClassification;
};

export type AiExtractionUnit = {
  unitKey: string;
  inputHash: string;
  unitType: "complete_pages" | "page_chunk" | "supplement";
  extractionMode: "scalar" | "morphology";
  route: "document" | "scalar" | "morphology" | "narrative" | "verification";
  allowDocumentFields: boolean;
  classification: ReportContentClassification;
  pageNumbers: number[];
  pageRanges: Array<{
    pageId: string;
    pageNumber: number;
    lineStart: number;
    lineEnd: number;
    chunkIndex: number;
    chunkCount: number;
  }>;
  characterCount: number;
  candidateRowCount: number;
  morphologyCandidateCount: number;
  localObservationCount: number;
  estimatedOutputTokens: number;
  lineCount: number;
  text: string;
  candidateFacts: Array<{
    pageNumber: number;
    kind: "scalar" | "morphology";
    sourceText: string;
    dictionaryFacts: DictionaryCandidateFact[];
  }>;
};

export type AiExtractionPlan = {
  policy: typeof aiInputPlanningPolicy;
  reportId: string;
  pageCount: number;
  sourceCharacterCount: number;
  candidateRowCount: number;
  morphologyCandidateCount: number;
  narrativeLineCount: number;
  localObservationCount: number;
  sourceLineCount: number;
  removedLineCount: number;
  repeatedRemovedLineCount: number;
  noiseRemovedLineCount: number;
  unitCount: number;
  planHash: string;
  documentClassification: ReportContentClassification;
  pages: RebuiltOcrPage[];
  units: AiExtractionUnit[];
};

const sectionHeadingPattern =
  /^(一般检查|基础测量|体格检查|内科|外科|眼科|耳鼻喉科?|口腔科?|妇科|检验检查|血液常规|血常规|便常规|尿常规|肝功能|肾功能|血脂|血糖|电解质|甲状腺功能|动脉粥样硬化指数|肿瘤标志物|功能检查|影像检查|超声检查|彩超|心电图|肺功能|骨密度|呼气试验|检查所见|检查结论|影像所见|影像结论|诊断意见|总检结论|体检综述|阳性发现|异常汇总|异常结果与健康建议|本次体检的异常结果汇总及建议|建议|主诉|现病史|既往史|门诊诊断|处理意见|处置|入院诊断|出院诊断|住院经过|手术经过|出院用药|出院医嘱|病理诊断|肉眼所见|镜下所见|免疫组化|病理分级|病理分期|处方)(?:[（(].*?[）)]|[一二三四五六七八九十\d]+项|[:：]|\s|$)/;
const tableHeaderPattern =
  /(项目|名称).{0,20}(结果|测定值|检查结果).{0,30}(参考|范围|单位)|(结果|测定值).{0,20}(单位|参考)/;
const medicalUnitPattern =
  /\b(?:mmol\/L|μmol\/L|umol\/L|nmol\/L|pmol\/L|μIU\/mL|mIU\/L|mg\/dL|mg\/L|ng\/mL|μg\/L|g\/L|L\/L|U\/mL|U\/L|IU\/L|10\^?\d+\/L|Cell\/HP|Cast\/LP|cells?\/HPF|\/HPF|cm\/s|mmHg|bpm|kg|cm|mm|mL|mV|ms|Angle|pg|fL|%|℃)\b/i;
const morphologyPattern =
  /(脂肪肝|囊肿|囊性(?:回声|灶)|结节|斑块|息肉|结石|钙化|占位|肿块|包块|积液|增生|萎缩|狭窄|扩张|病灶|(?:低|高|强|混合)回声|回声(?:不均|欠均|增强|减低|异常|团|区|灶)|(?:高|低|混合)?密度(?:影|灶|区|结节)|(?:边界|边缘)(?:不清|欠清|模糊|毛糙)|血流信号(?:丰富|增多|减少|异常|紊乱)|(?:BI-RADS|C-TIRADS|LI-RADS|Bosniak)\s*\d|分级\s*[:：]?\s*\d)/i;
const metadataCandidatePattern =
  /(?:报告号|门诊号|住院号|体检号|检查号|标本号|条码号|二维码|申请日期|报告日期|检查日期|采样日期|接收日期|审核日期|打印日期|打印时间|姓名|性别|年龄|出生日期|身份证|手机号|电话|地址|科室|病区|床号|医生)\s*[:：]/;
const redactionPlaceholderPattern =
  /\[(?:患者个资已过滤|已过滤身份证号|已过滤手机号|已过滤邮箱)\]/g;
const pageMarkerPattern =
  /^(?:第?\s*\d+\s*页(?:\s*[/／]?\s*共\s*\d+\s*页)?|\d+\s*[/／]\s*\d+\s*页?|页码\s*[:：]?\s*\d+(?:\s*[/／]\s*\d+)?)$/i;
const footerNoisePattern =
  /(?:本报告仅供|仅供临床参考|仅供参考|如有疑问.{0,16}(?:咨询|联系)|打印时间|打印日期|打印人|制表时间|客服电话|服务热线|官方网址|微信公众号|扫码关注|未经.*不得|报告声明)/;
const educationHeadingPattern =
  /^(?:专家)?健康(?:宣教|教育)|^疾病知识|^健康知识|^科普知识|^温馨提示/;
const historicalSectionPattern =
  /^(?:历史|既往|往年|历年|上次|前次)(?:检查|检测|检验|体检|报告)?结果(?:[（(]\d+[）)])?/;
const reportContentRestartPattern =
  /(?:检验|检查|体检|超声|心电图|病理|门诊|住院|出院|处方|疫苗|票据).{0,12}(?:报告|报告单)$|^(?:项目|名称).{0,20}(?:结果|测定值|检查结果)/;
const directoryLinePattern =
  /^(?:目录|contents?)$|[.．·•…]{2,}\s*\d{1,3}\s*$/i;
const businessNumberOnlyPattern =
  /^(?:[A-Z]{0,6}[-/]?)?\d{8,}(?:[-/]\d+)?$/i;
const metadataRowPattern =
  /(?:体检机构|体检编号|病历号|采样时间|报告时间|打印时间|初审时间|终检时间|申请时间|审核时间|报告医师)\s*[:：]/;
const referenceOnlyPattern =
  /^(?:参考值|参考范围|正常范围)\s*[:：]/;
const tableOfContentsRowPattern =
  /^\s*\d{1,2}\s*[|｜]\s*[^|｜]{2,80}\s*[|｜]\s*\d{1,3}\s*$/;
const nonResultTechnicalPattern =
  /(?:^|[|｜])\s*(?:增益|走速|纸速|试剂名称|试剂纯度|纯度)\s*[:：]|^\*?\s*baPWV主要检测|^反映脑血管或心脏|^(?:异常区域|正常区域)(?:\s*[|｜]\s*(?:异常区域|正常区域))?$/i;
const interpretationOnlyPattern =
  /(?:正常范围|未见异常)[。.]?$/;
const narrativeSectionHeadingPattern =
  /^(?:检查所见|检查结论|影像所见|影像结论|诊断意见|总检结论|体检综述|阳性发现|异常汇总|异常结果与健康建议|本次体检的异常结果汇总及建议|建议|主诉|现病史|既往史|门诊诊断|处理意见|处置|入院诊断|出院诊断|住院经过|手术经过|出院用药|出院医嘱|病理诊断|肉眼所见|镜下所见|免疫组化|病理分级|病理分期)(?:[：:]|\s|$)/;
const narrativeInlinePattern =
  /^(?:主诉|现病史|既往史|检查所见|检查结论|影像所见|影像结论|诊断意见|总检结论|体检综述|阳性发现|异常汇总|建议|处理意见|处置|住院经过|手术经过|出院医嘱|肉眼所见|镜下所见|免疫组化)\s*[:：]/;
const documentAnchorHeadingPattern =
  /^(?:总检结论|体检综述|阳性发现|异常汇总|异常结果与健康建议|本次体检的异常结果汇总及建议|建议|检查结论|影像结论|病理诊断|出院诊断|出院医嘱|住院经过)(?:[：:]|\s|$)/;

function isMorphologyCandidate(text: string) {
  if (!morphologyPattern.test(text)) return false;
  const withoutNegatedFindings = text
    .replace(/未见[^。；]{0,40}(?:囊肿|结节|斑块|息肉|结石|钙化|占位(?:性病变)?|肿块|包块|积液|增生|萎缩|狭窄|扩张|病灶|异常回声|异常血流信号)/g, "")
    .replace(/(?:大小|形态大小|内部回声|血流信号)[^。；]{0,20}(?:正常|均匀|良好)/g, "");
  if (/未见[^。；]{0,30}异常[^。；]{0,20}(?:C-TIRADS|BI-RADS)\s*1\s*类/i.test(text)) {
    return isMorphologyCandidate(withoutNegatedFindings.replace(/C-TIRADS|BI-RADS/gi, ""));
  }
  return morphologyPattern.test(withoutNegatedFindings);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

type DictionaryAliasRow = DictionaryCandidateFact & {
  normalizedAlias: string;
};

function compactDictionaryText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[（）()：:，,。.;；、|\s_\-]/g, "")
    .replace(/[＋]/g, "+")
    .trim();
}

function activeDictionaryAliases() {
  ensureCoreDictionaryMaterialized();
  return getDatabase().prepare(`
    SELECT c.canonical_key AS canonicalKey, c.display_name AS displayName,
      CASE WHEN c.observation_kind = 'categorical' THEN 'categorical' ELSE 'quantitative' END AS kind,
      c.value_type AS valueType, a.alias_name AS alias, a.normalized_alias AS normalizedAlias
    FROM indicator_aliases a
    JOIN indicator_catalog c ON c.id = a.indicator_id
    WHERE a.enabled = 1
    ORDER BY LENGTH(a.normalized_alias) DESC, c.canonical_key
  `).all() as DictionaryAliasRow[];
}

function dictionaryFactsForText(text: string, aliases: DictionaryAliasRow[]) {
  const firstCell = text.split(/[|｜]/)[0]?.trim() || text;
  const tableRow = /[|｜]/.test(text);
  const compact = compactDictionaryText(tableRow ? firstCell : text);
  if (!compact) return [];
  const facts = new Map<string, DictionaryCandidateFact>();
  for (const row of aliases) {
    const alias = compactDictionaryText(row.normalizedAlias || row.alias);
    if (!alias || facts.has(row.canonicalKey)) continue;
    const asciiCode = /^[a-z][a-z0-9.+#%]{0,15}$/i.test(alias);
    if (asciiCode && alias.length < 2) continue;
    if (!asciiCode && alias.length < 1) continue;
    const matched = asciiCode
      ? new RegExp(`(?:^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i")
        .test(firstCell.normalize("NFKC"))
      : tableRow ? compact === alias : compact.includes(alias);
    if (!matched) continue;
    facts.set(row.canonicalKey, {
      canonicalKey: row.canonicalKey,
      displayName: row.displayName,
      kind: row.kind,
      valueType: row.valueType,
      alias: row.alias
    });
    if (facts.size >= 8) break;
  }
  return [...facts.values()];
}

type BoxRect = { left: number; top: number; right: number; bottom: number };

function boxRect(value: unknown): BoxRect | null {
  if (!Array.isArray(value)) return null;
  const points = Array.isArray(value[0])
    ? value.flatMap((point) =>
      Array.isArray(point) && point.length >= 2 ? [{ x: Number(point[0]), y: Number(point[1]) }] : []
    )
    : value.length >= 4
      ? [
          { x: Number(value[0]), y: Number(value[1]) },
          { x: Number(value[2]), y: Number(value[3]) }
        ]
      : [];
  if (!points.length || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y))
  };
}

function rectHeight(rect: BoxRect) {
  return Math.max(1, rect.bottom - rect.top);
}

function verticalOverlap(left: BoxRect, right: BoxRect) {
  return Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
    / Math.max(1, Math.min(rectHeight(left), rectHeight(right)));
}

function horizontalOverlap(left: BoxRect, right: BoxRect) {
  const width = (rect: BoxRect) => Math.max(1, rect.right - rect.left);
  return Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    / Math.max(1, Math.min(width(left), width(right)));
}

function mergeVisualRow(lines: PlannedOcrLine[], index: number, aliases: DictionaryAliasRow[]): PlannedOcrLine {
  const ordered = [...lines].sort((left, right) =>
    (boxRect(left.box)?.left ?? left.index) - (boxRect(right.box)?.left ?? right.index)
  );
  const rects = ordered.map((line) => boxRect(line.box)).filter((rect): rect is BoxRect => Boolean(rect));
  const text = redactAiInputText(ordered.map((line) => line.text).join(" | "));
  const boundary = boundaryFor(text);
  const dictionaryFacts = dictionaryFactsForText(text, aliases);
  const morphology = isMorphologyCandidate(text);
  const nonResultNoise = isNonResultNoise(text);
  const dictionaryResult = boundary !== "section"
    && !nonResultNoise
    && dictionaryFacts.length > 0
    && /\d|阴性|阳性|弱阳性|正常|异常|未见|可见/.test(text)
    && !metadataCandidatePattern.test(text)
    && !metadataRowPattern.test(text);
  const candidate = boundary === "section" || nonResultNoise
    ? false
    : morphology || isCandidateRow(text) || dictionaryResult;
  const candidateKind = candidate && morphology ? "morphology" : candidate ? "scalar" : null;
  const role: OcrLineRole = nonResultNoise
    ? "noise"
    : boundary === "table_header"
      ? "table_header"
      : boundary === "section"
        ? "section_heading"
        : metadataCandidatePattern.test(text) || metadataRowPattern.test(text)
          ? "metadata"
          : candidateKind === "morphology"
            ? "morphology"
            : candidateKind === "scalar"
              ? "scalar"
              : narrativeInlinePattern.test(text)
                ? "narrative"
                : "uncertain";
  return {
    id: ordered.length === 1 ? ordered[0].id : `layout_row_${ordered.map((line) => line.id).join("_")}`,
    sourceLineIds: ordered.flatMap((line) => line.sourceLineIds),
    index,
    text,
    confidence: ordered.every((line) => line.confidence !== null)
      ? ordered.reduce((sum, line) => sum + (line.confidence || 0), 0) / ordered.length
      : null,
    box: rects.length
      ? [Math.min(...rects.map((rect) => rect.left)), Math.min(...rects.map((rect) => rect.top)),
          Math.max(...rects.map((rect) => rect.right)), Math.max(...rects.map((rect) => rect.bottom))]
      : ordered[0].box,
    candidate,
    candidateKind,
    dictionaryFacts,
    boundary,
    role,
    localObservation: null
  };
}

function isNonResultNoise(text: string) {
  const trimmed = text.trim();
  if (nonResultTechnicalPattern.test(trimmed)) return true;
  return interpretationOnlyPattern.test(trimmed)
    && !/[|｜]/.test(trimmed)
    && !/(?:检验|检查|报告)?结果\s*[:：]/.test(trimmed);
}

function reconstructPageLayout(lines: PlannedOcrLine[], aliases: DictionaryAliasRow[]) {
  const positioned = lines.filter((line) => boxRect(line.box));
  if (positioned.length < Math.max(2, Math.ceil(lines.length * 0.6))) {
    return lines.map((line, index) => mergeVisualRow([line], index, aliases));
  }
  const sorted = [...lines].sort((left, right) => {
    const leftRect = boxRect(left.box);
    const rightRect = boxRect(right.box);
    if (!leftRect || !rightRect) return left.index - right.index;
    const topDifference = leftRect.top - rightRect.top;
    if (Math.abs(topDifference) > Math.min(rectHeight(leftRect), rectHeight(rightRect)) * 0.45) {
      return topDifference;
    }
    return leftRect.left - rightRect.left;
  });
  const rows: PlannedOcrLine[][] = [];
  for (const line of sorted) {
    const rect = boxRect(line.box);
    if (!rect) {
      rows.push([line]);
      continue;
    }
    const row = [...rows].reverse().find((candidate: PlannedOcrLine[]) => {
      const candidateRects = candidate.map((item) => boxRect(item.box)).filter((item): item is BoxRect => Boolean(item));
      if (!candidateRects.length) return false;
      const rowRect = {
        left: Math.min(...candidateRects.map((item) => item.left)),
        top: Math.min(...candidateRects.map((item) => item.top)),
        right: Math.max(...candidateRects.map((item) => item.right)),
        bottom: Math.max(...candidateRects.map((item) => item.bottom))
      };
      return verticalOverlap(rowRect, rect) >= 0.55
        && candidateRects.every((item) => horizontalOverlap(item, rect) < 0.25);
    });
    if (row) row.push(line);
    else rows.push([line]);
  }
  return rows.map((row, index) => mergeVisualRow(row, index, aliases));
}

function mergeWrappedPageLines(lines: PlannedOcrLine[], aliases: DictionaryAliasRow[]) {
  const merged: PlannedOcrLine[] = [];
  for (const line of lines) {
    const previous = merged.at(-1);
    const combinedText = previous ? `${previous.text}${line.text}` : "";
    const shouldMerge = Boolean(
      previous
      && !/[|｜]/.test(previous.text)
      && !/[|｜]/.test(line.text)
      && !previous.boundary
      && !line.boundary
      && !/[。！？；;:：]$/.test(previous.text)
      && (!isCandidateRow(line.text) || /(?:直径约\d+[a-z]?|水平位(?:[（(][^）)]*[）)])?生|血流充盈)$/i.test(previous.text))
      && (
        previous.text.length >= 24
        || previous.candidateKind === "morphology"
        || /(?:直径约\d+[a-z]?|水平位(?:[（(][^）)]*[）)])?生|血流充盈|回声|建议|复查|随诊)$/i.test(previous.text)
      )
      && (
        isMorphologyCandidate(combinedText)
        || /(?:建议|复查|随诊|定期观察)/.test(combinedText)
        || /^[a-zA-Z，,、）)；;。]/.test(line.text)
        || previous.text.length >= 36
      )
    );
    if (!previous || !shouldMerge) {
      merged.push(line);
      continue;
    }
    const rebuilt = mergeVisualRow([{ ...previous, text: combinedText }], previous.index, aliases);
    merged[merged.length - 1] = {
      ...rebuilt,
      id: `wrapped_${previous.id}_${line.id}`,
      sourceLineIds: [...previous.sourceLineIds, ...line.sourceLineIds],
      confidence: previous.confidence !== null && line.confidence !== null
        ? (previous.confidence + line.confidence) / 2
        : previous.confidence ?? line.confidence,
      box: previous.box
    };
  }
  return merged.map((line, index) => ({ ...line, index }));
}

type PageLineContext = {
  section: string | null;
  reportSection: string | null;
  narrativeActive: boolean;
  tableHeader: string[] | null;
  pageNumber: number | null;
  endedWithCandidate: boolean;
};

function cleanSectionHeading(value: string) {
  return value.replace(/^【\s*|\s*】$/g, "").replace(/[:：]$/, "").trim() || null;
}

function cleanContextLabel(value: string) {
  return value.replace(/^【\s*|\s*】$/g, "").replace(/[:：]$/, "").trim();
}

function splitTableCells(value: string) {
  return value.split(/[|｜]/).map((cell) => cell.trim());
}

const resultCellPattern = /^(?:<|<=|≤|>|>=|≥)?\s*(?:[-+±]+|[-+]?\d+(?:\.\d+)?|阴性|阳性|弱阳性|正常|异常|未见(?:异常)?|可见|无特殊)(?:\s|$|[↑↓▲▼⬆⬇])/;
const reportHeadingPattern = /(?:检验|检查|体检|超声|心电图|病理|门诊|住院|出院|动脉阻塞|动脉功能).{0,18}(?:报告|报告单)$/;

function unitFromResultCell(value: string) {
  return value.match(
    /(?:10\^?\d+\/L|mmol\/L|μmol\/L|umol\/L|nmol\/L|pmol\/L|mg\/dL|mg\/L|ng\/mL|μg\/L|g\/L|L\/L|U\/mL|U\/L|IU\/L|Cell\/HP|Cast\/LP|\/HPF|\/LPF|cm\/s|mmHg|bpm|kg\s*\/\s*m(?:2|²|㎡)|kg|cm|mm|mL|mV|ms|Angle|pg|fL|%)/i
  )?.[0]?.replace(/\s+/g, "") || null;
}

function parseReferenceCell(value: string) {
  const clean = value.normalize("NFKC").replace(/\s+/g, "").trim();
  if (!clean) return { low: null, high: null, text: null };
  const range = clean.match(/^([-+]?\d+(?:\.\d+)?)\s*(?:-|~|～|—|至)\s*([-+]?\d+(?:\.\d+)?)/);
  if (range) {
    return { low: Number(range[1]), high: Number(range[2]), text: clean };
  }
  const upper = clean.match(/^(?:<|≤|小于|不高于)([-+]?\d+(?:\.\d+)?)/);
  if (upper) return { low: null, high: Number(upper[1]), text: clean };
  const lower = clean.match(/^(?:>|≥|大于|不低于)([-+]?\d+(?:\.\d+)?)/);
  if (lower) return { low: Number(lower[1]), high: null, text: clean };
  return { low: null, high: null, text: clean };
}

function localAbnormalFlag(value: string): LocalObservationFact["abnormalFlag"] {
  if (/[↑▲⬆]|偏高/.test(value)) return "high";
  if (/[↓▼⬇]|偏低/.test(value)) return "low";
  if (/(?:^|[\s|｜])(?:阳性|弱阳性|异常|\*)(?:$|[\s|｜])/.test(value)) return "abnormal";
  if (/(?:^|[\s|｜])正常(?:$|[\s|｜])/.test(value)) return "normal";
  return null;
}

function parseLocalObservation(
  line: PlannedOcrLine,
  pageNumber: number,
  section: string | null,
  tableHeader: string[] | null
): LocalObservationFact | null {
  if (
    line.candidateKind !== "scalar"
    || line.dictionaryFacts.length > 1
    || (line.confidence !== null && line.confidence < 0.65)
  ) return null;
  const inlineResult = line.text.match(
    /^(.{2,60}?)(?:检验|检查)?结果\s*[:：]\s*(阴性|阳性|弱阳性|正常|异常|未见异常|未见|可见)\s*[。.]?$/i
  );
  if (inlineResult && !/[|｜]/.test(line.text) && (section || line.dictionaryFacts.length === 1)) {
    const dictionary = line.dictionaryFacts[0] || null;
    return {
      pageNumber,
      sourceLineId: line.id,
      sectionName: section,
      itemName: inlineResult[1].trim(),
      normalizedName: dictionary?.displayName || inlineResult[1].trim(),
      resultText: inlineResult[2],
      numericValue: null,
      unit: null,
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      abnormalFlag: localAbnormalFlag(inlineResult[2]),
      sourceText: line.text
    };
  }
  const cells = splitTableCells(line.text);
  if (cells.length < 2) return null;
  const nameIndex = tableHeader?.findIndex((cell) => /^(?:项目|名称|检验项目|检查项目)/.test(cell)) ?? 0;
  const headerResultIndex = tableHeader?.findIndex((cell) =>
    /(?:本次结果|检查结果|检验结果|测定值|结果)/.test(cell)
    && !/(?:历史|既往|上次|前次|往年)/.test(cell)
  ) ?? -1;
  const resultIndex = headerResultIndex >= 0 ? headerResultIndex : nameIndex + 1;
  if (nameIndex < 0 || resultIndex < 0 || !cells[nameIndex] || !cells[resultIndex]) return null;
  const resultText = cells[resultIndex].trim();
  if (
    !resultCellPattern.test(resultText)
    || /^\d{4}[-/.年]\d{1,2}/.test(resultText)
  ) return null;
  const unitIndex = tableHeader?.findIndex((cell) => /单位/.test(cell)) ?? -1;
  const referenceIndex = tableHeader?.findIndex((cell) => /(?:参考|正常范围)/.test(cell)) ?? -1;
  const inferredReference = referenceIndex < 0 && cells[resultIndex + 1]
    ? parseReferenceCell(cells[resultIndex + 1])
    : { low: null, high: null, text: null };
  const reference = referenceIndex >= 0 && cells[referenceIndex]
    ? parseReferenceCell(cells[referenceIndex])
    : inferredReference.low !== null || inferredReference.high !== null
      ? inferredReference
      : { low: null, high: null, text: null };
  const unit = unitIndex >= 0 && cells[unitIndex]
    ? cells[unitIndex].trim() || null
    : unitFromResultCell(resultText);
  const numericMatch = resultText.match(/^(?:<|<=|≤|>|>=|≥)?\s*([-+]?\d+(?:\.\d+)?)/);
  const numericValue = numericMatch ? Number(numericMatch[1]) : null;
  const dictionary = line.dictionaryFacts[0] || null;
  if (!dictionary && (!section || !/^(?:[-+±]+|阴性|阳性|弱阳性|正常|异常|未见(?:异常)?|可见)$/.test(resultText))) {
    return null;
  }
  return {
    pageNumber,
    sourceLineId: line.id,
    sectionName: section,
    itemName: cells[nameIndex],
    normalizedName: dictionary?.displayName || cells[nameIndex],
    resultText,
    numericValue: numericValue !== null && Number.isFinite(numericValue) ? numericValue : null,
    unit,
    referenceLow: reference.low,
    referenceHigh: reference.high,
    referenceText: reference.text,
    abnormalFlag: localAbnormalFlag(resultText),
    sourceText: line.text
  };
}

function annotatePageLines(
  lines: PlannedOcrLine[],
  pageNumber: number,
  previous: PageLineContext
) {
  const firstContent = lines.find((line) => line.role !== "noise");
  const hasNewBoundary = lines.slice(0, 8).some((line) =>
    line.boundary === "section" || line.boundary === "table_header" || reportHeadingPattern.test(cleanContextLabel(line.text))
  );
  const inheritContext = previous.pageNumber === pageNumber - 1
    && previous.endedWithCandidate
    && Boolean(firstContent?.candidate)
    && !hasNewBoundary;
  let section = inheritContext ? previous.section : null;
  let reportSection = inheritContext ? previous.reportSection : null;
  let narrativeActive = false;
  let tableHeader = inheritContext ? previous.tableHeader : null;
  const annotated = lines.map((line): PlannedOcrLine => {
    let role = line.role;
    if (line.boundary === "section") {
      const heading = cleanSectionHeading(line.text);
      if (heading && reportHeadingPattern.test(heading)) {
        reportSection = heading;
        section = null;
      } else {
        section = heading;
      }
      narrativeActive = narrativeSectionHeadingPattern.test(line.text);
      tableHeader = null;
      role = "section_heading";
    } else if (line.boundary === "table_header") {
      tableHeader = splitTableCells(line.text);
      narrativeActive = false;
      role = "table_header";
    } else if (reportHeadingPattern.test(cleanContextLabel(splitTableCells(line.text)[0] || ""))) {
      reportSection = cleanContextLabel(splitTableCells(line.text)[0] || "");
      section = null;
      tableHeader = null;
    } else if (narrativeInlinePattern.test(line.text)) {
      narrativeActive = true;
      role = "narrative";
    } else if (/(?:建议|复查|随诊|定期观察|健康管理)/.test(line.text) && /[。；;]/.test(line.text)) {
      role = "narrative";
    } else if ((role === "uncertain" || role === "noise") && narrativeActive) {
      role = "narrative";
    }
    const withRole = { ...line, role };
    const sectionName = section && reportSection && !section.includes(reportSection)
      ? `${reportSection} / ${section}`
      : section || reportSection;
    return {
      ...withRole,
      sectionName,
      reportSectionName: reportSection,
      tableHeaderText: tableHeader?.join(" | ") || null,
      localObservation: parseLocalObservation(withRole, pageNumber, sectionName, tableHeader)
    };
  });
  let lastCandidateIndex = -1;
  for (let index = annotated.length - 1; index >= 0; index -= 1) {
    if (!annotated[index].candidate) continue;
    lastCandidateIndex = index;
    break;
  }
  const hasLaterBoundary = lastCandidateIndex >= 0 && annotated.slice(lastCandidateIndex + 1)
    .some((line) => line.boundary === "section" || line.boundary === "table_header");
  return {
    lines: annotated,
    context: {
      section,
      reportSection,
      narrativeActive,
      tableHeader,
      pageNumber,
      endedWithCandidate: lastCandidateIndex >= 0
        && !hasLaterBoundary
        && annotated.length - lastCandidateIndex <= 24
    } satisfies PageLineContext
  };
}

export function estimateAiUnitOutputTokens(input: {
  pageCount: number;
  characterCount: number;
  candidateRowCount: number;
  morphologyCandidateCount: number;
}) {
  const narrativeAllowance = Math.min(768, Math.ceil(Math.max(0, input.characterCount) / 8));
  return 768
    + Math.max(1, input.pageCount) * 96
    + Math.max(0, input.candidateRowCount) * 100
    + Math.max(0, input.morphologyCandidateCount) * 180
    + narrativeAllowance;
}

function unitFromRanges(
  unitType: AiExtractionUnit["unitType"],
  ranges: AiExtractionUnit["pageRanges"],
  pages: RebuiltOcrPage[],
  route: AiExtractionUnit["route"],
  allowDocumentFields = false
): AiExtractionUnit {
  const extractionMode: AiExtractionUnit["extractionMode"] = route === "morphology" ? "morphology" : "scalar";
  const rendered = ranges.map((range) => {
    const page = pages.find((item) => item.pageId === range.pageId);
    if (!page) return "";
    const rangeLines = page.lines.filter((line) =>
      line.index >= range.lineStart && line.index <= range.lineEnd
    );
    const candidateIndexes = new Set(rangeLines
      .filter((line) =>
        route === "morphology"
          ? line.candidateKind === "morphology"
          : route === "scalar"
            ? line.candidateKind === "scalar" && !line.localObservation
            : false
      )
      .map((line) => line.index));
    const narrativeWholePage = route === "narrative" && page.classification.contentTypes.some((type) =>
      ["outpatient", "inpatient", "pathology", "prescription", "billing", "vaccination"].includes(type)
    );
    const lines = route === "morphology"
      ? rangeLines.filter((line) =>
          line.boundary === "section"
          || line.boundary === "table_header"
          || [...candidateIndexes].some((index) => Math.abs(line.index - index) <= 1)
        )
      : route === "scalar"
        ? rangeLines.filter((line) =>
            candidateIndexes.has(line.index)
            || line.boundary === "table_header"
            || (line.boundary === "section"
              && [...candidateIndexes].some((index) => line.index < index))
          )
        : route === "narrative"
          ? rangeLines.filter((line) =>
              (narrativeWholePage && !["noise", "morphology"].includes(line.role))
              || line.role === "narrative"
              || (line.role === "section_heading" && narrativeSectionHeadingPattern.test(line.text))
            )
          : rangeLines;
    const chunkLabel = range.chunkCount > 1 ? ` · 内容分块 ${range.chunkIndex}/${range.chunkCount}` : "";
    return `[第 ${range.pageNumber} 页${chunkLabel}]\n${lines.map((line) => line.text).join("\n")}`;
  }).filter(Boolean);
  const routeLabel = route === "morphology"
    ? "形态发现"
    : route === "narrative" ? "原文章节" : route === "document" ? "文档概况" : "指标";
  const text = `[解析任务：${routeLabel}]\n${rendered.join("\n\n")}`;
  const inputHash = sha256([
    aiInputPlanningPolicy.version,
    unitType,
    route,
    allowDocumentFields ? "document" : "facts",
    text
  ].join("\u0000"));
  const rangeKey = ranges.map((range) =>
    `${range.pageNumber}:${range.lineStart}-${range.lineEnd}:${range.chunkIndex}/${range.chunkCount}`
  ).join("|");
  const selectedLines = ranges.flatMap((range) => {
    const page = pages.find((item) => item.pageId === range.pageId);
    return page?.lines.filter((line) =>
      line.index >= range.lineStart && line.index <= range.lineEnd
    ) || [];
  });
  const candidateRowCount = route === "scalar" || route === "morphology"
    ? selectedLines.filter((line) =>
        line.candidateKind === extractionMode
        && (route !== "scalar" || !line.localObservation)
      ).length
    : 0;
  const morphologyCandidateCount = route === "morphology" ? candidateRowCount : 0;
  const localObservationCount = selectedLines.filter((line) => line.localObservation).length;
  const pageCount = new Set(ranges.map((range) => range.pageNumber)).size;
  const candidateFacts = route === "scalar" || route === "morphology" ? ranges.flatMap((range) => {
    const page = pages.find((item) => item.pageId === range.pageId);
    return (page?.lines || []).filter((line) =>
      line.index >= range.lineStart
      && line.index <= range.lineEnd
      && line.candidateKind === extractionMode
      && (route !== "scalar" || !line.localObservation)
    ).map((line) => ({
      pageNumber: range.pageNumber,
      kind: line.candidateKind as "scalar" | "morphology",
      sourceText: line.text,
      dictionaryFacts: line.dictionaryFacts
    }));
  }) : [];
  const classification = mergeContentClassifications(ranges.flatMap((range) => {
    const page = pages.find((item) => item.pageId === range.pageId);
    return page ? [page.classification] : [];
  }));
  return {
    unitKey: `unit_${sha256(`${unitType}|${route}|${rangeKey}|${inputHash}`).slice(0, 24)}`,
    inputHash,
    unitType,
    extractionMode,
    route,
    allowDocumentFields,
    classification,
    pageNumbers: [...new Set(ranges.map((range) => range.pageNumber))],
    pageRanges: ranges,
    characterCount: text.length,
    candidateRowCount,
    morphologyCandidateCount,
    localObservationCount,
    estimatedOutputTokens: estimateAiUnitOutputTokens({
      pageCount,
      characterCount: text.length,
      candidateRowCount,
      morphologyCandidateCount
    }),
    lineCount: ranges.reduce((sum, range) => sum + Math.max(0, range.lineEnd - range.lineStart + 1), 0),
    text,
    candidateFacts
  };
}

export function splitAiExtractionUnit(plan: AiExtractionPlan, unit: AiExtractionUnit) {
  if (unit.pageRanges.length > 1) {
    const midpoint = Math.ceil(unit.pageRanges.length / 2);
    return [
      unitFromRanges(
        "page_chunk",
        unit.pageRanges.slice(0, midpoint),
        plan.pages,
        unit.route,
        unit.allowDocumentFields
      ),
      unitFromRanges(
        "page_chunk",
        unit.pageRanges.slice(midpoint),
        plan.pages,
        unit.route,
        unit.allowDocumentFields
      )
    ].filter((item) => item.text.trim());
  }
  return [];
}

function redactUnlabeledPatientNameRows(value: string) {
  const name = "[患者个资已过滤]";
  return value
    .replace(
      /(^|\n)(\s*)[\u3400-\u9fff·•]{2,20}(\s*[|｜]\s*(?:男|女|男性|女性)\s*[|｜]\s*\d{1,3}\s*岁(?=\s*(?:[|｜]|\n|$)))/g,
      `$1$2${name}$3`
    )
    .replace(
      /(^|\n)(\s*)[\u3400-\u9fff·•]{2,20}(\s*[|｜]\s*\d{1,3}\s*岁\s*[|｜]\s*(?:男|女|男性|女性)(?=\s*(?:[|｜]|\n|$)))/g,
      `$1$2${name}$3`
    );
}

export function redactAiInputText(value: string) {
  return redactUnlabeledPatientNameRows(value)
    .replace(/((?:患者)?姓名|受检者|病人姓名)\s*[:：]?\s*[^\s,，;；|]{1,20}/gi, "[患者个资已过滤]")
    .replace(/(身份证(?:号)?|证件号码?)\s*[:：]?\s*[0-9Xx-]{8,24}/gi, "[患者个资已过滤]")
    .replace(/(联系电话|手机号码?|手机号|电话)\s*[:：]?\s*[+\d()\s-]{7,24}/gi, "[患者个资已过滤]")
    .replace(
      /(家庭住址|通讯地址|现住址|联系地址|地址)\s*[:：]?\s*[^|,，;；]{3,80}?(?=(?:报告号|门诊号|住院号|体检号|检查号|标本号|条码号)\s*[:：]|[|,，;；]|$)/gi,
      "[患者个资已过滤] "
    )
    .replace(/(电子邮箱|邮箱|E-?mail)\s*[:：]?\s*[^\s,，;；|]+/gi, "[患者个资已过滤]")
    .replace(/(出生日期|出生年月|出生时间)\s*[:：]?\s*\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?/gi, "[患者个资已过滤]")
    .replace(/(^|\D)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)/g, "$1[已过滤身份证号]")
    .replace(/(^|\D)1[3-9]\d{9}(?!\d)/g, "$1[已过滤手机号]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[已过滤邮箱]");
}

function boundaryFor(text: string): PlannedOcrLine["boundary"] {
  const compact = text.trim();
  if (tableHeaderPattern.test(compact)) return "table_header";
  const cells = splitTableCells(compact).filter(Boolean);
  if (cells.length > 1) {
    const first = cleanContextLabel(cells[0]);
    const allHeadings = cells.every((cell) =>
      sectionHeadingPattern.test(cleanContextLabel(cell))
      || /^(?:诊断所见|诊断结果|检查描述|检查提示)$/.test(cleanContextLabel(cell))
    );
    const bilingualHeading = (sectionHeadingPattern.test(first) || reportHeadingPattern.test(first))
      && cells.slice(1).every((cell) => /^[A-Za-z][A-Za-z\s&/()-]{2,}$/.test(cell));
    if (allHeadings || bilingualHeading) return "section";
    return null;
  }
  const sectionText = compact
    .replace(/^【\s*|\s*】$/g, "")
    .replace(/[:：]$/, "")
    .trim();
  if (
    compact.length <= 48
    && (
      /^【[^】]{1,40}】$/.test(compact)
      || sectionHeadingPattern.test(sectionText)
      || historicalSectionPattern.test(sectionText)
      || reportContentRestartPattern.test(sectionText)
      || (/[:：]$/.test(compact) && !/\d/.test(compact))
    )
  ) return "section";
  return null;
}

function isCandidateRow(text: string) {
  const trimmed = text.trim();
  if (isNonResultNoise(trimmed)) return false;
  if (tableHeaderPattern.test(text)) return false;
  if (metadataCandidatePattern.test(text) || pageMarkerPattern.test(text.trim())) return false;
  if (metadataRowPattern.test(text) || referenceOnlyPattern.test(trimmed)) return false;
  if (directoryLinePattern.test(trimmed) || businessNumberOnlyPattern.test(trimmed)) return false;
  if (tableOfContentsRowPattern.test(trimmed)) return false;
  if (/\d{12,}/.test(text) && !medicalUnitPattern.test(text) && !/(参考值|参考范围|正常范围)/.test(text)) {
    return false;
  }
  const firstCell = trimmed.split(/[|｜]/)[0]?.trim() || "";
  const cells = trimmed.split(/[|｜]/).map((cell) => cell.trim()).filter(Boolean);
  const hasIndicatorName = /[\p{L}\u3400-\u9fff]{2,}/u.test(firstCell)
    || (/[\u3400-\u9fff]/u.test(firstCell) && medicalUnitPattern.test(text));
  if (!hasIndicatorName) return false;
  if (/^(?:正常|异常|阴性|阳性|未见|可见)$/.test(firstCell)) return false;
  if (text.length > 240 && !/[|｜]/.test(text)) return false;
  if (isMorphologyCandidate(text)) return true;
  if (
    cells.length >= 2
    && /[\p{L}\u3400-\u9fff]{1,}/u.test(firstCell)
    && /^(?:[-+±]+|[-+]?\d+(?:\.\d+)?(?:\s|$)|阴性|阳性|弱阳性|正常|异常|未见|可见)/.test(cells[1])
  ) return true;
  if (medicalUnitPattern.test(text) && /\d/.test(text)) return true;
  if (/[↑↓▲▼]/.test(text) && /\d/.test(text)) return true;
  if (/(?:检验)?结果\s*[:：]\s*(?:阴性|阳性|弱阳性|正常|异常|未见|可见)/.test(text)) return true;
  if (/^[^|｜，。；:：]{1,30}\s+(?:阴性|阳性|弱阳性|正常|异常|未见|可见)$/.test(trimmed)) return true;
  if (
    /[|｜]/.test(text)
    && /(?:^|[|｜])\s*(?:阴性|阳性|弱阳性|正常|异常|未见|可见)\s*(?:[|｜]|$)/.test(text)
    && !/(?:异常|正常)区域/.test(text)
  ) return true;
  if (/(参考值|参考范围|正常范围)/.test(text) && /\d/.test(text)) return true;
  if (
    !/\b20\d{2}-\d{1,2}(?:-\d{1,2})?\b/.test(text)
    && /\d(?:\.\d+)?\s*[~～-]\s*\d/.test(text)
  ) return true;
  return /(?:^|[|｜])[^|｜]{1,24}[:：]\s*[-+]?\d+(?:\.\d+)?/.test(text);
}

function parseLines(value: string, pageNumber: number, aliases: DictionaryAliasRow[]) {
  let parsed: RawOcrLine[] = [];
  try {
    const candidate = JSON.parse(value) as unknown;
    parsed = Array.isArray(candidate) ? candidate as RawOcrLine[] : [];
  } catch {
    parsed = [];
  }
  const lines = parsed.flatMap((line, index): PlannedOcrLine[] => {
    const rawText = typeof line.text === "string" ? line.text.trim() : "";
    const text = redactAiInputText(rawText)
      .replace(redactionPlaceholderPattern, " ")
      .replace(/^[\s|,，;；:：]+|[\s|,，;；:：]+$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!text) return [];
    const confidence = Number(line.confidence);
    return [{
      id: typeof line.id === "string" && line.id.trim() ? line.id.trim() : `page_${pageNumber}_line_${index + 1}`,
      sourceLineIds: [typeof line.id === "string" && line.id.trim() ? line.id.trim() : `page_${pageNumber}_line_${index + 1}`],
      index,
      text,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
      box: line.box ?? null,
      candidate: false,
      candidateKind: null,
      dictionaryFacts: [],
      boundary: boundaryFor(text),
      role: "uncertain",
      localObservation: null
    }];
  });
  return mergeWrappedPageLines(reconstructPageLayout(lines, aliases), aliases);
}

function repeatedLineFingerprint(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/第?\s*\d+\s*页(?:\s*[/／共]\s*\d+\s*页?)?/g, "#页码#")
    .replace(/\s+/g, "")
    .replace(/[|｜,，;；:：_\-—]+/g, "");
}

function isLowValueNoise(line: PlannedOcrLine) {
  const text = line.text.trim();
  if (!text) return true;
  if (pageMarkerPattern.test(text) || footerNoisePattern.test(text)) return true;
  if (!/[\p{L}\p{N}\u3400-\u9fff]/u.test(text)) return true;
  if (
    line.confidence !== null
    && line.confidence < 0.35
    && text.length <= 16
    && !line.candidate
    && !line.boundary
  ) return true;
  return false;
}

function isEducationPage(lines: PlannedOcrLine[]) {
  const heading = lines.slice(0, 5).some((line) => educationHeadingPattern.test(line.text.trim()));
  if (!heading) return false;
  return !lines.some((line) => line.boundary === "table_header");
}

function cleanRebuiltPages(pages: RebuiltOcrPage[]) {
  const frequency = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of page.lines) {
      const fingerprint = repeatedLineFingerprint(line.text);
      if (!fingerprint) continue;
      const pageNumbers = frequency.get(fingerprint) || new Set<number>();
      pageNumbers.add(page.pageNumber);
      frequency.set(fingerprint, pageNumbers);
    }
  }
  const repeatedThreshold = Math.max(3, Math.ceil(pages.length * 0.2));
  const seenRepeated = new Set<string>();
  return pages.map((page): RebuiltOcrPage => {
    let repeatedRemovedLineCount = 0;
    let noiseRemovedLineCount = 0;
    const lines = page.lines.filter((line) => {
      if (isLowValueNoise(line)) {
        noiseRemovedLineCount += 1;
        return false;
      }
      const fingerprint = repeatedLineFingerprint(line.text);
      const repeated = (frequency.get(fingerprint)?.size || 0) >= repeatedThreshold;
      const edgeLine = line.index <= 4 || line.index >= Math.max(0, page.sourceLineCount - 4);
      if (
        repeated
        && edgeLine
        && line.text.length <= 200
        && !line.candidate
        && line.boundary !== "table_header"
        && line.boundary !== "section"
      ) {
        if (seenRepeated.has(fingerprint)) {
          repeatedRemovedLineCount += 1;
          return false;
        }
        seenRepeated.add(fingerprint);
      }
      return true;
    });
    const text = renderCompletePage({ pageNumber: page.pageNumber, lines });
    return {
      ...page,
      lineCount: lines.length,
      characterCount: text.length,
      candidateRowCount: lines.filter((line) => line.candidate).length,
      morphologyCandidateCount: lines.filter((line) => isMorphologyCandidate(line.text)).length,
      narrativeLineCount: lines.filter((line) =>
        line.role === "narrative"
        || (line.role === "section_heading" && narrativeSectionHeadingPattern.test(line.text))
      ).length,
      localObservationCount: lines.filter((line) => line.localObservation).length,
      removedLineCount: page.removedLineCount + page.lines.length - lines.length,
      repeatedRemovedLineCount,
      noiseRemovedLineCount,
      text,
      lines,
      classification: classifyReportContent(text)
    };
  });
}

function repairCrossPageContexts(pages: RebuiltOcrPage[]) {
  let previousLastCandidate: PlannedOcrLine | null = null;
  return pages.map((page): RebuiltOcrPage => {
    const firstBoundaryIndex = page.lines.findIndex((line) => Boolean(line.boundary));
    const continuationLines = firstBoundaryIndex < 0 ? page.lines : page.lines.slice(0, firstBoundaryIndex);
    let beforeBoundary = Boolean(
      continuationLines.some((line) => line.candidate)
      && previousLastCandidate?.candidate
      && previousLastCandidate.sectionName
    );
    const lines = page.lines.map((line) => {
      if (line.boundary) beforeBoundary = false;
      if (!beforeBoundary || !line.candidate || line.sectionName) return line;
      const sectionName = previousLastCandidate?.sectionName || null;
      return {
        ...line,
        sectionName,
        reportSectionName: previousLastCandidate?.reportSectionName || null,
        tableHeaderText: line.tableHeaderText || previousLastCandidate?.tableHeaderText || null,
        localObservation: line.localObservation
          ? { ...line.localObservation, sectionName }
          : null
      };
    });
    previousLastCandidate = [...lines].reverse().find((line) => line.candidate) || null;
    return { ...page, lines };
  });
}

function renderCompletePage(page: Pick<RebuiltOcrPage, "pageNumber" | "lines">) {
  return `[第 ${page.pageNumber} 页]\n${page.lines.map((line) => line.text).join("\n")}`;
}

export function rebuildOcrPages(rows: Array<{ pageId: string; pageNumber: number; linesJson: string }>) {
  const aliases = activeDictionaryAliases();
  let educationContinuation = false;
  let lineContext: PageLineContext = {
    section: null,
    reportSection: null,
    narrativeActive: false,
    tableHeader: null,
    pageNumber: null,
    endedWithCandidate: false
  };
  const pages = rows.map((row): RebuiltOcrPage => {
    const parsed = parseLines(row.linesJson, row.pageNumber, aliases);
    const annotated = annotatePageLines(parsed, row.pageNumber, lineContext);
    const parsedLines = annotated.lines;
    lineContext = annotated.context;
    const historicalIndex = parsedLines.findIndex((line) =>
      historicalSectionPattern.test(line.text.replace(/^【\s*|\s*】$/g, "").trim())
    );
    const startsEducation = isEducationPage(parsedLines);
    const restartsReportContent = parsedLines.slice(0, 12).some((line) =>
      line.boundary === "table_header"
      || reportContentRestartPattern.test(line.text.trim())
      || documentAnchorHeadingPattern.test(cleanContextLabel(splitTableCells(line.text)[0] || ""))
    );
    if (educationContinuation && restartsReportContent) educationContinuation = false;
    if (startsEducation) educationContinuation = true;
    let lines = historicalIndex >= 0 ? parsedLines.slice(0, historicalIndex) : parsedLines;
    if (educationContinuation) {
      lines = startsEducation
        ? parsedLines.slice(0, 10).filter((line) => educationHeadingPattern.test(line.text.trim()))
        : [];
    }
    lines = lines.map((line) => ({
      ...line,
      candidate: educationContinuation ? false : line.candidate,
      candidateKind: educationContinuation ? null : line.candidateKind,
      dictionaryFacts: educationContinuation ? [] : line.dictionaryFacts,
      role: educationContinuation ? "noise" as const : line.role,
      localObservation: educationContinuation ? null : line.localObservation
    }));
    const text = renderCompletePage({ pageNumber: row.pageNumber, lines });
    return {
      pageId: row.pageId,
      pageNumber: row.pageNumber,
      lineCount: lines.length,
      characterCount: text.length,
      candidateRowCount: lines.filter((line) => line.candidate).length,
      morphologyCandidateCount: lines.filter((line) => isMorphologyCandidate(line.text)).length,
      narrativeLineCount: lines.filter((line) =>
        line.role === "narrative"
        || (line.role === "section_heading" && narrativeSectionHeadingPattern.test(line.text))
      ).length,
      localObservationCount: lines.filter((line) => line.localObservation).length,
      sourceLineCount: parsedLines.length,
      removedLineCount: parsedLines.length - lines.length,
      repeatedRemovedLineCount: 0,
      noiseRemovedLineCount: 0,
      text,
      lines,
      classification: classifyReportContent(text)
    };
  });
  return repairCrossPageContexts(cleanRebuiltPages(pages));
}

function unitFromPages(pages: RebuiltOcrPage[]): AiExtractionUnit {
  const text = pages.map((page) => page.text).join("\n\n");
  const inputHash = sha256(text);
  const candidateRowCount = pages.reduce((sum, page) => sum + page.candidateRowCount, 0);
  const morphologyCandidateCount = pages.reduce((sum, page) => sum + page.morphologyCandidateCount, 0);
  const localObservationCount = pages.reduce((sum, page) => sum + page.localObservationCount, 0);
  const candidateFacts = pages.flatMap((page) => page.lines.filter((line) => line.candidateKind).map((line) => ({
    pageNumber: page.pageNumber,
    kind: line.candidateKind as "scalar" | "morphology",
    sourceText: line.text,
    dictionaryFacts: line.dictionaryFacts
  })));
  const classification = mergeContentClassifications(pages.map((page) => page.classification));
  return {
    unitKey: `unit_${sha256(`complete_pages|${pages.map((page) => page.pageNumber).join(",")}|${inputHash}`).slice(0, 24)}`,
    inputHash,
    unitType: "complete_pages",
    extractionMode: "scalar",
    route: "scalar",
    allowDocumentFields: false,
    classification,
    pageNumbers: pages.map((page) => page.pageNumber),
    pageRanges: pages.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      lineStart: page.lines[0]?.index ?? 0,
      lineEnd: page.lines.at(-1)?.index ?? 0,
      chunkIndex: 1,
      chunkCount: 1
    })),
    characterCount: text.length,
    candidateRowCount,
    morphologyCandidateCount,
    localObservationCount,
    estimatedOutputTokens: estimateAiUnitOutputTokens({
      pageCount: pages.length,
      characterCount: text.length,
      candidateRowCount,
      morphologyCandidateCount
    }),
    lineCount: pages.reduce((sum, page) => sum + page.lineCount, 0),
    text,
    candidateFacts
  };
}

function packScalarUnits(baseUnits: AiExtractionUnit[], pages: RebuiltOcrPage[]) {
  const ranges = baseUnits.flatMap((unit) => unit.pageRanges).filter((range) => {
    const page = pages.find((item) => item.pageId === range.pageId);
    return page?.lines.some((line) =>
      line.index >= range.lineStart
      && line.index <= range.lineEnd
      && line.candidateKind === "scalar"
      && !line.localObservation
    );
  });
  const units: AiExtractionUnit[] = [];
  let pending: typeof ranges = [];
  const flush = () => {
    if (!pending.length) return;
    units.push(unitFromRanges("complete_pages", pending, pages, "scalar", false));
    pending = [];
  };
  for (const range of ranges) {
    const combined = unitFromRanges("complete_pages", [...pending, range], pages, "scalar", false);
    if (
      pending.length
      && (
        combined.pageNumbers.length > aiInputPlanningPolicy.maxPagesPerUnit
        || combined.characterCount > aiInputPlanningPolicy.targetCharacters
        || combined.estimatedOutputTokens > aiInputPlanningPolicy.targetOutputTokens
        || combined.candidateRowCount > aiInputPlanningPolicy.maxCandidateRowsPerUnit
      )
    ) flush();
    pending.push(range);
  }
  flush();
  return units.filter((unit) => unit.candidateRowCount > 0);
}

function packMorphologyUnits(baseUnits: AiExtractionUnit[], pages: RebuiltOcrPage[]) {
  const ranges = baseUnits.flatMap((unit) => unit.pageRanges.filter((range) => {
    const page = pages.find((item) => item.pageId === range.pageId);
    return page?.lines.some((line) =>
      line.index >= range.lineStart
      && line.index <= range.lineEnd
      && line.candidateKind === "morphology"
    );
  }));
  const units: AiExtractionUnit[] = [];
  let pending: typeof ranges = [];
  const flush = () => {
    if (!pending.length) return;
    units.push(unitFromRanges("complete_pages", pending, pages, "morphology", false));
    pending = [];
  };
  for (const range of ranges) {
    const combined = unitFromRanges("complete_pages", [...pending, range], pages, "morphology", false);
    if (
      pending.length
      && (
        combined.pageNumbers.length > aiInputPlanningPolicy.maxPagesPerUnit
        || combined.characterCount > aiInputPlanningPolicy.targetCharacters
        || combined.estimatedOutputTokens > aiInputPlanningPolicy.targetOutputTokens
        || combined.candidateRowCount > aiInputPlanningPolicy.maxCandidateRowsPerUnit
      )
    ) flush();
    pending.push(range);
  }
  flush();
  return units.filter((unit) => unit.candidateRowCount > 0);
}

function packNarrativeUnits(baseUnits: AiExtractionUnit[], pages: RebuiltOcrPage[]) {
  const ranges = baseUnits.flatMap((unit) => unit.pageRanges).filter((range) => {
    const narrative = unitFromRanges("complete_pages", [range], pages, "narrative", false);
    return Boolean(narrative.text
      .replace(/\[解析任务：原文章节\]|\[第 \d+ 页(?: · 内容分块 \d+\/\d+)?\]/g, "")
      .trim());
  });
  const units: AiExtractionUnit[] = [];
  let pending: typeof ranges = [];
  const flush = () => {
    if (!pending.length) return;
    units.push(unitFromRanges("complete_pages", pending, pages, "narrative", false));
    pending = [];
  };
  for (const range of ranges) {
    const combined = unitFromRanges("complete_pages", [...pending, range], pages, "narrative", false);
    if (
      pending.length
      && (
        combined.pageNumbers.length > aiInputPlanningPolicy.maxSparsePagesPerUnit
        || combined.characterCount > aiInputPlanningPolicy.targetCharacters
        || combined.estimatedOutputTokens > aiInputPlanningPolicy.targetOutputTokens
      )
    ) flush();
    pending.push(range);
  }
  flush();
  return units;
}

function documentProfileUnit(
  pages: RebuiltOcrPage[],
  classification: ReportContentClassification,
  includeSinglePageScalars: boolean
) {
  const candidates = new Map<string, {
    page: RebuiltOcrPage;
    line: PlannedOcrLine;
    priority: number;
  }>();
  const add = (page: RebuiltOcrPage, line: PlannedOcrLine, priority: number) => {
    const key = `${page.pageId}:${line.id}`;
    const existing = candidates.get(key);
    if (!existing || priority < existing.priority) candidates.set(key, { page, line, priority });
  };

  for (const page of pages) {
    if (page.pageNumber <= 2) {
      for (const line of page.lines.slice(0, page.pageNumber === 1 ? 32 : 16)) {
        if (
          line.role !== "noise"
          && (includeSinglePageScalars || !["scalar", "morphology", "table_header"].includes(line.role))
        ) add(page, line, page.pageNumber === 1 ? 2 : 3);
      }
    }
    for (const line of page.lines) {
      if (line.role === "metadata" || line.role === "section_heading") add(page, line, 1);
    }
    for (let index = 0; index < page.lines.length; index += 1) {
      if (!documentAnchorHeadingPattern.test(page.lines[index].text)) continue;
      for (const line of page.lines.slice(index, index + 7)) add(page, line, 0);
    }
    if (includeSinglePageScalars) {
      for (const line of page.lines) {
        if (line.role === "scalar" || line.role === "table_header") add(page, line, 1);
      }
    }
  }

  // Internal classifier enums are routing metadata, not report content. Sending
  // values such as "checkup" in the OCR body can make a model copy them into
  // reportSubtype or bodyParts.
  const heading = `[文档概况]\n总页数：${pages.length}`;
  const selected = new Map<number, PlannedOcrLine[]>();
  let selectedCharacters = heading.length;
  for (const candidate of [...candidates.values()].sort((left, right) =>
    left.priority - right.priority
    || left.page.pageNumber - right.page.pageNumber
    || left.line.index - right.line.index
  )) {
    const addition = candidate.line.text.length + 1;
    if (selectedCharacters + addition > aiInputPlanningPolicy.targetCharacters && selected.size) continue;
    const current = selected.get(candidate.page.pageNumber) || [];
    current.push(candidate.line);
    selected.set(candidate.page.pageNumber, current);
    selectedCharacters += addition;
  }

  const rendered: string[] = [heading];
  const ranges: AiExtractionUnit["pageRanges"] = [];
  const candidateFacts: AiExtractionUnit["candidateFacts"] = [];
  for (const page of pages) {
    const lines = (selected.get(page.pageNumber) || []).sort((left, right) => left.index - right.index);
    if (!lines.length) continue;
    rendered.push(`[第 ${page.pageNumber} 页]\n${lines.map((line) => line.text).join("\n")}`);
    ranges.push({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      lineStart: Math.min(...lines.map((line) => line.index)),
      lineEnd: Math.max(...lines.map((line) => line.index)),
      chunkIndex: 1,
      chunkCount: 1
    });
    if (includeSinglePageScalars) {
      candidateFacts.push(...lines.filter((line) =>
        line.candidateKind === "scalar" && !line.localObservation
      ).map((line) => ({
        pageNumber: page.pageNumber,
        kind: "scalar" as const,
        sourceText: line.text,
        dictionaryFacts: line.dictionaryFacts
      })));
    }
  }
  const text = rendered.join("\n\n");
  const inputHash = sha256([
    aiInputPlanningPolicy.version,
    "document",
    includeSinglePageScalars ? "with-scalars" : "profile",
    text
  ].join("\u0000"));
  return {
    unitKey: `unit_${sha256(`document|${inputHash}`).slice(0, 24)}`,
    inputHash,
    unitType: "complete_pages" as const,
    extractionMode: "scalar" as const,
    route: "document" as const,
    allowDocumentFields: true,
    classification,
    pageNumbers: ranges.map((range) => range.pageNumber),
    pageRanges: ranges,
    characterCount: text.length,
    candidateRowCount: candidateFacts.length,
    morphologyCandidateCount: 0,
    localObservationCount: pages.reduce((sum, page) => sum + page.localObservationCount, 0),
    estimatedOutputTokens: estimateAiUnitOutputTokens({
      pageCount: ranges.length,
      characterCount: text.length,
      candidateRowCount: candidateFacts.length,
      morphologyCandidateCount: 0
    }),
    lineCount: [...selected.values()].reduce((sum, lines) => sum + lines.length, 0),
    text,
    candidateFacts
  } satisfies AiExtractionUnit;
}

export function planRebuiltOcrPages(reportId: string, pages: RebuiltOcrPage[]): AiExtractionPlan {
  const baseUnits: AiExtractionUnit[] = [];
  let pendingPages: RebuiltOcrPage[] = [];
  const flushPending = () => {
    if (!pendingPages.length) return;
    baseUnits.push(unitFromPages(pendingPages));
    pendingPages = [];
  };

  for (const page of pages) {
    const combinedPages = [...pendingPages, page];
    const combinedText = combinedPages.map((item) => item.text).join("\n\n");
    const combinedCandidates = combinedPages
      .reduce((sum, item) => sum + item.candidateRowCount, 0);
    const combinedMorphologyCandidates = combinedPages
      .reduce((sum, item) => sum + item.morphologyCandidateCount, 0);
    const estimatedOutputTokens = estimateAiUnitOutputTokens({
      pageCount: combinedPages.length,
      characterCount: combinedText.length,
      candidateRowCount: combinedCandidates,
      morphologyCandidateCount: combinedMorphologyCandidates
    });
    if (
      pendingPages.length
      && (
        pendingPages.length >= aiInputPlanningPolicy.maxPagesPerUnit
        || combinedText.length > aiInputPlanningPolicy.targetCharacters
        || estimatedOutputTokens > aiInputPlanningPolicy.targetOutputTokens
        || combinedCandidates > aiInputPlanningPolicy.maxCandidateRowsPerUnit
      )
    ) flushPending();
    // A page is the minimum extraction boundary. Oversized pages stay intact so
    // table and section relationships are never broken across AI requests.
    pendingPages.push(page);
  }
  flushPending();

  if (!baseUnits.length) {
    throw Object.assign(new Error("报告没有可用于 AI 整理的文字"), { code: "EMPTY_REPORT_TEXT" });
  }
  const documentClassification = classifyReportDocument(pages);
  const singlePageEstimate = pages.length === 1 ? estimateAiUnitOutputTokens({
    pageCount: 1,
    characterCount: pages[0].characterCount,
    candidateRowCount: pages[0].candidateRowCount,
    morphologyCandidateCount: 0
  }) : Number.POSITIVE_INFINITY;
  const includeSinglePageScalars = pages.length === 1
    && pages[0].characterCount <= aiInputPlanningPolicy.targetCharacters
    && pages[0].candidateRowCount <= aiInputPlanningPolicy.maxCandidateRowsPerUnit
    && singlePageEstimate <= aiInputPlanningPolicy.targetOutputTokens;
  const documentUnit = documentProfileUnit(pages, documentClassification, includeSinglePageScalars);
  const scalarUnits = includeSinglePageScalars
    ? []
    : packScalarUnits(baseUnits, pages);
  const units = [
    documentUnit,
    ...scalarUnits,
    ...packNarrativeUnits(baseUnits, pages),
    ...packMorphologyUnits(baseUnits, pages)
  ];
  const localFactsHash = sha256(JSON.stringify(pages.flatMap((page) =>
    page.lines.flatMap((line) => line.localObservation ? [line.localObservation] : [])
  )));
  const planHash = sha256([
    units.map((unit) => `${unit.unitKey}:${unit.inputHash}`).join("|"),
    localFactsHash
  ].join("\u0000"));
  return {
    policy: aiInputPlanningPolicy,
    reportId,
    pageCount: pages.length,
    sourceCharacterCount: pages.reduce((sum, page) => sum + page.characterCount, 0),
    candidateRowCount: pages.reduce((sum, page) => sum + page.candidateRowCount, 0),
    morphologyCandidateCount: pages.reduce((sum, page) => sum + page.morphologyCandidateCount, 0),
    narrativeLineCount: pages.reduce((sum, page) => sum + page.narrativeLineCount, 0),
    localObservationCount: pages.reduce((sum, page) => sum + page.localObservationCount, 0),
    sourceLineCount: pages.reduce((sum, page) => sum + page.sourceLineCount, 0),
    removedLineCount: pages.reduce((sum, page) => sum + page.removedLineCount, 0),
    repeatedRemovedLineCount: pages.reduce((sum, page) => sum + page.repeatedRemovedLineCount, 0),
    noiseRemovedLineCount: pages.reduce((sum, page) => sum + page.noiseRemovedLineCount, 0),
    unitCount: units.length,
    planHash,
    documentClassification,
    pages,
    units
  };
}

export function buildAiExtractionPlan(reportId: string) {
  const rows = getDatabase().prepare(`
    SELECT p.id AS pageId, p.page_number AS pageNumber, p.mime_type AS mimeType,
      p.storage_path AS storagePath, p.source_page_number AS sourcePageNumber,
      p.source_page_count AS sourcePageCount,
      (
        SELECT o.lines_json FROM ocr_results o
        WHERE o.page_id = p.id
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 1
      ) AS linesJson
    FROM report_pages p
    WHERE p.report_id = ?
    ORDER BY p.page_number
  `).all(reportId) as Array<{
    pageId: string;
    pageNumber: number;
    mimeType: string;
    storagePath: string;
    sourcePageNumber: number | null;
    sourcePageCount: number | null;
    linesJson: string | null;
  }>;
  if (!rows.length) {
    throw Object.assign(new Error("报告没有可用于 AI 整理的页面"), { code: "EMPTY_REPORT_PAGES" });
  }
  if (rows.some((row, index) => row.pageNumber !== index + 1)) {
    throw Object.assign(new Error("报告页面序号不连续，请重新生成报告分页"), {
      code: "REPORT_PAGE_SEQUENCE_INVALID"
    });
  }
  const pdfSources = new Map<string, typeof rows>();
  for (const row of rows.filter((item) => item.mimeType === "application/pdf")) {
    pdfSources.set(row.storagePath, [...(pdfSources.get(row.storagePath) || []), row]);
  }
  for (const sourceRows of pdfSources.values()) {
    const expected = sourceRows[0]?.sourcePageCount || 0;
    if (
      expected < 1
      || sourceRows.length !== expected
      || sourceRows.some((row, index) =>
        row.sourcePageCount !== expected || row.sourcePageNumber !== index + 1
      )
    ) {
      throw Object.assign(
        new Error(`PDF 分页不完整：应有 ${expected || "未知"} 页，当前记录 ${sourceRows.length} 页`),
        { code: "PDF_PAGE_SET_INCOMPLETE" }
      );
    }
  }
  const missingOcrPages = rows.filter((row) => row.linesJson === null).map((row) => row.pageNumber);
  if (missingOcrPages.length) {
    throw Object.assign(
      new Error(`OCR 页面结果不完整：第 ${missingOcrPages.join("、")} 页尚未完成`),
      { code: "OCR_PAGE_SET_INCOMPLETE", pageNumbers: missingOcrPages }
    );
  }
  return planRebuiltOcrPages(reportId, rebuildOcrPages(rows.map((row) => ({
    pageId: row.pageId,
    pageNumber: row.pageNumber,
    linesJson: row.linesJson || "[]"
  }))));
}

export function previewAiExtractionPlan(user: RequestUser, reportId: string) {
  const report = getDatabase().prepare(`
    SELECT member_id AS memberId FROM reports WHERE id = ? AND status <> 'trashed'
  `).get(reportId) as { memberId: string } | undefined;
  if (!report) throw createError({ statusCode: 404, statusMessage: "报告不存在" });
  assertMemberManage(user, report.memberId);
  return buildAiExtractionPlan(reportId);
}
