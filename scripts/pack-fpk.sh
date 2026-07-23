#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="${ROOT_DIR}/.fnos-build/package"
DIST_DIR="${ROOT_DIR}/dist"

FNPACK_BIN="${ROOT_DIR}/tools/fnpack"

if [ ! -x "${FNPACK_BIN}" ]; then
  if command -v fnpack >/dev/null 2>&1; then
    FNPACK_BIN="$(command -v fnpack)"
  else
    echo "fnpack is not installed."
    echo "You can place a local binary at tools/fnpack, then rerun: npm run pack:fpk"
    exit 1
  fi
fi

mkdir -p "${DIST_DIR}"
APP_NAME="$(awk -F= '$1 == "appname" { print $2 }' "${PACKAGE_DIR}/manifest")"
ROOT_FPK="${ROOT_DIR}/${APP_NAME}.fpk"
rm -f "${ROOT_FPK}"
(
  cd "${ROOT_DIR}"
  "${FNPACK_BIN}" build --directory "${PACKAGE_DIR}"
)
if [ ! -f "${ROOT_FPK}" ]; then
  echo "fnpack did not produce ${APP_NAME}.fpk" >&2
  exit 1
fi
find "${ROOT_DIR}" -maxdepth 1 -name '*.fpk' -exec mv {} "${DIST_DIR}/" \;

echo "Generated fpk files in ${DIST_DIR}"
