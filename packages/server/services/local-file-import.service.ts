import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createError } from "h3";
import type { RequestUser } from "../domain/request-user";
import { getAppConfig } from "../utils/runtime-config";
import { createUploadFromLocalFiles } from "./upload.service";

const supportedName = /\.(?:heic|heif|jpe?g|png|webp|pdf)$/i;
const maxDirectoryEntries = 500;

export type LocalImportRoot = {
  id: string;
  label: string;
  path: string;
};

export type LocalImportEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number | null;
  modifiedAt: string;
};

export type LocalImportAvailability = {
  state: "ready" | "not_configured" | "unavailable";
  configuredCount: number;
  unavailableCount: number;
  message: string | null;
};

function parseConfiguredPaths(value: string | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    } catch {
      // Continue with delimiter parsing so a malformed value is reported as unavailable, not a startup failure.
    }
  }
  const lineParts = raw.split(/[\r\n,;]+/).map((item) => item.trim()).filter(Boolean);
  if (lineParts.length > 1) return lineParts;
  return raw.split(sep === "/" ? ":" : ";").map((item) => item.trim()).filter(Boolean);
}

function configuredPaths() {
  const config = getAppConfig();
  if (config.authMode === "fnos") {
    const snapshotPath = join(config.storageDir, "config", "fnos-authorized-paths");
    if (existsSync(snapshotPath)) {
      try {
        return parseConfiguredPaths(readFileSync(snapshotPath, "utf8"));
      } catch {
        // Fall back to the startup environment if a concurrent lifecycle update cannot be read.
      }
    }
    return parseConfiguredPaths(process.env.TRIM_DATA_ACCESSIBLE_PATHS);
  }
  if (config.authMode === "local" || config.authMode === "development") {
    return parseConfiguredPaths(process.env.IMPORT_ROOTS);
  }
  return [];
}

function emptyAvailability(configuredCount: number, unavailableCount: number): LocalImportAvailability {
  const authMode = getAppConfig().authMode;
  if (!configuredCount) {
    const message = authMode === "fnos"
      ? "飞牛尚未向应用提供授权目录。若刚完成授权，请在应用中心停止并重新启动“健康档案”，然后点击重新检测。"
      : authMode === "local"
        ? "尚未配置 Docker 导入目录，请检查 IMPORT_ROOTS 和只读目录挂载后重建容器。"
        : "尚未配置可导入目录，请检查 IMPORT_ROOTS 后重启开发服务。";
    return { state: "not_configured", configuredCount, unavailableCount, message };
  }
  const message = authMode === "fnos"
    ? `飞牛已提供 ${configuredCount} 个授权目录，但应用当前无法读取。请确认目录仍存在，并在应用中心停止后重新启动“健康档案”。`
    : authMode === "local"
      ? `已配置 ${configuredCount} 个 Docker 导入目录，但容器当前无法读取。请检查只读挂载和容器 UID 1000 的目录权限。`
      : `已配置 ${configuredCount} 个导入目录，但开发服务当前无法读取。请检查路径和本机权限。`;
  return { state: "unavailable", configuredCount, unavailableCount, message };
}

function unreadableDirectoryMessage() {
  const authMode = getAppConfig().authMode;
  if (authMode === "fnos") return "目录不可读取，请检查飞牛应用的授权目录设置";
  if (authMode === "local") return "目录不可读取，请检查 Docker 只读挂载及容器 UID 1000 的读取权限";
  if (authMode === "development") return "目录不可读取，请检查 IMPORT_ROOTS 和本机目录权限";
  return "目录不可读取，请检查当前部署的目录导入配置";
}

function rootId(path: string) {
  return createHash("sha256").update(path).digest("hex").slice(0, 20);
}

function inspectLocalImportRoots() {
  const configured = configuredPaths();
  const roots = new Map<string, LocalImportRoot>();
  let unavailableCount = 0;
  for (const configuredPath of configured) {
    try {
      const path = realpathSync(resolve(configuredPath));
      if (!statSync(path).isDirectory()) {
        unavailableCount += 1;
        continue;
      }
      if (roots.has(path)) continue;
      roots.set(path, { id: rootId(path), label: basename(path) || path, path });
    } catch {
      unavailableCount += 1;
    }
  }
  const availableRoots = [...roots.values()];
  const availability = availableRoots.length
    ? {
        state: "ready" as const,
        configuredCount: configured.length,
        unavailableCount,
        message: unavailableCount
          ? `${unavailableCount} 个已配置目录当前不可读取，未在列表中显示。`
          : null
      }
    : emptyAvailability(configured.length, unavailableCount);
  return { roots: availableRoots, availability };
}

