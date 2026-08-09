const issueEndpoint = "https://github.com/timor-m/fnos-app-health-records/issues/new";
const maximumNames = 40;
export const feedbackQqGroup = "1085626763";

export function sanitizeIndicatorFeedbackName(value: string) {
  const name = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > 120) return null;
  if (/\b1[3-9]\d{9}\b/.test(name)) return null;
  if (/\b\d{17}[0-9xX]\b/.test(name)) return null;
  if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(name)) return null;
  return name;
}

function collectFeedbackNames(values: string[]) {
  return [...new Set(values.map(sanitizeIndicatorFeedbackName).filter((value): value is string => Boolean(value)))]
    .slice(0, maximumNames);
}

export type IndicatorFeedbackMeta = { appVersion?: string; schemaVersion?: number | string };

/** 纯文本反馈内容：与 GitHub Issue 同源的脱敏名单，供复制到 QQ 群等无法使用 GitHub 的渠道。 */
export function buildIndicatorFeedbackText(values: string[], meta?: IndicatorFeedbackMeta) {
  const names = collectFeedbackNames(values);
  if (!names.length) return "";
  const lines = [
    `指标字典收录申请（${names.length} 项）`,
    "",
    ...names.map((name) => `- ${name}`)
  ];
  if (meta?.appVersion || meta?.schemaVersion) {
    lines.push("", `应用版本：${meta.appVersion || "?"} · 数据库：v${meta.schemaVersion || "?"}`);
  }
  lines.push("", "—— 由健康档案应用生成，仅包含未命中的指标名称，不包含成员、医院、报告、检查结果或其他健康数据。");
  return lines.join("\n");
}

export function buildIndicatorDictionaryIssueUrl(values: string[]) {
  const names = collectFeedbackNames(values);
  if (!names.length) return "";
  const title = names.length === 1
    ? `指标字典收录申请：${names[0]}`
    : `指标字典收录申请：${names.slice(0, 2).join("、")}等 ${names.length} 项`;
  const body = [
    "## 未命中指标名称",
    "",
    ...names.map((name) => `- ${name}`),
    "",
    "## 数据边界",
    "",
    "本 Issue 由健康档案应用生成，仅包含未命中的指标名称，不包含成员、医院、报告、检查结果或其他健康数据。"
  ].join("\n");
  const url = new URL(issueEndpoint);
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  return url.toString();
}
