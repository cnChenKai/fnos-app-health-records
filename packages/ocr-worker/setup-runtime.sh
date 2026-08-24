#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
DATA_DIR="${STORAGE_DIR:-.data}"
VENV_DIR="${OCR_VENV_DIR:-${DATA_DIR}/ocr-venv}"
READY_MARKER="${VENV_DIR}/.health-records-ocr-ready"
PYTHON_BIN="${PYTHON_BIN:-}"
FORCE_REINSTALL="${OCR_FORCE_REINSTALL:-0}"
PRIVATE_PYTHON_DIR="${OCR_PRIVATE_PYTHON_DIR:-${DATA_DIR}/runtime/python-3.11}"
PRIVATE_PYTHON_BIN="${OCR_PRIVATE_PYTHON_BIN:-}"
PRIVATE_PYTHON_ARCHIVE="${OCR_PRIVATE_PYTHON_ARCHIVE:-}"
PRIVATE_PYTHON_URL="${OCR_PRIVATE_PYTHON_URL:-}"
SELECTED_PYTHON_BIN=""
INSTALLED_PRIVATE_PYTHON_BIN=""

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'OCR 安装失败：%s\n' "$*" >&2
  exit 1
}

log_section() {
  printf '\n== %s ==\n' "$*"
}

python_executable() {
  if [ -n "$1" ] && [ -x "$1" ]; then
    printf '%s\n' "$1"
    return 0
  fi
  if [ -n "$1" ] && command -v "$1" >/dev/null 2>&1; then
    command -v "$1"
    return 0
  fi
  return 1
}

python_version_minor() {
  "$1" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null
}

python_is_supported() {
  "$1" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if (3, 9) <= sys.version_info[:2] < (3, 13) else 1)
PY
}

python_is_openvino_preferred() {
  "$1" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if (3, 9) <= sys.version_info[:2] < (3, 12) else 1)
PY
}

python_has_required_stdlib() {
  "$1" - <<'PY' >/dev/null 2>&1
import ensurepip
import ssl
import venv
PY
}

find_existing_private_python() {
  if [ -n "${PRIVATE_PYTHON_BIN}" ]; then
    python_executable "${PRIVATE_PYTHON_BIN}" && return 0
  fi
  if [ -d "${PRIVATE_PYTHON_DIR}" ]; then
    found="$(find "${PRIVATE_PYTHON_DIR}" -type f \( -name python3.11 -o -name python3 -o -name python \) -path '*/bin/*' 2>/dev/null | head -n 1 || true)"
    if [ -n "${found}" ]; then
      python_executable "${found}" && return 0
    fi
  fi
  return 1
}

download_private_python_archive() {
  target="$1"
  [ -n "${PRIVATE_PYTHON_URL}" ] || return 1
  if command -v curl >/dev/null 2>&1; then
    curl -fL --connect-timeout 20 --retry 2 -o "${target}" "${PRIVATE_PYTHON_URL}"
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -O "${target}" "${PRIVATE_PYTHON_URL}"
    return $?
  fi
  return 1
}

install_private_python() {
  os_key="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)"
  arch_key="$(uname -m 2>/dev/null || printf unknown)"
  case "${arch_key}" in
    amd64) arch_key="x86_64" ;;
    arm64) arch_key="aarch64" ;;
  esac
  bundled_archive="${SCRIPT_DIR}/python-runtimes/python-3.11-${os_key}-${arch_key}.tar.gz"
  archive="${PRIVATE_PYTHON_ARCHIVE}"
  if [ -z "${archive}" ] && [ -f "${bundled_archive}" ]; then
    archive="${bundled_archive}"
  fi
  if [ -z "${archive}" ] || [ ! -f "${archive}" ]; then
    if [ -n "${PRIVATE_PYTHON_URL}" ]; then
      mkdir -p "${DATA_DIR}/runtime" || return 1
      archive="${DATA_DIR}/runtime/python-3.11-${os_key}-${arch_key}.tar.gz"
      log "未发现包内私有 Python，开始下载应用私有 Python 3.11：${PRIVATE_PYTHON_URL}"
      download_private_python_archive "${archive}" || {
        log "应用私有 Python 下载失败，将继续尝试系统 Python 兜底。"
        return 1
      }
    else
      log "未发现可用的应用私有 Python 安装包；如需启用，可提供 ${bundled_archive} 或设置 OCR_PRIVATE_PYTHON_URL/OCR_PRIVATE_PYTHON_ARCHIVE。"
      return 1
    fi
  fi

  install_dir="${PRIVATE_PYTHON_DIR}.installing.$$"
  rm -rf "${install_dir}" 2>/dev/null || true
  mkdir -p "${install_dir}" || return 1
  log "安装应用私有 Python 3.11 到：${PRIVATE_PYTHON_DIR}"
  tar -xzf "${archive}" -C "${install_dir}" || {
    rm -rf "${install_dir}" 2>/dev/null || true
    return 1
  }
  found="$(find "${install_dir}" -type f \( -name python3.11 -o -name python3 -o -name python \) -path '*/bin/*' 2>/dev/null | head -n 1 || true)"
  if [ -z "${found}" ]; then
    rm -rf "${install_dir}" 2>/dev/null || true
    log "应用私有 Python 安装包中未找到 bin/python。"
    return 1
  fi
  if ! python_is_openvino_preferred "${found}" || ! python_has_required_stdlib "${found}"; then
    rm -rf "${install_dir}" 2>/dev/null || true
    log "应用私有 Python 未通过版本或标准库验证。"
    return 1
  fi
  rm -rf "${PRIVATE_PYTHON_DIR}" 2>/dev/null || true
  mv "${install_dir}" "${PRIVATE_PYTHON_DIR}" || return 1
  INSTALLED_PRIVATE_PYTHON_BIN="$(find_existing_private_python || true)"
  [ -n "${INSTALLED_PRIVATE_PYTHON_BIN}" ]
}

