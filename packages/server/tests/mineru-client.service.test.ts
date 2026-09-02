import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  markdownToOcrLines,
  MinerUClientError,
  recognizePageWithMinerU,
} from "../services/mineru-client.service.ts";

type FetchCall = { url: string; init: RequestInit; headers: Headers };

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(name: string, content: string) {
  const fileName = Buffer.from(name, "utf8");
  const data = Buffer.from(content, "utf8");
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.byteLength, 18);
  local.writeUInt32LE(data.byteLength, 22);
  local.writeUInt16LE(fileName.byteLength, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.byteLength, 20);
  central.writeUInt32LE(data.byteLength, 24);
  central.writeUInt16LE(fileName.byteLength, 28);

  const centralOffset = local.byteLength + fileName.byteLength + data.byteLength;
  const centralSize = central.byteLength + fileName.byteLength;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

async function withImage(run: (imagePath: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "health-records-mineru-client-"));
  const imagePath = join(directory, "page.jpg");
  writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    await run(imagePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function errorCode(expected: string) {
  return (error: unknown) => error instanceof MinerUClientError && error.code === expected;
}

test("Agent parsing never sends authorization and converts Markdown into stable OCR lines", async () => {
  await withImage(async (imagePath) => {
    const calls: FetchCall[] = [];
    const mockFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      calls.push({ url, init, headers });
      if (url === "https://mineru.net/api/v1/agent/parse/file") {
        return jsonResponse({
          code: 0,
          data: {
            task_id: "agent-task-1",
            file_url: "https://oss-mineru.openxlab.org.cn/upload/page.jpg?signature=hidden",
          },
        });
      }
      if (url.startsWith("https://oss-mineru.openxlab.org.cn/")) return new Response(null, { status: 200 });
      if (url === "https://mineru.net/api/v1/agent/parse/agent-task-1") {
        return jsonResponse({
          code: 0,
          data: {
            state: "done",
            markdown_url: "https://cdn-mineru.openxlab.org.cn/result/full.md?signature=hidden",
          },
        });
      }
      if (url.startsWith("https://cdn-mineru.openxlab.org.cn/")) {
        return new Response([
          "# 检验报告",
          "![page](images/page.jpg)",
          "| 项目 | 结果 |",
          "| --- | --- |",
          "| 空腹血糖 | **5.2 mmol/L** |",
          "正文 [参考](https://example.invalid)",
        ].join("\n"), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const submitted: Array<{ kind: string; id: string }> = [];
    const result = await recognizePageWithMinerU({
      mode: "mineru_agent",
      imagePath,
      remoteFileName: "page-safe-job.jpg",
      onSubmitted: (reference) => submitted.push(reference),
    }, { fetch: mockFetch });

    assert.equal(result.engine, "mineru-agent");
    assert.deepEqual(result.lines, [
      { id: "mineru_line_1", text: "检验报告" },
      { id: "mineru_line_2", text: "项目 | 结果" },
      { id: "mineru_line_3", text: "空腹血糖 | 5.2 mmol/L" },
      { id: "mineru_line_4", text: "正文 参考" },
    ]);
    assert.deepEqual(submitted, [{ kind: "task", id: "agent-task-1" }]);
    assert.equal(calls.length, 4);
    assert.equal(calls.every((call) => call.headers.get("authorization") === null), true);
    assert.equal(calls.every((call) => call.init.redirect === "error"), true);
    const requestBody = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.deepEqual(requestBody, {
      file_name: "page-safe-job.jpg",
      language: "ch",
      enable_table: true,
      is_ocr: true,
      enable_formula: true,
    });
    assert.equal(calls[1]?.init.method, "PUT");
    assert.equal(calls[1]?.headers.get("content-type"), "");
  });
});

test("precise parsing confines Bearer auth to control endpoints and streams only full.md from ZIP", async () => {
  await withImage(async (imagePath) => {
    const calls: FetchCall[] = [];
    const zip = storedZip("nested/full.md", "# 精准结果\n| 指标 | 数值 |\n| --- | --- |\n| 肌酐 | 78 μmol/L |");
    let pollCalls = 0;
    const mockFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      calls.push({ url, init, headers });
      if (url === "https://mineru.net/api/v4/file-urls/batch") {
        return jsonResponse({
          code: 0,
          data: {
            batch_id: "precise-batch-1",
            file_urls: ["https://oss-mineru.openxlab.org.cn/upload/precise.jpg?signature=hidden"],
          },
        });
      }
      if (url.startsWith("https://oss-mineru.openxlab.org.cn/")) return new Response(null, { status: 200 });
      if (url === "https://mineru.net/api/v4/extract-results/batch/precise-batch-1") {
        pollCalls += 1;
        if (pollCalls === 1) return jsonResponse({ code: 0, data: { extract_result: [] } });
        return jsonResponse({
          code: 0,
          data: {
            extract_result: [{
              state: "done",
              full_zip_url: "https://cdn-mineru.openxlab.org.cn/result/result.zip?signature=hidden",
            }],
          },
        });
      }
      if (url.startsWith("https://cdn-mineru.openxlab.org.cn/")) {
        return new Response(zip, {
          status: 200,
          headers: { "content-length": String(zip.byteLength), "content-type": "application/zip" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await recognizePageWithMinerU({
      mode: "mineru_precise",
      imagePath,
      remoteFileName: "page-safe-precise.jpg",
      apiToken: "precise-secret-token",
    }, { fetch: mockFetch, sleep: async () => undefined });

    assert.equal(result.engine, "mineru-precise");
    assert.deepEqual(result.lines, [
      { id: "mineru_line_1", text: "精准结果" },
      { id: "mineru_line_2", text: "指标 | 数值" },
      { id: "mineru_line_3", text: "肌酐 | 78 μmol/L" },
    ]);
    assert.equal(calls.length, 5);
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer precise-secret-token");
    assert.equal(calls[2]?.headers.get("authorization"), "Bearer precise-secret-token");
    assert.equal(calls[3]?.headers.get("authorization"), "Bearer precise-secret-token");
    assert.equal(calls[1]?.headers.get("authorization"), null);
    assert.equal(calls[4]?.headers.get("authorization"), null);
    assert.equal(calls[1]?.headers.get("content-type"), "");
    const requestBody = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown> & {
      files: Array<Record<string, unknown>>;
      model_version: string;
    };
    assert.deepEqual(requestBody.files, [{ name: "page-safe-precise.jpg" }]);
    assert.equal(requestBody.model_version, "vlm");
    assert.deepEqual(Object.keys(requestBody).sort(), [
      "enable_formula",
      "enable_table",
      "files",
      "is_ocr",
      "language",
      "model_version",
    ]);
    assert.equal(requestBody.language, "ch");
    assert.equal(requestBody.is_ocr, true);
    assert.equal(requestBody.enable_table, true);
    assert.equal(requestBody.enable_formula, true);
  });
});

test("resumes an uploaded task without resubmission and preserves the original timeout window", async () => {
  await withImage(async (imagePath) => {
    const urls: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://mineru.net/api/v1/agent/parse/resume-task") {
        return jsonResponse({
          code: 0,
          data: { state: "done", markdown_url: "https://cdn-mineru.openxlab.org.cn/resume/full.md" },
        });
      }
      return new Response("恢复结果", { status: 200 });
    }) as typeof fetch;
    const result = await recognizePageWithMinerU({
      mode: "mineru_agent",
      imagePath,
      remoteFileName: "page-resume.jpg",
      resume: { kind: "task", id: "resume-task" },
      remoteStartedAtMs: 1_000,
    }, { fetch: mockFetch, now: () => 4_000 });
    assert.equal(result.elapsedMs, 3_000);
    assert.deepEqual(urls, [
      "https://mineru.net/api/v1/agent/parse/resume-task",
      "https://cdn-mineru.openxlab.org.cn/resume/full.md",
    ]);

    let fetchCalls = 0;
    await assert.rejects(
      () => recognizePageWithMinerU({
        mode: "mineru_agent",
        imagePath,
        remoteFileName: "page-expired.jpg",
        resume: { kind: "task", id: "resume-task" },
        remoteStartedAtMs: 1_000,
      }, {
        fetch: (async () => {
          fetchCalls += 1;
          return jsonResponse({});
        }) as typeof fetch,
        now: () => 1_000 + 30 * 60_000 + 1,
      }),
      errorCode("MINERU_TIMEOUT"),
    );
    assert.equal(fetchCalls, 0);
  });
});

test("maps authentication, rate, network and document-limit failures to explicit retry codes", async () => {
  await withImage(async (imagePath) => {
    const cases: Array<{ expected: string; fetch: typeof fetch }> = [
      {
        expected: "MINERU_AUTH_FAILED",
        fetch: (async () => new Response("invalid token", { status: 401 })) as typeof fetch,
      },
      {
        expected: "MINERU_RATE_LIMITED",
        fetch: (async () => new Response("too many requests", { status: 429 })) as typeof fetch,
      },
      {
        expected: "MINERU_LIMIT_EXCEEDED",
        fetch: (async () => new Response("file size exceeded", { status: 413 })) as typeof fetch,
      },
      {
        expected: "MINERU_AUTH_FAILED",
        fetch: (async () => jsonResponse({ code: 1001, msg: "API token invalid" })) as typeof fetch,
      },
      {
        expected: "MINERU_RATE_LIMITED",
        fetch: (async () => jsonResponse({ code: 1002, msg: "too many requests" })) as typeof fetch,
      },
      {
        expected: "MINERU_NETWORK_ERROR",
        fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
      },
    ];
    for (const current of cases) {
      await assert.rejects(
        () => recognizePageWithMinerU({
          mode: "mineru_agent",
          imagePath,
          remoteFileName: "page-error.jpg",
        }, { fetch: current.fetch }),
        errorCode(current.expected),
      );
    }
  });
});

test("rejects untrusted asset hosts, unsafe filenames, damaged ZIPs and oversized Markdown", async () => {
  await withImage(async (imagePath) => {
    let fetchCalls = 0;
    const untrustedFetch = (async () => {
      fetchCalls += 1;
      return jsonResponse({
        code: 0,
        data: { task_id: "unsafe-host", file_url: "https://evil.example/upload.jpg" },
      });
    }) as typeof fetch;
    await assert.rejects(
      () => recognizePageWithMinerU({
        mode: "mineru_agent",
        imagePath,
        remoteFileName: "page-safe.jpg",
      }, { fetch: untrustedFetch }),
      errorCode("MINERU_INVALID_RESULT"),
    );
    assert.equal(fetchCalls, 1);

    let unsafeNameFetchCalls = 0;
    await assert.rejects(
      () => recognizePageWithMinerU({
        mode: "mineru_agent",
        imagePath,
        remoteFileName: "../../private-health-report.jpg",
      }, {
        fetch: (async () => {
          unsafeNameFetchCalls += 1;
          return jsonResponse({});
        }) as typeof fetch,
      }),
      errorCode("MINERU_INVALID_RESULT"),
    );
    assert.equal(unsafeNameFetchCalls, 0);

    const preciseFetch = (zipResponse: () => Response) => (async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      if (url === "https://mineru.net/api/v4/file-urls/batch") {
        return jsonResponse({
          code: 0,
          data: {
            batch_id: "damaged-batch",
            file_urls: ["https://oss-mineru.openxlab.org.cn/damaged.jpg"],
          },
        });
      }
      if (init.method === "PUT") return new Response(null, { status: 200 });
      if (url === "https://mineru.net/api/v4/extract-results/batch/damaged-batch") {
        return jsonResponse({
          code: 0,
          data: {
            extract_result: [{
              state: "done",
              full_zip_url: "https://cdn-mineru.openxlab.org.cn/damaged.zip",
            }],
          },
        });
      }
      return zipResponse();
    }) as typeof fetch;
    const missingFullMarkdown = storedZip("other.md", "not the requested result");
    await assert.rejects(
      () => recognizePageWithMinerU({
        mode: "mineru_precise",
        imagePath,
        remoteFileName: "page-damaged.jpg",
        apiToken: "test-token",
      }, {
        fetch: preciseFetch(() => new Response(missingFullMarkdown, { status: 200 })),
      }),
      errorCode("MINERU_INVALID_RESULT"),
    );
    await assert.rejects(
      () => recognizePageWithMinerU({
        mode: "mineru_precise",
        imagePath,
        remoteFileName: "page-oversized.jpg",
        apiToken: "test-token",
      }, {
        fetch: preciseFetch(() => new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": String(64 * 1024 * 1024 + 1) },
        })),
      }),
      errorCode("MINERU_RESPONSE_LIMIT_EXCEEDED"),
    );

    assert.throws(
      () => markdownToOcrLines("x".repeat(16_001)),
      errorCode("MINERU_RESPONSE_LIMIT_EXCEEDED"),
    );
  });
});
