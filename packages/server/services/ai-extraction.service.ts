import { getDatabase } from "../database/client";
import { createId } from "../utils/identifier";
import { getAiSettings } from "./ai-settings.service";
import { normalizeReportObservations } from "./indicator-normalization.service";
import { listManualReportFieldKeys, type ReportFieldKey } from "./report-field-overrides.service";
import { configuredRequestTimeout, fetchWithTimeout } from "../utils/outbound-request";

const promptVersion = "health-record-v4";
const maxInputCharacters = 80_000;
const reportTypeAliases: Record<string, string> = {
  physical_exam: "checkup",
  checkup: "checkup",
  laboratory: "laboratory",
  imaging: "imaging",
  functional: "functional",
  pathology: "pathology",
  outpatient: "outpatient",
  inpatient: "inpatient",
  prescription: "prescription",
  receipt: "billing",
  billing: "billing",
  vaccine: "vaccination",
  vaccination: "vaccination",
  other: "other"
};
const lateralityValues = new Set(["left", "right", "bilateral", "unspecified"]);
const abnormalFlags = new Set(["high", "low", "abnormal", "normal"]);

/* AI 漏标时的确定性兜底：结果文本或证据原文里明确出现的箭头/高低标记（只基于原文，不做参考范围推断） */
function markerFlagFromText(...chunks: Array<string | null>): AiObservation["abnormalFlag"] {
  const text = chunks.filter(Boolean).join(" ");
  if (!text) return null;
  if (/[↑▲⬆]|偏高/.test(text)) return "high";
  if (/[↓▼⬇]|偏低/.test(text)) return "low";
  return null;
}
const identifierKeys = new Set([
  "reportNo", "outpatientNo", "inpatientNo", "physicalExamNo", "examNo", "specimenNo", "barcodeNo"
]);
const clinicianKeys = new Set(["ordering", "examining", "reporting", "reviewing", "chief"]);

export type AiEvidence = { pageNumber: number; quote: string };
export type AiObservation = {
  sectionName: string | null;
  itemCode: string | null;
  itemName: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  method: string | null;
  evidence: AiEvidence[];
};

export type AiExtractionFields = {
  reportType: string | null;
  reportSubtype: string | null;
  title: string | null;
  hospitalNameRaw: string | null;
  hospitalBranch: string | null;
  city: string | null;
  visitType: string | null;
  visitDepartment: string | null;
  orderingDepartment: string | null;
  performingDepartment: string | null;
  reportingDepartment: string | null;
  inpatientWard: string | null;
  bodyParts: Array<{ raw: string; name: string; parent: string | null; laterality: string }>;
  identifiers: Record<string, string>;
  reportIssuedAt: string | null;
  examinedAt: string | null;
  orderedAt: string | null;
  sampledAt: string | null;
  receivedAt: string | null;
  reviewedAt: string | null;
  admittedAt: string | null;
  dischargedAt: string | null;
  clinicians: Record<string, string>;
  clinicalDiagnosis: string | null;
  purpose: string | null;
  chiefComplaint: string | null;
  findings: string | null;
  impression: string | null;
  summary: string | null;
  recommendation: string | null;
  observations: AiObservation[];
};

export type AiExtractionInput = {
  reportId: string;
  text: string;
  inputCharacters: number;
  pageCount: number;
};

export type AiExtractionResult = {
  provider: string;
  model: string;
  promptVersion: string;
  fields: AiExtractionFields;
  evidence: Record<string, AiEvidence[]>;
  confidence: Record<string, number>;
  rawResponseJson: string;
  promptTokens: number | null;
  completionTokens: number | null;
  elapsedMs: number;
};

export type AiExecutor = (input: AiExtractionInput) => Promise<AiExtractionResult>;

function redactSensitiveText(value: string) {
  if (/(身份证|证件号码|联系电话|手机号码|手机号|家庭住址|通讯地址|现住址)/i.test(value)) return "";
  return value
    .replace(/(^|\D)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)/g, "$1[已过滤身份证号]")
    .replace(/(^|\D)1[3-9]\d{9}(?!\d)/g, "$1[已过滤手机号]");
}

