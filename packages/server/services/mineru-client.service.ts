import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { Entry } from "unzipper";
import Parse from "unzipper/lib/parse.js";
import type { OcrRecognitionMode } from "../domain/ocr-recognition";
import type { WorkerResponse } from "./ocr-worker-client";

const mineruOrigin = "https://mineru.net";
const jsonResponseLimit = 1024 * 1024;
const markdownResponseLimit = 8 * 1024 * 1024;
const zipResponseLimit = 64 * 1024 * 1024;
const markdownLineLimit = 10_000;
const markdownLineCharacterLimit = 16_000;
const markdownTotalCharacterLimit = 2_000_000;
const zipEntryLimit = 512;
const defaultPollIntervalMs = 5_000;
const defaultOverallTimeoutMs = 30 * 60_000;
const defaultRequestTimeoutMs = 60_000;

type MinerURemoteKind = "task" | "batch";

export type MinerURemoteReference = {
  kind: MinerURemoteKind;
  id: string;
};

export type MinerURecognitionInput = {
  mode: Exclude<OcrRecognitionMode, "local">;
  /** Source file sent to MinerU. `imagePath` is accepted for old callers/tests. */
  filePath?: string;
  imagePath?: string;
  mimeType?: string | null;
  remoteFileName: string;
  apiToken?: string;
  pageRanges?: string | null;
  resume?: MinerURemoteReference | null;
  remoteStartedAtMs?: number | null;
  shouldContinue?: () => boolean;
  onSubmitted?: (reference: MinerURemoteReference) => void;
  onState?: (reference: MinerURemoteReference, state: string) => void;
};

export type MinerUPageResult = {
  pageNumber: number;
  lines: Array<Record<string, unknown>>;
};

export type MinerURecognitionResult = WorkerResponse & {
  /** Precise API page output. Agent results intentionally omit this mapping. */
  remotePages?: MinerUPageResult[];
  pageMappingAvailable?: boolean;
};

export type MinerURecognitionExecutor = (input: MinerURecognitionInput) => Promise<MinerURecognitionResult>;

type MinerUClientDependencies = {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  overallTimeoutMs: number;
  requestTimeoutMs: number;
};

export class MinerUClientError extends Error {
  code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MinerUClientError";
    this.code = code;
  }
}

function clientError(code: string, message: string, cause?: unknown) {
  return new MinerUClientError(code, message, cause === undefined ? undefined : { cause });
}

function defaultDependencies(): MinerUClientDependencies {
  return {
    fetch: globalThis.fetch,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
    pollIntervalMs: defaultPollIntervalMs,
    overallTimeoutMs: defaultOverallTimeoutMs,
    requestTimeoutMs: defaultRequestTimeoutMs
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedRemoteId(value: unknown) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 200 && /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

function safeRemoteFileName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  return name
    && name.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:pdf|jpe?g|png|webp|heic|heif)$/i.test(name)
    && basename(name) === name
    ? name
    : "";
}

function inputFilePath(input: MinerURecognitionInput) {
  const path = input.filePath || input.imagePath || "";
  if (!path) throw clientError("MINERU_PAGE_PREPARATION_FAILED", "MinerU 源文件路径缺失");
  return path;
}

function allowedAssetUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowedHost = host === "mineru.net"
      || host.endsWith(".openxlab.org.cn")
      || host.endsWith(".aliyuncs.com");
    if (url.protocol !== "https:" || url.username || url.password || !allowedHost) return null;
    return url;
  } catch {
    return null;
  }
}

