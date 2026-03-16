#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/perfetto-ui"
BASE_URL="https://ui.perfetto.dev"
CHANNEL="stable"
VERSION=""

usage() {
  cat <<'EOF'
Usage: fetch-perfetto-ui.sh [options]

Options:
  --out DIR         Output directory, default: ./perfetto-ui
  --base-url URL    Perfetto UI base URL, default: https://ui.perfetto.dev
  --channel NAME    Channel to resolve from the root index, default: stable
  --version VALUE   Explicit version, for example: v53.0-e87365eda
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_DIR="$2"
      shift 2
      ;;
    --base-url)
      BASE_URL="${2%/}"
      shift 2
      ;;
    --channel)
      CHANNEL="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
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

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/perfetto-ui-fetch.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

export PERFETTO_UI_FETCH_OUT_DIR="$OUT_DIR"
export PERFETTO_UI_FETCH_BASE_URL="$BASE_URL"
export PERFETTO_UI_FETCH_CHANNEL="$CHANNEL"
export PERFETTO_UI_FETCH_VERSION="$VERSION"
export PERFETTO_UI_FETCH_TMP_DIR="$TMP_DIR"

python3 - <<'PY'
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen


def fetch_bytes(url: str) -> bytes:
  with urlopen(url) as response:
    return response.read()


base_url = os.environ["PERFETTO_UI_FETCH_BASE_URL"].rstrip("/")
channel = os.environ["PERFETTO_UI_FETCH_CHANNEL"]
requested_version = os.environ["PERFETTO_UI_FETCH_VERSION"].strip()
out_dir = Path(os.environ["PERFETTO_UI_FETCH_OUT_DIR"]).resolve()
tmp_dir = Path(os.environ["PERFETTO_UI_FETCH_TMP_DIR"]).resolve() / "perfetto-ui"

index_text = fetch_bytes(f"{base_url}/").decode()
match = re.search(r"data-perfetto_version='([^']+)'", index_text)
if not match:
  raise SystemExit("Failed to locate the Perfetto version map in index.html")

version_map = json.loads(match.group(1))
version = requested_version or version_map.get(channel)
if not version:
  raise SystemExit(f"Failed to resolve channel {channel!r} from {base_url}")

if tmp_dir.exists():
  shutil.rmtree(tmp_dir)
tmp_dir.mkdir(parents=True)

patched_index = index_text.replace(
  match.group(0),
  "data-perfetto_version='" + json.dumps({"stable": version}) + "'",
)
(tmp_dir / "index.html").write_text(patched_index)
(tmp_dir / "VERSION").write_text(version + "\n")

license_tag = version.split("-", 1)[0]
license_url = f"https://raw.githubusercontent.com/google/perfetto/{license_tag}/LICENSE"
try:
  (tmp_dir / "LICENSE").write_bytes(fetch_bytes(license_url))
except HTTPError:
  pass

for root_file in ("service_worker.js", "service_worker.js.map"):
  try:
    (tmp_dir / root_file).write_bytes(fetch_bytes(f"{base_url}/{root_file}"))
  except HTTPError as exc:
    if exc.code != 404:
      raise

manifest = json.loads(fetch_bytes(f"{base_url}/{version}/manifest.json").decode())
resources = manifest.get("resources")
if not isinstance(resources, dict):
  raise SystemExit("Invalid manifest.json: missing resources")

version_dir = tmp_dir / version
version_dir.mkdir(parents=True)
(version_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

for resource in resources:
  target = version_dir / resource
  target.parent.mkdir(parents=True, exist_ok=True)
  target.write_bytes(fetch_bytes(f"{base_url}/{version}/{resource}"))

if out_dir.exists():
  shutil.rmtree(out_dir)
shutil.move(str(tmp_dir), str(out_dir))

total_bytes = sum(path.stat().st_size for path in out_dir.rglob("*") if path.is_file())
print(f"Fetched Perfetto UI {version} into {out_dir}")
print(f"Resources: {len(resources)}")
print(f"Size: {total_bytes} bytes")
PY