export function listLocalImportRoots(): LocalImportRoot[] {
  return inspectLocalImportRoots().roots;
}

function getRoot(id: string) {
  const root = listLocalImportRoots().find((item) => item.id === id);
  if (!root) throw createError({ statusCode: 404, statusMessage: "导入目录不存在或尚未授权" });
  return root;
}

function cleanRelativePath(value: unknown) {
  const path = String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!path) return "";
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw createError({ statusCode: 400, statusMessage: "目录路径无效" });
  }
  return segments.join("/");
}

function resolveInsideRoot(root: LocalImportRoot, path: string) {
  const requested = path ? join(root.path, ...path.split("/")) : root.path;
  let actual: string;
  try {
    actual = realpathSync(requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw createError({
      statusCode: code === "EACCES" || code === "EPERM" ? 403 : 404,
      statusMessage: code === "EACCES" || code === "EPERM" ? "没有权限读取该文件或目录" : "文件或目录不存在"
    });
  }
  const childPath = relative(root.path, actual);
  if (childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
    throw createError({ statusCode: 403, statusMessage: "文件路径超出已授权目录" });
  }
  return actual;
}

export function listLocalImportDirectory(rootIdValue?: unknown, pathValue?: unknown) {
  const inspected = inspectLocalImportRoots();
  const { roots, availability } = inspected;
  if (!rootIdValue) return { roots, current: null, entries: [], truncated: false, availability };

  const root = getRoot(String(rootIdValue));
  const path = cleanRelativePath(pathValue);
  const directory = resolveInsideRoot(root, path);
  let directoryStats: ReturnType<typeof statSync>;
  try {
    directoryStats = statSync(directory);
  } catch {
    throw createError({ statusCode: 404, statusMessage: "目录不存在" });
  }
  if (!directoryStats.isDirectory()) throw createError({ statusCode: 400, statusMessage: "所选路径不是目录" });

  const entries: LocalImportEntry[] = [];
  let truncated = false;
  let children: Dirent<string>[];
  try {
    children = readdirSync(directory, { withFileTypes: true });
  } catch {
    throw createError({ statusCode: 403, statusMessage: unreadableDirectoryMessage() });
  }
  for (const item of children) {
    if (item.name.startsWith(".")) continue;
    const itemPath = path ? `${path}/${item.name}` : item.name;
    try {
      const actual = resolveInsideRoot(root, itemPath);
      const stats = statSync(actual);
      const type = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
      if (!type || (type === "file" && !supportedName.test(item.name))) continue;
      if (entries.length >= maxDirectoryEntries) {
        truncated = true;
        break;
      }
      entries.push({
        name: item.name,
        path: itemPath,
        type,
        size: type === "file" ? stats.size : null,
        modifiedAt: stats.mtime.toISOString()
      });
    } catch {
      // Ignore broken links, unreadable children and links that leave the authorized root.
    }
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
  return { roots, current: { rootId: root.id, path }, entries, truncated, availability };
}

export function importLocalFiles(
  user: RequestUser,
  memberId: string,
  files: Array<{ rootId?: unknown; path?: unknown; rotation?: unknown }>
) {
  if (!Array.isArray(files)) throw createError({ statusCode: 400, statusMessage: "请选择要导入的文件" });
  if (!files.length) throw createError({ statusCode: 400, statusMessage: "请选择至少一个报告文件" });
  if (files.length > 24) throw createError({ statusCode: 413, statusMessage: "一次最多导入 24 个文件" });
  const seen = new Set<string>();
  const resolved = files.map((file) => {
    const root = getRoot(String(file.rootId || ""));
    const path = cleanRelativePath(file.path);
    if (!path) throw createError({ statusCode: 400, statusMessage: "不能将目录作为报告导入" });
    const key = `${root.id}:${path}`;
    if (seen.has(key)) throw createError({ statusCode: 400, statusMessage: "不能重复导入同一个文件" });
    seen.add(key);
    const sourcePath = resolveInsideRoot(root, path);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(sourcePath);
    } catch {
      throw createError({ statusCode: 404, statusMessage: `文件“${basename(path)}”不存在` });
    }
    if (!stats.isFile()) throw createError({ statusCode: 400, statusMessage: `“${basename(path)}”不是普通文件` });
    return {
      originalName: basename(path),
      sourcePath,
      rotation: Number(file.rotation || 0)
    };
  });
  return createUploadFromLocalFiles(user, memberId, resolved);
}