async function readBoundedBytes(response: Response, maximumBytes: number, limitCode: string) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maximumBytes) {
    throw clientError(limitCode, "MinerU 返回内容超过安全限制");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw clientError(limitCode, "MinerU 返回内容超过安全限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function looksLikeDocumentLimit(message: string) {
  const normalized = message.normalize("NFKC").toLowerCase();
  return /(?:file|document)[ _-]?size.{0,40}(?:limit|large|exceed)/i.test(normalized)
    || /(?:page|pages|page count).{0,40}(?:limit|many|exceed)/i.test(normalized)
    || /(?:10|200)\s*mb/.test(normalized)
    || /(?:20|200)\s*(?:page|pages|页)/.test(normalized)
    || /文件(?:大小|尺寸).{0,30}(?:限制|过大|超过)/.test(normalized)
    || /页数.{0,30}(?:限制|过多|超过)/.test(normalized);
}

function looksLikeAuthenticationFailure(message: string) {
  const normalized = message.normalize("NFKC").toLowerCase();
  return /(?:unauthori[sz]ed|forbidden|invalid|expired).{0,30}(?:token|api[ _-]?key)/.test(normalized)
    || /(?:token|api[ _-]?key).{0,30}(?:invalid|expired|missing)/.test(normalized)
    || /(?:认证|鉴权|密钥).{0,30}(?:失败|无效|过期|缺失)/.test(normalized);
}

function looksLikeRateLimit(message: string) {
  const normalized = message.normalize("NFKC").toLowerCase();
  return /(?:too many requests|rate[ _-]?limit|request.{0,20}(?:quota|frequency))/.test(normalized)
    || /(?:请求频率|调用频率|额度).{0,30}(?:限制|超过|不足|用完)/.test(normalized);
}

function mapApiMessageError(message: string) {
  if (looksLikeDocumentLimit(message)) {
    return clientError("MINERU_LIMIT_EXCEEDED", "源文件超过 MinerU 官方大小或页数限制");
  }
  if (looksLikeAuthenticationFailure(message)) {
    return clientError("MINERU_AUTH_FAILED", "MinerU 认证失败，请管理员检查 API Token");
  }
  if (looksLikeRateLimit(message)) {
    return clientError("MINERU_RATE_LIMITED", "MinerU 请求频率或额度受限，请稍后重试");
  }
  return clientError("MINERU_UPSTREAM_ERROR", "MinerU 拒绝了处理请求");
}

function mapHttpError(status: number, responseText: string) {
  if (status === 413 || looksLikeDocumentLimit(responseText)) {
    return clientError("MINERU_LIMIT_EXCEEDED", "源文件超过 MinerU 官方大小或页数限制");
  }
  if (status === 401 || status === 403) {
    return clientError("MINERU_AUTH_FAILED", "MinerU 认证失败，请管理员检查 API Token");
  }
  if (status === 429) {
    return clientError("MINERU_RATE_LIMITED", "MinerU 请求频率或额度受限，请稍后重试");
  }
  if (status >= 500) return clientError("MINERU_SERVICE_ERROR", "MinerU 服务暂时不可用");
  return mapApiMessageError(responseText);
}

async function fetchWithMinerUError(
  url: URL,
  init: RequestInit,
  dependencies: MinerUClientDependencies,
  timeoutMs = dependencies.requestTimeoutMs
) {
  try {
    return await dependencies.fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, timeoutMs))
    });
  } catch (cause) {
    if (cause instanceof MinerUClientError) throw cause;
    const name = cause instanceof Error ? cause.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw clientError("MINERU_TIMEOUT", "等待 MinerU 响应超时", cause);
    }
    throw clientError("MINERU_NETWORK_ERROR", "无法连接 MinerU 服务", cause);
  }
}

async function responseTextForError(response: Response) {
  try {
    const bytes = await readBoundedBytes(response, 64 * 1024, "MINERU_RESPONSE_LIMIT_EXCEEDED");
    return decodeUtf8(bytes);
  } catch {
    return "";
  }
}

async function requestJson(
  path: string,
  init: RequestInit,
  dependencies: MinerUClientDependencies,
  apiToken?: string,
  timeoutMs = dependencies.requestTimeoutMs
) {
  const url = new URL(path, mineruOrigin);
  if (url.origin !== mineruOrigin) throw clientError("MINERU_INVALID_RESULT", "MinerU 控制接口地址无效");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (apiToken) headers.set("Authorization", `Bearer ${apiToken}`);
  const response = await fetchWithMinerUError(url, { ...init, headers }, dependencies, timeoutMs);
  if (!response.ok) throw mapHttpError(response.status, await responseTextForError(response));
  let text: string;
  try {
    text = decodeUtf8(await readBoundedBytes(response, jsonResponseLimit, "MINERU_RESPONSE_LIMIT_EXCEEDED"));
  } catch (cause) {
    if (cause instanceof MinerUClientError) throw cause;
    throw clientError("MINERU_INVALID_RESULT", "MinerU 返回了无效文本编码", cause);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw clientError("MINERU_INVALID_RESULT", "MinerU 返回了无效 JSON", cause);
  }
  if (!isRecord(value)) throw clientError("MINERU_INVALID_RESULT", "MinerU 返回格式无效");
  const code = value.code;
  if (code !== undefined && code !== null && code !== 0) {
    const message = typeof value.msg === "string" ? value.msg : "";
    throw mapApiMessageError(message);
  }
  return value;
}