function textValue(value: unknown, maxLength = 4000) {
  if (typeof value !== "string") return null;
  const clean = redactSensitiveText(value).trim().slice(0, maxLength);
  return clean || null;
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function dateValue(value: unknown) {
  const clean = textValue(value, 32);
  return clean && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(clean) ? clean : null;
}

function evidenceValue(value: unknown): AiEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const pageNumber = Math.max(1, Math.round(numberValue((item as Record<string, unknown>).pageNumber) || 1));
    const quote = textValue((item as Record<string, unknown>).quote, 500);
    return quote ? [{ pageNumber, quote }] : [];
  });
}

function objectStrings(value: unknown, allowedKeys: Set<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (!allowedKeys.has(key)) return [];
    const clean = textValue(item, 200);
    return clean ? [[key, clean]] : [];
  }));
}

export function normalizeAiExtraction(value: unknown): {
  fields: AiExtractionFields;
  evidence: Record<string, AiEvidence[]>;
  confidence: Record<string, number>;
} {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rawType = textValue(source.reportType, 40);
  const reportType = rawType ? reportTypeAliases[rawType] || null : null;
  const bodyParts = Array.isArray(source.bodyParts) ? source.bodyParts.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const raw = textValue(row.raw, 120);
    const name = textValue(row.name, 120) || raw;
    if (!name) return [];
    const laterality = textValue(row.laterality, 20) || "unspecified";
    return [{ raw: raw || name, name, parent: textValue(row.parent, 120), laterality: lateralityValues.has(laterality) ? laterality : "unspecified" }];
  }) : [];
  const observations = Array.isArray(source.observations) ? source.observations.slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const itemName = textValue(row.itemName, 200);
    const resultText = textValue(row.resultText, 500);
    if (!itemName || !resultText) return [];
    const flag = textValue(row.abnormalFlag, 20);
    const evidence = evidenceValue(row.evidence);
    const parsedFlag = flag && abnormalFlags.has(flag) ? flag as AiObservation["abnormalFlag"] : null;
    return [{
      sectionName: textValue(row.sectionName, 200),
      itemCode: textValue(row.itemCode, 100),
      itemName,
      normalizedName: textValue(row.normalizedName, 200),
      resultText,
      numericValue: numberValue(row.numericValue),
      unit: textValue(row.unit, 80),
      referenceLow: numberValue(row.referenceLow),
      referenceHigh: numberValue(row.referenceHigh),
      referenceText: textValue(row.referenceText, 300),
      abnormalFlag: parsedFlag || markerFlagFromText(resultText, ...evidence.map((item) => item.quote)),
      method: textValue(row.method, 200),
      evidence
    }];
  }) : [];
  const rawEvidence = source.evidence && typeof source.evidence === "object" && !Array.isArray(source.evidence)
    ? source.evidence as Record<string, unknown> : {};
  const evidence = Object.fromEntries(Object.entries(rawEvidence).flatMap(([key, item]) => {
    const entries = evidenceValue(item);
    return entries.length ? [[key.slice(0, 100), entries]] : [];
  }));
  const rawConfidence = source.confidence && typeof source.confidence === "object" && !Array.isArray(source.confidence)
    ? source.confidence as Record<string, unknown> : {};
  const confidence = Object.fromEntries(Object.entries(rawConfidence).flatMap(([key, item]) => {
    const number = numberValue(item);
    return number === null ? [] : [[key.slice(0, 100), Math.max(0, Math.min(1, number))]];
  }));

  const fields: AiExtractionFields = {
    reportType,
    reportSubtype: textValue(source.reportSubtype, 120),
    title: textValue(source.title, 200),
    hospitalNameRaw: textValue(source.hospitalNameRaw, 300),
    hospitalBranch: textValue(source.hospitalBranch, 200),
    city: textValue(source.city, 120),
    visitType: textValue(source.visitType, 80),
    visitDepartment: textValue(source.visitDepartment, 200),
    orderingDepartment: textValue(source.orderingDepartment, 200),
    performingDepartment: textValue(source.performingDepartment, 200),
    reportingDepartment: textValue(source.reportingDepartment, 200),
    inpatientWard: textValue(source.inpatientWard, 200),
    bodyParts,
    identifiers: objectStrings(source.identifiers, identifierKeys),
    reportIssuedAt: dateValue(source.reportIssuedAt),
    examinedAt: dateValue(source.examinedAt),
    orderedAt: dateValue(source.orderedAt),
    sampledAt: dateValue(source.sampledAt),
    receivedAt: dateValue(source.receivedAt),
    reviewedAt: dateValue(source.reviewedAt),
    admittedAt: dateValue(source.admittedAt),
    dischargedAt: dateValue(source.dischargedAt),
    clinicians: objectStrings(source.clinicians, clinicianKeys),
    clinicalDiagnosis: textValue(source.clinicalDiagnosis),
    purpose: textValue(source.purpose),
    chiefComplaint: textValue(source.chiefComplaint),
    findings: textValue(source.findings, 12_000),
    impression: textValue(source.impression, 8000),
    summary: textValue(source.summary, 4000),
    recommendation: textValue(source.recommendation, 4000),
    observations
  };
  if (!fields.bodyParts.length) fields.bodyParts = inferDisplayBodyParts(fields);
  return { fields, evidence, confidence };
}

