#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH_FILE="$ROOT_DIR/scripts/perfetto-source-build.patch"
OUT_DIR="$ROOT_DIR/perfetto-ui"
WORK_DIR="$ROOT_DIR/.tmp/perfetto-source"

default_ref() {
  if [[ -f "$ROOT_DIR/perfetto-ui/VERSION" ]]; then
    local current_version
    current_version="$(<"$ROOT_DIR/perfetto-ui/VERSION")"
    printf '%s\n' "${current_version%%-*}"
    return
  fi

  printf '%s\n' "v54.0"
}

REF="$(default_ref)"

usage() {
  cat <<'EOF'
Usage: build-perfetto-ui-from-source.sh [options]

Options:
  --ref REF         Perfetto ref, default: current bundled major tag or v54.0
  --out DIR         Output directory, default: ./perfetto-ui
  --work-dir DIR    Working directory cache, default: ./.tmp/perfetto-source
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      REF="$2"
      shift 2
      ;;
    --out)
      OUT_DIR="$2"
      shift 2
      ;;
    --work-dir)
      WORK_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

SOURCE_DIR="$WORK_DIR/perfetto"

clone_or_update_repo() {
  mkdir -p "$WORK_DIR"

  if [[ ! -d "$SOURCE_DIR/.git" ]]; then
    git clone --filter=blob:none --depth 1 --branch "$REF" https://github.com/google/perfetto.git "$SOURCE_DIR"
    return
  fi

  git -C "$SOURCE_DIR" fetch --depth 1 origin "$REF"
  git -C "$SOURCE_DIR" checkout --force FETCH_HEAD
  git -C "$SOURCE_DIR" reset --hard FETCH_HEAD
}

apply_patch_once() {
  if git -C "$SOURCE_DIR" apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
    return
  fi

  git -C "$SOURCE_DIR" apply "$PATCH_FILE"
}

bootstrap_build_deps() {
  local -a filters=(
    "googletest"
    "protobuf"
    "abseil-cpp"
    "libcxx"
    "libcxxabi"
    "libunwind"
    "benchmark"
    "libbacktrace"
    "sqlite"
    "sqlite_src"
    "expat"
    "llvm-project"
    "android-core"
    "android-unwinding"
    "android-logging"
    "android-libbase"
    "android-libprocinfo"
    "lzma"
    "zstd"
    "bionic"
    "zlib"
    "linenoise"
    "open_csd"
    "third_party/gn"
    "third_party/ninja"
    "nodejs"
    "emsdk"
    "catapult_trace_viewer"
    "typefaces"
    "third_party/pnpm"
  )

  local -a args=("tools/install-build-deps" "--ui" "--no-dev-tools")
  local filter
  for filter in "${filters[@]}"; do
    args+=("--filter" "$filter")
  done

  (
    cd "$SOURCE_DIR"
    PERFETTO_SKIP_TEST_DATA=1 "${args[@]}"
  )
}

build_perfetto_ui() {
  rm -rf "$SOURCE_DIR/out/ui"
  rm -rf "$SOURCE_DIR/ui/out"
  rm -rf "$SOURCE_DIR/ui/src/gen"

  (
    cd "$SOURCE_DIR"
    PERFETTO_SKIP_TEST_DATA=1 ui/build --no-depscheck
  )
}

export PERFETTO_SOURCE_DIR="$SOURCE_DIR"
export PERFETTO_BUNDLED_OUT_DIR="$OUT_DIR"

copy_built_ui() {
  python3 - <<'PY'
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

source_dir = Path(os.environ["PERFETTO_SOURCE_DIR"]).resolve()
out_dir = Path(os.environ["PERFETTO_BUNDLED_OUT_DIR"]).resolve()
dist_dir = (source_dir / "ui" / "out" / "dist").resolve()

if not dist_dir.exists():
  raise SystemExit(f"Missing Perfetto UI dist directory: {dist_dir}")

versions = sorted(path.name for path in dist_dir.iterdir() if path.is_dir() and path.name.startswith("v"))
if not versions:
  raise SystemExit(f"No versioned build found under {dist_dir}")

version = versions[-1]
tmp_dir = source_dir / ".bundled-perfetto-ui"
if tmp_dir.exists():
  shutil.rmtree(tmp_dir)
tmp_dir.mkdir(parents=True)

for root_file in ("index.html", "service_worker.js", "service_worker.js.map"):
  source_file = dist_dir / root_file
  if source_file.exists():
    shutil.copy2(source_file, tmp_dir / root_file)

license_file = source_dir / "LICENSE"
if license_file.exists():
  shutil.copy2(license_file, tmp_dir / "LICENSE")

(tmp_dir / "VERSION").write_text(version + "\n")
shutil.copytree(dist_dir / version, tmp_dir / version)

index_path = tmp_dir / "index.html"
index_text = index_path.read_text()
match = re.search(r"data-perfetto_version='([^']+)'", index_text)
if not match:
  raise SystemExit("Failed to patch the built Perfetto index.html")

patched_index = index_text.replace(
  match.group(0),
  "data-perfetto_version='" + json.dumps({"stable": version}) + "'",
)
index_path.write_text(patched_index)

if out_dir.exists():
  shutil.rmtree(out_dir)
shutil.move(str(tmp_dir), str(out_dir))

total_bytes = sum(path.stat().st_size for path in out_dir.rglob("*") if path.is_file())
print(f"Built Perfetto UI {version} into {out_dir}")
print(f"Size: {total_bytes} bytes")
PY
}

clone_or_update_repo
apply_patch_once
bootstrap_build_deps
build_perfetto_ui
copy_built_ui