async function uploadSignedFile(
  urlValue: unknown,
  filePath: string,
  dependencies: MinerUClientDependencies,
  timeoutMs = 5 * 60_000
) {
  const url = allowedAssetUrl(urlValue);
  if (!url) throw clientError("MINERU_INVALID_RESULT", "MinerU 返回了无效上传地址");
  let body: Buffer;
  try {
    body = readFileSync(filePath);
  } catch (cause) {
    throw clientError("MINERU_PAGE_PREPARATION_FAILED", "无法读取 MinerU 源文件", cause);
  }
  const response = await fetchWithMinerUError(url, {
    method: "PUT",
    // MinerU/OSS signs an explicitly empty Content-Type. Never forward the precise API token here.
    headers: { "Content-Type": "" },
    body: new Uint8Array(body)
  }, dependencies, timeoutMs);
  if (!response.ok) throw mapHttpError(response.status, await responseTextForError(response));
  try {
    await response.body?.cancel();
  } catch {
    // The signed upload is already accepted; an unreadable empty response body is irrelevant.
  }
}

function cleanMarkdownInline(value: string) {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\\([|*_`#[\]()>-])/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function tableSeparator(value: string) {
  const cells = value.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableCells(value: string) {
  if (!value.includes("|")) return null;
  const cells = value.trim().replace(/^\||\|$/g, "").split("|")
    .map((cell) => cleanMarkdownInline(cell))
    .filter(Boolean);
  return cells.length ? cells.join(" | ") : null;
}

export function markdownToOcrLines(markdown: string) {
  if (markdown.length > markdownTotalCharacterLimit * 4) {
    throw clientError("MINERU_RESPONSE_LIMIT_EXCEEDED", "MinerU Markdown 超过安全限制");
  }
  const output: Array<{ id: string; text: string }> = [];
  let totalCharacters = 0;
  let fenced = false;
  for (const rawLine of markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (!trimmed || /^<!--.*-->$/.test(trimmed) || tableSeparator(trimmed)) continue;
    if (!fenced && /^(?:[-*_]\s*){3,}$/.test(trimmed)) continue;
    let text = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^[-+*]\s+/, "")
      .replace(/^\d+[.)、]\s+/, "");
    text = tableCells(text) || cleanMarkdownInline(text);
    if (!text || /^[#>*_~`|\-\s]+$/.test(text)) continue;
    if (text.length > markdownLineCharacterLimit) {
      throw clientError("MINERU_RESPONSE_LIMIT_EXCEEDED", "MinerU Markdown 单行超过安全限制");
    }
    if (output.length >= markdownLineLimit) {
      throw clientError("MINERU_RESPONSE_LIMIT_EXCEEDED", "MinerU Markdown 行数超过安全限制");
    }
    totalCharacters += text.length;
    if (totalCharacters > markdownTotalCharacterLimit) {
      throw clientError("MINERU_RESPONSE_LIMIT_EXCEEDED", "MinerU Markdown 字符数超过安全限制");
    }
    output.push({ id: `mineru_line_${output.length + 1}`, text });
  }
  return output;
}

async function downloadMarkdown(
  urlValue: unknown,
  dependencies: MinerUClientDependencies,
  timeoutMs = 5 * 60_000
) {
  const url = allowedAssetUrl(urlValue);
  if (!url) throw clientError("MINERU_INVALID_RESULT", "MinerU 返回了无效结果地址");
  const response = await fetchWithMinerUError(url, { method: "GET" }, dependencies, timeoutMs);
  if (!response.ok) throw mapHttpError(response.status, await responseTextForError(response));
  try {
    return decodeUtf8(await readBoundedBytes(response, markdownResponseLimit, "MINERU_RESPONSE_LIMIT_EXCEEDED"));
  } catch (cause) {
    if (cause instanceof MinerUClientError) throw cause;
    throw clientError("MINERU_INVALID_RESULT", "MinerU Markdown 编码无效", cause);
  }
}

