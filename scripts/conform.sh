#!/usr/bin/env bash
# Conformance gate (#149, processor #40): check every golden batch (JS in test/golden, native in the
# Android and iOS core tests) against the event catalogue at the ref pinned in catalogue.version.
# Needs go and git. PROCESSOR_DIR reuses a local processor checkout. Not in CI: run before a release.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ref="$(cat "$root/catalogue.version")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
goldens="$work/golden"
mkdir -p "$goldens"
# One directory: cmd/conform checks emitted_by across all of one SDK's goldens together.
for f in "$root"/test/golden/*.json; do cp "$f" "$goldens/js-$(basename "$f")"; done
for f in "$root"/packages/capacitor/android/src/test/resources/golden/*.json; do cp "$f" "$goldens/android-$(basename "$f")"; done
for f in "$root"/packages/capacitor/ios/core-test/Tests/golden/*.json; do cp "$f" "$goldens/ios-$(basename "$f")"; done
src="${PROCESSOR_DIR:-}"
if [ -z "$src" ]; then
  src="$work/processor"
  git clone -q --depth 1 --branch "$ref" https://github.com/NCG-Africa/edge_telemetry_processor_go.git "$src"
fi
cd "$src" && go run ./cmd/conform "$goldens"