export function isAiExtractionConfigured() {
  const settings = getAiSettings(true);
  return settings.enabled && Boolean(settings.apiKey && settings.textModel && settings.baseUrl);
}

function compactParts(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => part?.replace(/\s+/g, " ").trim())
    .filter((part): part is string => Boolean(part));
}

function primaryDepartment(fields: AiExtractionFields) {
  return fields.visitDepartment || fields.reportingDepartment || fields.performingDepartment || fields.orderingDepartment;
}

function primaryBodyPart(fields: AiExtractionFields) {
  return fields.bodyParts[0]?.name || fields.bodyParts[0]?.raw || null;
}

function primaryObservationName(fields: AiExtractionFields) {
  const names = fields.observations
    .map((item) => item.normalizedName || item.itemName)
    .filter((name, index, list) => name && list.indexOf(name) === index)
    .slice(0, 3);
  if (!names.length) return null;
  return names.length > 2 ? `${names.slice(0, 2).join("、")}等` : names.join("、");
}

function primarySectionName(fields: AiExtractionFields) {
  const sections = fields.observations
    .map((item) => item.sectionName?.replace(/\s+/g, "").trim())
    .filter((name): name is string => Boolean(name && !["检验", "检查", "项目", "检验项目"].includes(name)))
    .filter((name, index, list) => list.indexOf(name) === index)
    .slice(0, 2);
  return sections.length === 1 ? sections[0] : null;
}

function genericTitleKey(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/[：:，,。.;；、_\-]/g, "");
}

export function isGenericReportTitle(value: string | null | undefined) {
  if (!value) return true;
  const key = genericTitleKey(value);
  return new Set([
    "报告", "报告单", "检查报告", "检查报告单", "检验报告", "检验报告单", "化验报告", "化验报告单",
    "医学检验报告单", "医学检验报告", "门诊检验报告单", "门诊检验报告", "住院检验报告单",
    "体检报告", "健康体检报告", "影像报告", "影像检查报告", "放射报告", "超声报告", "病理报告",
    "门诊病历", "门诊记录", "住院记录", "出院记录", "处方", "处方笺", "收费票据", "医疗票据"
  ]).has(key);
}

function bodyPart(raw: string) {
  return [{ raw, name: raw, parent: null, laterality: "unspecified" }];
}

export function inferDisplayBodyParts(fields: AiExtractionFields) {
  const subtype = fields.reportSubtype;
  const department = primaryDepartment(fields);
  const section = primarySectionName(fields);
  const observation = primaryObservationName(fields);
  switch (fields.reportType) {
    case "checkup":
      return bodyPart(subtype || "综合体检");
    case "laboratory":
      return bodyPart(subtype || section || observation || "检验项目");
    case "imaging":
      return subtype ? bodyPart(subtype) : [];
    case "functional":
      return bodyPart(primaryBodyPart(fields) || subtype || "功能检查");
    case "pathology":
      return bodyPart(primaryBodyPart(fields) || subtype || "病理标本");
    case "outpatient":
      return bodyPart(department || "门诊");
    case "inpatient":
      return bodyPart(fields.inpatientWard || department || "住院");
    case "prescription":
      return bodyPart("用药");
    case "billing":
      return bodyPart("费用");
    case "vaccination":
      return bodyPart(observation || "疫苗接种");
    default:
      return subtype ? bodyPart(subtype) : [];
  }
}

