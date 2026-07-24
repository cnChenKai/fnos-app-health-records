#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
DATA_DIR="${STORAGE_DIR:-.data}"
VENV_DIR="${OCR_VENV_DIR:-${DATA_DIR}/ocr-venv}"
READY_MARKER="${VENV_DIR}/.health-records-ocr-ready"
PYTHON_BIN="${PYTHON_BIN:-}"
FORCE_REINSTALL="${OCR_FORCE_REINSTALL:-0}"

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

if [ -z "${PYTHON_BIN}" ]; then
  for candidate in python3.12 python3.11 python3.10 python3.9 python3 python; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      PYTHON_BIN="${candidate}"
      break
    fi
  done
fi

[ -n "${PYTHON_BIN}" ] || fail "未找到 Python。RapidOCR/OpenVINO 运行环境需要 Python 3.9–3.12，请先在设备上安装可用的 Python 运行时。"
command -v "${PYTHON_BIN}" >/dev/null 2>&1 || fail "指定的 Python 不存在：${PYTHON_BIN}"

log "使用 Python：$("${PYTHON_BIN}" -c 'import sys; print(sys.executable)')"
log "Python 版本：$("${PYTHON_BIN}" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
log "Python 平台：$("${PYTHON_BIN}" -c 'import platform; print(platform.platform() + " / " + platform.machine())')"

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

log "虚拟环境 Python：$("${VENV_DIR}/bin/python" -c 'import sys; print(sys.executable)')"
log "pip 版本：$("${VENV_DIR}/bin/python" -m pip --version 2>/dev/null || printf 'pip unavailable')"
if [ -n "${PIP_INDEX_URL:-}" ]; then
  log "PIP_INDEX_URL：${PIP_INDEX_URL}"
fi
if [ -n "${PIP_EXTRA_INDEX_URL:-}" ]; then
  log "PIP_EXTRA_INDEX_URL：${PIP_EXTRA_INDEX_URL}"
fi
log "pip 超时：${PIP_DEFAULT_TIMEOUT}s"

log_section "安装 Python 依赖"
log "升级 pip"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip || fail "升级 pip 失败。请检查网络访问 PyPI 是否正常，或通过 PIP_INDEX_URL 配置可用镜像。"

log "安装 OCR 依赖：rapidocr-openvino / openvino / PyMuPDF / Pillow"
"${VENV_DIR}/bin/python" -m pip install -r "${SCRIPT_DIR}/requirements.txt" || fail "安装 OCR Python 依赖失败。常见原因：设备无法访问 PyPI、CPU 架构没有对应 wheel、Python 版本不兼容，或磁盘空间不足。"

log_section "OCR 引擎与识别验证"
log "执行 OCR Worker 自检：导入依赖、加载 OCR 后端、生成测试图片并识别 OCR TEST 2026"
CHECK_RESULT_JSON=""
if CHECK_RESULT_JSON="$("${VENV_DIR}/bin/python" "${SCRIPT_DIR}/worker.py" --check 2>&1)"; then
  log "${CHECK_RESULT_JSON}"
  VERIFIED_BACKEND="$(
    CHECK_RESULT_JSON="${CHECK_RESULT_JSON}" "${VENV_DIR}/bin/python" - <<'PY'
import json
import os
try:
    payload = json.loads(os.environ.get("CHECK_RESULT_JSON", "{}"))
    print(payload.get("engine") or "auto")
except Exception:
    print("auto")
PY
  )"
else
  log "${CHECK_RESULT_JSON}"
  log "默认 OCR 后端自检失败，开始安装 ONNXRuntime 备用后端"
  "${VENV_DIR}/bin/python" -m pip install "rapidocr-onnxruntime==1.4.4" || fail "安装 ONNXRuntime 备用 OCR 后端失败。请检查 PyPI 网络、Python 版本和 CPU 架构 wheel 支持。"
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
    check = json.loads(os.environ.get("CHECK_RESULT_JSON", "{}"))
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