select_python() {
  if [ -n "${PYTHON_BIN}" ]; then
    SELECTED_PYTHON_BIN="$(python_executable "${PYTHON_BIN}" || true)"
    [ -n "${SELECTED_PYTHON_BIN}" ] && return 0
    return 1
  fi

  private_candidate="$(find_existing_private_python || true)"
  if [ -n "${private_candidate}" ] && python_is_openvino_preferred "${private_candidate}" && python_has_required_stdlib "${private_candidate}"; then
    log "检测到应用私有 Python，将优先使用：${private_candidate}"
    SELECTED_PYTHON_BIN="${private_candidate}"
    return 0
  fi

  for candidate in python3.11 python3.10 python3.9 python3 python; do
    executable="$(python_executable "${candidate}" || true)"
    [ -n "${executable}" ] || continue
    if python_is_openvino_preferred "${executable}" && python_has_required_stdlib "${executable}"; then
      log "检测到系统 Python ${candidate} 可支持 OpenVINO 优先后端。"
      SELECTED_PYTHON_BIN="${executable}"
      return 0
    fi
  done

  if install_private_python; then
    log "已安装并启用应用私有 Python：${INSTALLED_PRIVATE_PYTHON_BIN}"
    SELECTED_PYTHON_BIN="${INSTALLED_PRIVATE_PYTHON_BIN}"
    return 0
  fi

  for candidate in python3.12 python3 python; do
    executable="$(python_executable "${candidate}" || true)"
    [ -n "${executable}" ] || continue
    if python_is_supported "${executable}" && python_has_required_stdlib "${executable}"; then
      log "未找到 Python 3.9–3.11 或应用私有 Python，回退使用系统 ${candidate}，后续将使用 ONNXRuntime 兼容后端。"
      SELECTED_PYTHON_BIN="${executable}"
      return 0
    fi
  done

  return 1
}

log_section "OCR 安装环境检测"
log "安装脚本：${SCRIPT_DIR}/setup-runtime.sh"
log "数据目录：${DATA_DIR}"
log "虚拟环境：${VENV_DIR}"
log "就绪标记：${READY_MARKER}"
log "强制重装：${FORCE_REINSTALL}"
log "系统信息：$(uname -a 2>/dev/null || printf 'unknown')"
log "CPU 架构：$(uname -m 2>/dev/null || printf 'unknown')"
if [ "$(uname -s 2>/dev/null || printf unknown)" = "Darwin" ]; then
  log "提示：当前是 macOS 开发环境。fnOS OCR 验收应以 Linux 真机为准；macOS arm64 的 OpenVINO wheel 可能存在动态库加载兼容问题。"
fi
mkdir -p "${DATA_DIR}" || fail "无法创建数据目录：${DATA_DIR}"
[ -w "${DATA_DIR}" ] || fail "数据目录不可写：${DATA_DIR}"
if command -v df >/dev/null 2>&1; then
  log "磁盘空间：$(df -Pk "${DATA_DIR}" 2>/dev/null | tail -n 1 || printf 'unknown')"
fi

select_python || true
PYTHON_BIN="${SELECTED_PYTHON_BIN}"

[ -n "${PYTHON_BIN}" ] || fail "未找到 Python。RapidOCR/OpenVINO 运行环境需要 Python 3.9–3.12，请先在设备上安装可用的 Python 运行时。"
python_executable "${PYTHON_BIN}" >/dev/null 2>&1 || fail "指定的 Python 不存在：${PYTHON_BIN}"