function reportTypeLabel(fields: AiExtractionFields) {
  const bodyPart = primaryBodyPart(fields);
  const department = primaryDepartment(fields);
  const subtype = fields.reportSubtype;
  const section = primarySectionName(fields);
  const observation = primaryObservationName(fields);
  switch (fields.reportType) {
    case "checkup":
      return compactParts([subtype || "综合", "体检报告"]).join("");
    case "laboratory": {
      const subject = subtype || section || observation;
      if (subject && /(检验|检查|报告)$/.test(subject)) return `${subject}报告`.replace(/报告报告$/, "报告");
      return compactParts([subject, "检验报告"]).join("");
    }
    case "imaging":
      return compactParts([bodyPart, subtype || "影像", "报告"]).join("");
    case "functional":
      return compactParts([bodyPart || subtype, "功能检查报告"]).join("");
    case "pathology":
      return compactParts([bodyPart, "病理报告"]).join("");
    case "outpatient":
      return compactParts([department, "门诊记录"]).join("");
    case "inpatient":
      return compactParts([fields.inpatientWard || department, "住院记录"]).join("");
    case "prescription":
      return compactParts([department, "处方"]).join("");
    case "billing":
      return "医疗票据";
    case "vaccination":
      return compactParts([observation, "疫苗接种记录"]).join("");
    default:
      return subtype || fields.title || "健康报告";
  }
}

export function buildReportTitle(fields: AiExtractionFields) {
  const generated = reportTypeLabel(fields);
  const title = !isGenericReportTitle(fields.title) ? fields.title : generated;
  return (title || "健康报告").slice(0, 80);
}

export function buildAiExtractionInput(reportId: string): AiExtractionInput {
  const rows = getDatabase().prepare(`
    SELECT p.page_number AS pageNumber, o.lines_json AS linesJson
    FROM report_pages p
    JOIN ocr_results o ON o.page_id = p.id
    WHERE p.report_id = ? ORDER BY p.page_number
  `).all(reportId) as Array<{ pageNumber: number; linesJson: string }>;
  const pages = rows.map((row) => {
    let lines: Array<Record<string, unknown>> = [];
    try { lines = JSON.parse(row.linesJson) as Array<Record<string, unknown>>; } catch { lines = []; }
    const text = lines.map((line) => textValue(line.text, 2000)).filter(Boolean).join("\n");
    return text ? `[第 ${row.pageNumber} 页]\n${text}` : "";
  }).filter(Boolean);
  const text = pages.join("\n\n").slice(0, maxInputCharacters);
  if (!text) throw Object.assign(new Error("报告没有可用于 AI 整理的文字"), { code: "EMPTY_REPORT_TEXT" });
  return { reportId, text, inputCharacters: text.length, pageCount: pages.length };
}