async function readEntryText(entry: Entry) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of entry) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > markdownResponseLimit) {
      entry.destroy();
      throw clientError("MINERU_RESPONSE_LIMIT_EXCEEDED", "MinerU full.md 超过安全限制");
    }
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (cause) {
    throw clientError("MINERU_INVALID_RESULT", "MinerU full.md 编码无效", cause);
  }
}

async function readEntryJson(entry: Entry) {
  const text = await readEntryText(entry);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw clientError("MINERU_INVALID_RESULT", "MinerU content_list.json 无效", cause);
  }
}

async function downloadFullMarkdownFromZip(
  urlValue: unknown,
  dependencies: MinerUClientDependencies,
  timeoutMs = 5 * 60_000
) {
  const url = allowedAssetUrl(urlValue);
  if (!url) throw clientError("MINERU_INVALID_RESULT", "MinerU 返回了无效结果地址");
  const response = await fetchWithMinerUError(url, { method: "GET" }, dependencies, timeoutMs);
  if (!response.ok) throw mapHttpError(response.status, await responseTextForError(response));
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > zipResponseLimit) {
    throw clientError("MINERU_RESPONSE_LIMIT_EXCEEDED", "MinerU ZIP 超过安全限制");
  }
  if (!response.body) throw clientError("MINERU_INVALID_RESULT", "MinerU ZIP 响应为空");

  let streamedBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      streamedBytes += chunk.byteLength;
      if (streamedBytes > zipResponseLimit) {
        callback(clientError("MINERU_RESPONSE_LIMIT_EXCEEDED", "MinerU ZIP 超过安全限制"));
        return;
      }
      callback(null, chunk);
    }
  });
  const parser = Parse({ forceStream: true });
  const source = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
  source.on("error", (error) => parser.destroy(error));
  limiter.on("error", (error) => parser.destroy(error));
  source.pipe(limiter).pipe(parser);
  let entryCount = 0;
  let markdown: string | null = null;
  let contentList: unknown = null;
  try {
    for await (const value of parser as unknown as AsyncIterable<Entry>) {
      const entry = value as Entry;
      entryCount += 1;
      if (entryCount > zipEntryLimit) {
        entry.destroy();
        throw clientError("MINERU_RESPONSE_LIMIT_EXCEEDED", "MinerU ZIP 文件项超过安全限制");
      }
      if (entry.type === "File" && basename(entry.path).toLowerCase() === "full.md" && markdown === null) {
        markdown = await readEntryText(entry);
      } else if (
        entry.type === "File"
        && /(?:^|_)content_list\.json$/i.test(basename(entry.path))
        && contentList === null
      ) {
        contentList = await readEntryJson(entry);
      } else {
        entry.autodrain();
      }
    }
  } catch (cause) {
    source.destroy();
    limiter.destroy();
    parser.destroy();
    if (cause instanceof MinerUClientError) throw cause;
    throw clientError("MINERU_INVALID_RESULT", "MinerU ZIP 结果损坏", cause);
  }
  if (markdown === null) throw clientError("MINERU_INVALID_RESULT", "MinerU ZIP 缺少 full.md");
  return { markdown, contentList };
}

function ensureStillProcessable(input: MinerURecognitionInput) {
  if (input.shouldContinue && !input.shouldContinue()) {
    throw clientError("MINERU_CANCELLED", "MinerU 任务已取消");
  }
}

function remainingTime(deadline: number, dependencies: MinerUClientDependencies) {
  const remaining = deadline - dependencies.now();
  if (remaining <= 0) throw clientError("MINERU_TIMEOUT", "等待 MinerU 单页解析超过 30 分钟");
  return remaining;
}

function boundedOperationTimeout(
  deadline: number,
  maximumMs: number,
  dependencies: MinerUClientDependencies
) {
  return Math.max(1, Math.min(maximumMs, remainingTime(deadline, dependencies)));
}