log "使用 Python：$("${PYTHON_BIN}" -c 'import sys; print(sys.executable)')"
log "Python 版本：$("${PYTHON_BIN}" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
log "Python 平台：$("${PYTHON_BIN}" -c 'import platform; print(platform.platform() + " / " + platform.machine())')"
PYTHON_MINOR="$("${PYTHON_BIN}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"

"${PYTHON_BIN}" - <<'PY' || fail "当前 Python 版本不受支持。RapidOCR/OpenVINO 建议使用 Python 3.9–3.12。"
import sys
if sys.version_info < (3, 9) or sys.version_info >= (3, 13):
    raise SystemExit(1)
PY

"${PYTHON_BIN}" - <<'PY' || fail "Python 标准库缺少 venv/ensurepip/ssl。请安装完整 Python 运行时后重试。"
import ensurepip
import ssl
import venv
PY

log_section "准备虚拟环境"
if [ -d "${VENV_DIR}" ]; then
  if [ "${FORCE_REINSTALL}" = "1" ] || [ ! -f "${READY_MARKER}" ]; then
    BACKUP_VENV_DIR="${VENV_DIR}.broken.$(date -u +"%Y%m%d%H%M%S")"
    log "检测到已有 OCR 环境但未通过就绪验证，将移到备份目录：${BACKUP_VENV_DIR}"
    mv "${VENV_DIR}" "${BACKUP_VENV_DIR}" || fail "无法移动旧 OCR 虚拟环境：${VENV_DIR}"
  else
    log "检测到已有 OCR 环境和就绪标记，将复用并重新验证。若需完整重装，可设置 OCR_FORCE_REINSTALL=1。"
  fi
fi

rm -f "${READY_MARKER}" 2>/dev/null || true
log "创建 OCR 虚拟环境：${VENV_DIR}"
"${PYTHON_BIN}" -m venv "${VENV_DIR}" || fail "创建 Python 虚拟环境失败。请确认 Python 安装包含 venv 模块，并且数据目录可写：${VENV_DIR}"

PIP_TIMEOUT="${PIP_DEFAULT_TIMEOUT:-120}"
export PIP_DEFAULT_TIMEOUT="${PIP_TIMEOUT}"
export PIP_DISABLE_PIP_VERSION_CHECK="${PIP_DISABLE_PIP_VERSION_CHECK:-1}"
PIP_CACHE_DIR="${PIP_CACHE_DIR:-${DATA_DIR}/pip-cache}"
mkdir -p "${PIP_CACHE_DIR}" || fail "无法创建 pip 缓存目录：${PIP_CACHE_DIR}"
export PIP_CACHE_DIR

log "虚拟环境 Python：$("${VENV_DIR}/bin/python" -c 'import sys; print(sys.executable)')"
log "pip 版本：$("${VENV_DIR}/bin/python" -m pip --version 2>/dev/null || printf 'pip unavailable')"
if [ -n "${PIP_INDEX_URL:-}" ]; then
  log "PIP_INDEX_URL：${PIP_INDEX_URL}"
fi
if [ -n "${PIP_EXTRA_INDEX_URL:-}" ]; then
  log "PIP_EXTRA_INDEX_URL：${PIP_EXTRA_INDEX_URL}"
fi
log "pip 超时：${PIP_DEFAULT_TIMEOUT}s"
log "pip 缓存目录：${PIP_CACHE_DIR}"

log_section "安装 Python 依赖"
PIP_NEEDS_UPGRADE="$("${VENV_DIR}/bin/python" - <<'PY'
try:
    import pip
    parts = tuple(int(part) for part in pip.__version__.split(".")[:2])
    print("1" if parts < (23, 0) else "0")
except Exception:
    print("1")
PY
)"
if [ "${OCR_UPGRADE_PIP:-0}" = "1" ] || [ "${PIP_NEEDS_UPGRADE}" = "1" ]; then
  log "升级 pip"
  "${VENV_DIR}/bin/python" -m pip install --upgrade pip || fail "升级 pip 失败。请检查网络访问 PyPI 是否正常，或通过 PIP_INDEX_URL 配置可用镜像。"
else
  log "pip 版本已满足安装要求，跳过升级。如需强制升级可设置 OCR_UPGRADE_PIP=1。"
fi

install_onnxruntime_backend() {
  log "安装 OCR 备用依赖：rapidocr-onnxruntime / PyMuPDF / Pillow"
  log "提示：ONNXRuntime 首次安装需要下载 rapidocr、onnxruntime、opencv、numpy、PyMuPDF、Pillow 等多个 wheel；低速网络可能需要 10–30 分钟，日志会持续显示安装心跳。"
  "${VENV_DIR}/bin/python" -m pip install \
    "PyMuPDF>=1.24,<2" \
    "Pillow>=10,<12" \
    "pillow-heif>=0.16,<1" \
    "rapidocr-onnxruntime==1.4.4" \
    || fail "安装 ONNXRuntime 备用 OCR 后端失败。请检查 PyPI 网络、Python 版本和 CPU 架构 wheel 支持。"
}