function systemPrompt() {
  return `你是健康报告结构化助手，只能提取输入中明确出现的事实，不得诊断、推测风险或给出治疗建议。
返回一个 JSON 对象，不要 Markdown。日期统一为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss。
reportType 只能是 physical_exam、laboratory、imaging、functional、pathology、outpatient、inpatient、prescription、receipt、vaccine、other。
公共字段包括 reportType、reportSubtype、title、hospitalNameRaw、hospitalBranch、city、visitType、visitDepartment、orderingDepartment、performingDepartment、reportingDepartment、inpatientWard、bodyParts、identifiers、reportIssuedAt、examinedAt、orderedAt、sampledAt、receivedAt、reviewedAt、admittedAt、dischargedAt、clinicians、clinicalDiagnosis、purpose、chiefComplaint、findings、impression、summary、recommendation、observations。
title 用于档案展示：如果原报告标题是“检验报告单/检查报告/体检报告”等泛标题，应按主要项目、检查方式、部位或科室生成短标题，例如“血糖检验报告”“血常规检验报告”“胸部CT报告”“综合体检报告”；不要生成疾病判断标题。
bodyParts 用于档案展示的检查部位/范围，每项使用 raw、name、parent、laterality；laterality 只能是 left、right、bilateral、unspecified。影像/病理/功能检查优先提取真实部位；体检可填“综合体检”；检验无解剖部位时可填主要检验分组或项目，例如“血常规”“生化检验”“空腹血糖”；处方可填“用药”，票据可填“费用”。
identifiers 只允许 reportNo、outpatientNo、inpatientNo、physicalExamNo、examNo、specimenNo、barcodeNo。
clinicians 只允许 ordering、examining、reporting、reviewing、chief。
observations 每项包括 sectionName、itemCode、itemName、normalizedName、resultText、numericValue、unit、referenceLow、referenceHigh、referenceText、abnormalFlag、method、evidence。
体检报告中的“一般检查/基础测量/体格检查/人体成分”必须逐项检查并提取明确出现的身高、体重、BMI、腰围等数值；每个测量单独作为一条 observation，不得合并成“身高体重”等一条记录。
基础测量必须保留原报告单位；只有原文或表头明确给出单位时才填写 unit。不得根据 BMI 推算缺失的体重或身高，也不得根据身高和体重自行生成原报告未提供的 BMI。
abnormalFlag 提取原报告的异常标记：结果旁的 ↑、▲ 或“偏高”为 high，↓、▼ 或“偏低”为 low，有异常标记但无法区分高低（如 阳性、异常、*）为 abnormal，报告明确标记正常为 normal，原报告没有任何标记时为 null。
每个证据使用 {"pageNumber":1,"quote":"原文"}。顶层 evidence 保存公共字段证据，confidence 保存 0 到 1 的字段置信度。
禁止输出姓名、身份证号、电话、住址；summary 必须是中性事实摘要。缺失字段使用 null、空对象或空数组。`;
}

function parseJsonContent(content: string) {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(clean) as unknown;
}

export const requestAiExtraction: AiExecutor = async (input) => {
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
        { role: "system", content: systemPrompt() },
        { role: "user", content: input.text }
      ]
    })
  }, {
    timeoutMs,
    timeoutCode: "AI_REQUEST_TIMEOUT",
    timeoutMessage: `AI 服务在 ${Math.round(timeoutMs / 1000)} 秒内未完成报告整理`,
    networkCode: "AI_NETWORK_ERROR",
    networkMessage: "无法连接 AI 服务，请检查 NAS 网络、服务地址和模型状态"
  });
  if (!response.ok) throw Object.assign(new Error(`AI 服务返回 ${response.status}`), { code: `AI_HTTP_${response.status}` });
  const payload = await response.json() as {
    model?: string;
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const contentValue = payload.choices?.[0]?.message?.content;
  const content = typeof contentValue === "string"
    ? contentValue
    : Array.isArray(contentValue) ? contentValue.map((item) => item.text || "").join("") : "";
  if (!content) throw Object.assign(new Error("AI 服务未返回结构化内容"), { code: "AI_EMPTY_RESPONSE" });
  let parsed: unknown;
  try { parsed = parseJsonContent(content); }
  catch { throw Object.assign(new Error("AI 返回内容不是有效 JSON"), { code: "AI_INVALID_JSON" }); }
  const normalized = normalizeAiExtraction(parsed);
  return {
    provider: new URL(settings.baseUrl).host,
    model: payload.model || settings.textModel,
    promptVersion,
    ...normalized,
    rawResponseJson: JSON.stringify({ ...normalized.fields, evidence: normalized.evidence, confidence: normalized.confidence }),
    promptTokens: numberValue(payload.usage?.prompt_tokens),
    completionTokens: numberValue(payload.usage?.completion_tokens),
    elapsedMs: Date.now() - started
  };
};