async function waitBeforeNextPoll(deadline: number, dependencies: MinerUClientDependencies) {
  const remaining = remainingTime(deadline, dependencies);
  await dependencies.sleep(Math.min(dependencies.pollIntervalMs, remaining));
}

function upstreamFailed(message: unknown) {
  const detail = typeof message === "string" ? message : "";
  if (looksLikeDocumentLimit(detail)) {
    return clientError("MINERU_LIMIT_EXCEEDED", "源文件超过 MinerU 官方大小或页数限制");
  }
  return clientError("MINERU_UPSTREAM_FAILED", "MinerU 未能解析该页面");
}

async function submitAgent(
  input: MinerURecognitionInput,
  deadline: number,
  dependencies: MinerUClientDependencies
) {
  const remoteFileName = safeRemoteFileName(input.remoteFileName);
  if (!remoteFileName) throw clientError("MINERU_INVALID_RESULT", "MinerU 临时页面名称无效");
  const result = await requestJson("/api/v1/agent/parse/file", {
    method: "POST",
    body: JSON.stringify({
      file_name: remoteFileName,
      language: "ch",
      enable_table: true,
      is_ocr: true,
      enable_formula: true
    })
  }, dependencies, undefined, boundedOperationTimeout(deadline, dependencies.requestTimeoutMs, dependencies));
  const data = isRecord(result.data) ? result.data : {};
  const id = boundedRemoteId(data.task_id);
  if (!id) throw clientError("MINERU_INVALID_RESULT", "MinerU Agent 未返回有效任务 ID");
  await uploadSignedFile(
    data.file_url,
    inputFilePath(input),
    dependencies,
    boundedOperationTimeout(deadline, 5 * 60_000, dependencies)
  );
  const reference: MinerURemoteReference = { kind: "task", id };
  input.onSubmitted?.(reference);
  return reference;
}

async function submitPrecise(
  input: MinerURecognitionInput,
  deadline: number,
  dependencies: MinerUClientDependencies
) {
  const token = input.apiToken?.trim() || "";
  if (!token) throw clientError("MINERU_AUTH_FAILED", "MinerU 精准解析 Token 尚未配置");
  const remoteFileName = safeRemoteFileName(input.remoteFileName);
  if (!remoteFileName) throw clientError("MINERU_INVALID_RESULT", "MinerU 临时页面名称无效");
  const result = await requestJson("/api/v4/file-urls/batch", {
    method: "POST",
    body: JSON.stringify({
      files: [{ name: remoteFileName }],
      model_version: "vlm",
      language: "ch",
      is_ocr: true,
      enable_table: true,
      enable_formula: true,
      ...(input.pageRanges ? { page_ranges: input.pageRanges } : {})
    })
  }, dependencies, token, boundedOperationTimeout(deadline, dependencies.requestTimeoutMs, dependencies));
  const data = isRecord(result.data) ? result.data : {};
  const id = boundedRemoteId(data.batch_id);
  const fileUrls = Array.isArray(data.file_urls) ? data.file_urls : [];
  if (!id || fileUrls.length !== 1) {
    throw clientError("MINERU_INVALID_RESULT", "MinerU 精准解析未返回有效批次信息");
  }
  await uploadSignedFile(
    fileUrls[0],
    inputFilePath(input),
    dependencies,
    boundedOperationTimeout(deadline, 5 * 60_000, dependencies)
  );
  const reference: MinerURemoteReference = { kind: "batch", id };
  input.onSubmitted?.(reference);
  return reference;
}

