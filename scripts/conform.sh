#!/usr/bin/env bash
# Conformance gate (#159, spec 2026-11-23 stable goldens): runs the golden tests, which dump raw batches
# to the gitignored test/golden-raw/{js,android,ios}, then checks them against the event catalogue at
# the tag pinned in catalogue.version and their derived shapes against test/shape-{js,android,ios}.txt.
# Pass -update to rewrite the shape files. Needs node/pnpm, gradle, swift, go and git.
# PROCESSOR_DIR reuses a local processor checkout. Not in CI: run before a release.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tag="$(cat "$root/catalogue.version")"
raw="$root/test/golden-raw"
rm -rf "$raw"
# The script runs the tests itself: the JS set needs vitest before gradle (JsGoldenTest sends its rows
# through the native sender), and a fresh raw dir keeps a removed event from passing on a stale dump.
(cd "$root" && pnpm vitest run test/golden-batch.test.ts && pnpm test:android && pnpm test:ios)
src="${PROCESSOR_DIR:-}"
if [ -z "$src" ]; then
  src="$(mktemp -d)"
  trap 'rm -rf "$src"' EXIT
  git clone -q --depth 1 --branch "$tag" https://github.com/NCG-Africa/edge_telemetry_processor_go.git "$src"
fi
cd "$src" && go run ./cmd/conform "$@" \
  "$raw/js" "$root/test/shape-js.txt" \
  "$raw/android" "$root/test/shape-android.txt" \
  "$raw/ios" "$root/test/shape-ios.txt"