PREFER_ONNXRUNTIME=0
MACHINE_KEY="$(uname -m 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)"
if [ "${PYTHON_MINOR}" = "3.12" ]; then
  PREFER_ONNXRUNTIME=1
  log "检测到 Python 3.12：当前 OpenVINO 依赖锁定版本不提供兼容 wheel，将直接使用 ONNXRuntime 备用后端。"
elif [ "${MACHINE_KEY}" = "aarch64" ] || [ "${MACHINE_KEY}" = "arm64" ]; then
  PREFER_ONNXRUNTIME=1
  log "检测到 ARM64 架构：为避免 OpenVINO 重复推理的内存问题，直接使用 ONNXRuntime 后端。"
fi

if [ "${PREFER_ONNXRUNTIME}" = "1" ]; then
  install_onnxruntime_backend
else
  log "安装 OCR 主依赖：rapidocr-openvino / openvino / PyMuPDF / Pillow"
  if ! "${VENV_DIR}/bin/python" -m pip install -r "${SCRIPT_DIR}/requirements.txt"; then
    log "OpenVINO 主依赖安装失败，将自动切换到 ONNXRuntime 备用后端。常见原因：CPU 架构或 Python 版本没有对应 wheel。"
    install_onnxruntime_backend
    PREFER_ONNXRUNTIME=1
  fi
fi

log_section "OCR 引擎与识别验证"
log "执行 OCR Worker 自检：导入依赖、加载 OCR 后端、生成测试图片并识别 OCR TEST 2026"
CHECK_RESULT_JSON=""
if [ "${PREFER_ONNXRUNTIME}" = "1" ]; then
  CHECK_COMMAND_ENV="onnxruntime"
else
  CHECK_COMMAND_ENV="auto"
fi
if CHECK_RESULT_JSON="$(OCR_BACKEND="${CHECK_COMMAND_ENV}" "${VENV_DIR}/bin/python" "${SCRIPT_DIR}/worker.py" --check 2>&1)"; then
  log "${CHECK_RESULT_JSON}"
  VERIFIED_BACKEND="$(
    CHECK_RESULT_JSON="${CHECK_RESULT_JSON}" "${VENV_DIR}/bin/python" - <<'PY'
import json
import os
try:
    payload = {}
    for line in reversed(os.environ.get("CHECK_RESULT_JSON", "").splitlines()):
        try:
            candidate = json.loads(line.strip())
        except Exception:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    print(payload.get("engine") or "auto")
except Exception:
    print("auto")
PY
  )"
else
  log "${CHECK_RESULT_JSON}"
  log "默认 OCR 后端自检失败，开始安装 ONNXRuntime 备用后端"
  install_onnxruntime_backend
  log "使用 ONNXRuntime 备用后端重新执行 OCR 自检"
  CHECK_RESULT_JSON="$(OCR_BACKEND=onnxruntime "${VENV_DIR}/bin/python" "${SCRIPT_DIR}/worker.py" --check 2>&1)" || fail "OCR Worker 自检失败。OpenVINO 与 ONNXRuntime 后端都不可用，请查看上方日志确认架构、Python wheel 或系统依赖问题。${CHECK_RESULT_JSON}"
  log "${CHECK_RESULT_JSON}"
  VERIFIED_BACKEND="rapidocr-onnxruntime"
fi

CHECK_RESULT_JSON="${CHECK_RESULT_JSON}" \
VERIFIED_BACKEND="${VERIFIED_BACKEND}" \
READY_MARKER="${READY_MARKER}" \
"${VENV_DIR}/bin/python" - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import sys

try:
    check = {}
    for line in reversed(os.environ.get("CHECK_RESULT_JSON", "").splitlines()):
        try:
            candidate = json.loads(line.strip())
        except Exception:
            continue
        if isinstance(candidate, dict):
            check = candidate
            break
except Exception:
    check = {}

marker = {
    "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "python": sys.executable,
    "pythonVersion": sys.version.split()[0],
    "backend": os.environ.get("VERIFIED_BACKEND") or check.get("engine") or "auto",
    "engine": check.get("engine"),
    "modelVersion": check.get("modelVersion"),
    "rapidocrVersion": check.get("rapidocrVersion"),
    "pymupdfVersion": check.get("pymupdfVersion"),
    "pillowVersion": check.get("pillowVersion"),
    "pillowHeifVersion": check.get("pillowHeifVersion"),
    "platform": check.get("platform"),
    "machine": check.get("machine"),
}
Path(os.environ["READY_MARKER"]).write_text(json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

printf 'OCR runtime installed at %s\n' "${VENV_DIR}"