async function pollAgent(
  input: MinerURecognitionInput,
  reference: MinerURemoteReference,
  deadline: number,
  dependencies: MinerUClientDependencies
) {
  let previousState = "";
  while (true) {
    ensureStillProcessable(input);
    remainingTime(deadline, dependencies);
    const result = await requestJson(
      `/api/v1/agent/parse/${encodeURIComponent(reference.id)}`,
      { method: "GET" },
      dependencies,
      undefined,
      boundedOperationTimeout(deadline, dependencies.requestTimeoutMs, dependencies)
    );
    const data = isRecord(result.data) ? result.data : {};
    const state = typeof data.state === "string" ? data.state : "";
    if (!state) throw clientError("MINERU_INVALID_RESULT", "MinerU Agent 状态无效");
    if (!["waiting-file", "uploading", "pending", "converting", "running", "done", "failed"].includes(state)) {
      throw clientError("MINERU_INVALID_RESULT", "MinerU Agent 返回了未知状态");
    }
    if (state !== previousState) {
      input.onState?.(reference, state);
      previousState = state;
    }
    if (state === "done") {
      return downloadMarkdown(
        data.markdown_url,
        dependencies,
        boundedOperationTimeout(deadline, 5 * 60_000, dependencies)
      );
    }
    if (state === "failed") throw upstreamFailed(data.err_msg);
    await waitBeforeNextPoll(deadline, dependencies);
  }
}

async function pollPrecise(
  input: MinerURecognitionInput,
  reference: MinerURemoteReference,
  deadline: number,
  dependencies: MinerUClientDependencies
) {
  const token = input.apiToken?.trim() || "";
  if (!token) throw clientError("MINERU_AUTH_FAILED", "MinerU 精准解析 Token 尚未配置");
  let previousState = "";
  while (true) {
    ensureStillProcessable(input);
    remainingTime(deadline, dependencies);
    const result = await requestJson(
      `/api/v4/extract-results/batch/${encodeURIComponent(reference.id)}`,
      { method: "GET" },
      dependencies,
      token,
      boundedOperationTimeout(deadline, dependencies.requestTimeoutMs, dependencies)
    );
    const data = isRecord(result.data) ? result.data : {};
    const extractResult = Array.isArray(data.extract_result) ? data.extract_result : [];
    if (extractResult.length === 0) {
      if (previousState !== "pending") {
        input.onState?.(reference, "pending");
        previousState = "pending";
      }
      await waitBeforeNextPoll(deadline, dependencies);
      continue;
    }
    const item = extractResult.length === 1 && isRecord(extractResult[0]) ? extractResult[0] : null;
    if (!item) throw clientError("MINERU_INVALID_RESULT", "MinerU 精准解析状态无效");
    const state = typeof item.state === "string" ? item.state : "";
    if (!state) throw clientError("MINERU_INVALID_RESULT", "MinerU 精准解析状态无效");
    if (!["waiting-file", "uploading", "pending", "converting", "running", "done", "failed"].includes(state)) {
      throw clientError("MINERU_INVALID_RESULT", "MinerU 精准解析返回了未知状态");
    }
    if (state !== previousState) {
      input.onState?.(reference, state);
      previousState = state;
    }
    if (state === "done") {
      return downloadFullMarkdownFromZip(
        item.full_zip_url,
        dependencies,
        boundedOperationTimeout(deadline, 5 * 60_000, dependencies)
      );
    }
    if (state === "failed") throw upstreamFailed(item.err_msg);
    await waitBeforeNextPoll(deadline, dependencies);
  }
}

function contentListItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["content_list", "contentList", "items", "contents"]) {
    if (Array.isArray(value[key])) return value[key].filter(isRecord);
  }
  return [];
}

