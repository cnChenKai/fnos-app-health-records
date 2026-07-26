import packageJson from "../../../package.json" with { type: "json" };
import { getAppConfig } from "../utils/runtime-config";

export type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseUrl: string;
  downloadUrl: string;
  downloadSizeBytes: number | null;
  publishedAt: string;
  checkedAt: string;
};

type ReleasePayload = {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
};

export type ReleaseFetcher = () => Promise<ReleasePayload>;

const successTtlMs = 30 * 60 * 1000;
const failureTtlMs = 2 * 60 * 1000;
let successCache: { result: UpdateCheckResult; expiresAt: number } | null = null;
let failureCache: { message: string; expiresAt: number } | null = null;

function repositoryUrl() {
  return packageJson.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
}

/* 语义化版本比较：a < b 返回 -1，相等返回 0，a > b 返回 1；忽略 - 后的预发布后缀 */
export function compareVersions(a: string, b: string) {
  const pa = a.split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] || 0) - (pb[index] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/* NAS 访问 GitHub 可能超时或被限流，统一转成用户可理解的提示 */
const defaultFetcher: ReleaseFetcher = async () => {
  let response: Response;
  try {
    response = await fetch(`${repositoryUrl().replace("github.com", "api.github.com/repos")}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "fnos-app-health-records" },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw new Error("无法连接 GitHub，请检查 NAS 网络后重试");
  }
  if (response.status === 404) throw new Error("GitHub 上还没有已发布的版本");
  if (!response.ok) throw new Error(`GitHub 请求失败（HTTP ${response.status}），请稍后重试`);
  return response.json() as Promise<ReleasePayload>;
};

export async function checkForUpdates(refresh = false, fetcher: ReleaseFetcher = defaultFetcher): Promise<UpdateCheckResult> {
  const now = Date.now();
  if (!refresh && successCache && successCache.expiresAt > now) return successCache.result;
  if (!refresh && failureCache && failureCache.expiresAt > now) throw new Error(failureCache.message);
  try {
    const release = await fetcher();
    const latestVersion = String(release.tag_name || "").trim().replace(/^v/i, "");
    if (!latestVersion) throw new Error("GitHub 上还没有已发布的版本");
    const fpkAsset = (release.assets || []).find((asset) => asset.name?.endsWith(".fpk") && asset.browser_download_url);
    const currentVersion = getAppConfig().appVersion;
    const result: UpdateCheckResult = {
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(currentVersion, latestVersion) < 0,
      releaseName: release.name || `v${latestVersion}`,
      releaseUrl: release.html_url || `${repositoryUrl()}/releases`,
      downloadUrl: fpkAsset?.browser_download_url || "",
      downloadSizeBytes: typeof fpkAsset?.size === "number" ? fpkAsset.size : null,
      publishedAt: release.published_at || "",
      checkedAt: new Date(now).toISOString()
    };
    successCache = { result, expiresAt: now + successTtlMs };
    failureCache = null;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "检查更新失败";
    failureCache = { message, expiresAt: now + failureTtlMs };
    throw new Error(message);
  }
}
