#!/usr/bin/env bash
# Spec Q1/Q3: build demo/ (Ionic Angular, provideEdgeRum) for one platform, workspace packages + the demo
# scenarios plugin by local path. Native projects are generated (`npx cap add`), never committed.
# Usage: scripts/demo-build.sh android|ios
# EDGE_RUM_ENDPOINT defaults to mock-ingest at localhost:4319 (simulator: the host; emulator: `adb reverse`);
# on a real phone set it to http://<laptop LAN ip>:4319/collector/telemetry.
set -euo pipefail

platform="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"

case "$platform" in
  android|ios) ;;
  *) echo "usage: $0 android|ios" >&2; exit 2 ;;
esac

(cd "$root" && pnpm build && pnpm --filter edge-rum-demo build)

cd "$root/demo"
rm -rf "$platform"
npx cap add "$platform"

if [ "$platform" = ios ]; then
  plist=ios/App/App/Info.plist
  # Deep links (edgerumdemo://<scenario>) and plain-http ingest to the mock.
  /usr/libexec/PlistBuddy \
    -c 'Add :CFBundleURLTypes array' -c 'Add :CFBundleURLTypes:0 dict' \
    -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string edgerumdemo' \
    -c 'Add :NSAppTransportSecurity dict' -c 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true' \
    "$plist"
  (cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build \
    CODE_SIGNING_ALLOWED=NO build)
else
  (cd android && ./gradlew --no-daemon assembleDebug)
fi
echo "[demo] $platform built"