export function persistAiExtraction(reportId: string, jobId: string, result: AiExtractionResult, inputCharacters: number) {
  const db = getDatabase();
  const existing = db.prepare("SELECT 1 AS found FROM report_extractions WHERE job_id = ?").get(jobId) as { found: number } | undefined;
  if (existing) return;
  const normalized = normalizeAiExtraction({ ...result.fields, evidence: result.evidence, confidence: result.confidence });
  const fields = normalized.fields;
  const manualFieldKeys = listManualReportFieldKeys(reportId);
  const updates: string[] = [];
  const values: Array<string | number> = [];
  const set = (fieldKey: ReportFieldKey, column: string, value: string | number | null | undefined) => {
    if (manualFieldKeys.has(fieldKey)) return;
    if (value === null || value === undefined || value === "") return;
    updates.push(`${column} = ?`);
    values.push(value);
  };
  const generatedTitle = buildReportTitle(fields);
  if (!manualFieldKeys.has("title")) {
    updates.push("title = CASE WHEN title = '待识别报告' THEN ? ELSE title END");
    values.push(generatedTitle);
  }
  set("reportType", "report_type", fields.reportType);
  set("reportSubtype", "report_subtype", fields.reportSubtype);
  set("hospitalName", "hospital_name_raw", fields.hospitalNameRaw);
  set("hospitalBranch", "hospital_branch", fields.hospitalBranch);
  set("city", "city", fields.city);
  set("visitType", "visit_type", fields.visitType);
  set("departmentName", "visit_department", fields.visitDepartment);
  set("orderingDepartment", "ordering_department", fields.orderingDepartment);
  set("performingDepartment", "performing_department", fields.performingDepartment);
  set("reportingDepartment", "reporting_department", fields.reportingDepartment);
  set("inpatientWard", "inpatient_ward", fields.inpatientWard);
  if (fields.bodyParts.length) set("bodyParts", "body_parts_json", JSON.stringify(fields.bodyParts));
  if (Object.keys(fields.identifiers).length) set("identifiers", "identifiers_json", JSON.stringify(fields.identifiers));
  set("reportIssuedAt", "report_issued_at", fields.reportIssuedAt);
  set("examinedAt", "examined_at", fields.examinedAt);
  set("orderedAt", "ordered_at", fields.orderedAt);
  set("sampledAt", "sampled_at", fields.sampledAt);
  set("receivedAt", "received_at", fields.receivedAt);
  set("reviewedAt", "reviewed_at", fields.reviewedAt);
  set("admittedAt", "admitted_at", fields.admittedAt);
  set("dischargedAt", "discharged_at", fields.dischargedAt);
  if (Object.keys(fields.clinicians).length) set("clinicians", "clinicians_json", JSON.stringify(fields.clinicians));
  set("clinicalDiagnosis", "clinical_diagnosis", fields.clinicalDiagnosis);
  set("purpose", "purpose", fields.purpose);
  set("chiefComplaint", "chief_complaint", fields.chiefComplaint);
  set("findings", "findings", fields.findings);
  set("impression", "impression", fields.impression);
  set("summary", "summary", fields.summary);
  set("recommendation", "recommendation", fields.recommendation);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE reports SET ${updates.length ? `${updates.join(", ")}, ` : ""}source_version = source_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...values, reportId);
    for (const observation of fields.observations) {
      db.prepare(`
        INSERT INTO observations (
          id, report_id, section_name, item_code, item_name, normalized_name, result_text,
          numeric_value, unit, reference_low, reference_high, reference_text, abnormal_flag,
          method, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        createId("obs"), reportId, observation.sectionName, observation.itemCode, observation.itemName,
        observation.normalizedName, observation.resultText, observation.numericValue, observation.unit,
        observation.referenceLow, observation.referenceHigh, observation.referenceText,
        observation.abnormalFlag, observation.method, JSON.stringify(observation.evidence)
      );
    }
    db.prepare(`
      INSERT INTO report_extractions (
        id, report_id, job_id, provider, model, prompt_version, fields_json, evidence_json,
        confidence_json, raw_response_json, input_characters, prompt_tokens, completion_tokens, elapsed_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        provider = excluded.provider, model = excluded.model, prompt_version = excluded.prompt_version,
        fields_json = excluded.fields_json, evidence_json = excluded.evidence_json,
        confidence_json = excluded.confidence_json, raw_response_json = excluded.raw_response_json,
        input_characters = excluded.input_characters, prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens, elapsed_ms = excluded.elapsed_ms
    `).run(
      createId("extract"), reportId, jobId, result.provider, result.model, result.promptVersion,
      JSON.stringify(fields), JSON.stringify(normalized.evidence), JSON.stringify(normalized.confidence),
      JSON.stringify({ ...fields, evidence: normalized.evidence, confidence: normalized.confidence }),
      inputCharacters, result.promptTokens, result.completionTokens, result.elapsedMs
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  normalizeReportObservations(reportId);
}