function tableBodyToMarkdown(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:td|th)\s*>/gi, " | ")
    .replace(/<\/(?:tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function contentItemText(item: Record<string, unknown>) {
  const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
  if (["image", "img", "figure"].includes(type)) return "";
  if (typeof item.table_body === "string") return tableBodyToMarkdown(item.table_body);
  if (typeof item.tableBody === "string") return tableBodyToMarkdown(item.tableBody);
  for (const key of ["text", "content", "latex", "equation", "value"]) {
    if (typeof item[key] === "string") return item[key] as string;
  }
  return "";
}

function contentListToRemotePages(value: unknown) {
  const items = contentListItems(value);
  if (!items.length) throw clientError("MINERU_INVALID_RESULT", "MinerU 精准结果缺少有效页级内容");
  const grouped = new Map<number, string[]>();
  const pageIndexes = new Set<number>();
  for (const item of items) {
    const rawPage = item.page_idx ?? item.pageIndex ?? item.page_number ?? item.pageNumber;
    const pageIndex = Number(rawPage);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 500) {
      throw clientError("MINERU_INVALID_RESULT", "MinerU 精准结果缺少有效页码");
    }
    /* Image-only pages still count.  Record the index before filtering their
       non-text content so a missing tail page cannot be silently dropped. */
    pageIndexes.add(pageIndex);
    const text = contentItemText(item).trim();
    if (!text) continue;
    grouped.set(pageIndex, [...(grouped.get(pageIndex) || []), text]);
  }
  const maxPageIndex = Math.max(...pageIndexes);
  if (!Number.isInteger(maxPageIndex) || maxPageIndex < 0 || maxPageIndex >= 500) {
    throw clientError("MINERU_INVALID_RESULT", "MinerU 精准结果页数无效");
  }
  for (let index = 0; index <= maxPageIndex; index += 1) {
    if (!pageIndexes.has(index)) {
      throw clientError("MINERU_INVALID_RESULT", "MinerU 精准结果页码不连续");
    }
  }
  const pages: MinerUPageResult[] = [];
  for (let index = 0; index <= maxPageIndex; index += 1) {
    const markdown = (grouped.get(index) || []).join("\n");
    const lines = markdownToOcrLines(markdown).map((line, lineIndex) => ({
      ...line,
      id: `mineru_page_${index + 1}_line_${lineIndex + 1}`
    }));
    pages.push({ pageNumber: index + 1, lines });
  }
  return pages;
}

export async function recognizePageWithMinerU(
  input: MinerURecognitionInput,
  overrides: Partial<MinerUClientDependencies> = {}
): Promise<MinerURecognitionResult> {
  if (input.mode !== "mineru_agent" && input.mode !== "mineru_precise") {
    throw clientError("MINERU_INVALID_MODE", "MinerU 识别方式无效");
  }
  const dependencies = { ...defaultDependencies(), ...overrides };
  const invokedAt = dependencies.now();
  const resumedStartedAt = Number(input.remoteStartedAtMs);
  const startedAt = input.resume
    && Number.isFinite(resumedStartedAt)
    && resumedStartedAt > 0
    && resumedStartedAt <= invokedAt
      ? resumedStartedAt
      : invokedAt;
  const deadline = startedAt + dependencies.overallTimeoutMs;
  ensureStillProcessable(input);
  let reference = input.resume || null;
  if (reference) {
    const expectedKind = input.mode === "mineru_agent" ? "task" : "batch";
    if (reference.kind !== expectedKind || !boundedRemoteId(reference.id)) {
      throw clientError("MINERU_INVALID_RESULT", "MinerU 恢复任务信息无效");
    }
  } else {
    reference = input.mode === "mineru_agent"
      ? await submitAgent(input, deadline, dependencies)
      : await submitPrecise(input, deadline, dependencies);
  }
  const preciseResult = input.mode === "mineru_precise"
    ? await pollPrecise(input, reference, deadline, dependencies)
    : null;
  const markdown = input.mode === "mineru_agent"
    ? await pollAgent(input, reference, deadline, dependencies)
    : preciseResult!.markdown;
  ensureStillProcessable(input);
  const remotePages = preciseResult?.contentList
    ? contentListToRemotePages(preciseResult.contentList)
    : undefined;
  if (input.mode === "mineru_precise" && input.mimeType === "application/pdf" && !remotePages) {
    throw clientError("MINERU_INVALID_RESULT", "MinerU 精准 PDF 结果缺少页级内容列表");
  }
  const lines = remotePages?.[0]?.lines || markdownToOcrLines(markdown);
  return {
    ok: true,
    engine: input.mode === "mineru_agent" ? "mineru-agent" : "mineru-precise",
    modelVersion: input.mode === "mineru_agent" ? "agent" : "vlm",
    lines,
    remotePages,
    pageMappingAvailable: Boolean(remotePages?.length),
    elapsedMs: Math.max(0, Math.round(dependencies.now() - startedAt)),
    engineElapsed: {
      source: "mineru_markdown",
      requestedMode: input.mode,
      coordinateAvailable: false,
      pageMappingAvailable: Boolean(remotePages?.length)
    }
  };
}

/** New source-file naming retained alongside the old export for compatibility. */
export const recognizeSourceWithMinerU = recognizePageWithMinerU;
