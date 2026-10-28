#!/usr/bin/env bash
# Spec V1 fixture: fresh Capacitor app + this repo's packed packages, `npx cap add <platform>`, native build.
# Usage: scripts/fixture-build.sh android|ios [workdir]
set -euo pipefail

platform="$1"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="${2:-$(mktemp -d)}"
cap_version="^8.0.0"

case "$platform" in
  android|ios) ;;
  *) echo "usage: $0 android|ios [workdir]" >&2; exit 2 ;;
esac

(cd "$root" && pnpm build)

rm -rf "$work/fixture" && mkdir -p "$work/fixture/www" "$work/tarballs"
# pnpm pack rewrites workspace:* to real versions; installing both tarballs together satisfies the core dep.
(cd "$root/packages/core" && pnpm pack --pack-destination "$work/tarballs" >/dev/null)
(cd "$root/packages/capacitor" && pnpm pack --pack-destination "$work/tarballs" >/dev/null)

cd "$work/fixture"
echo '<!doctype html><html><body>fixture</body></html>' > www/index.html
cat > package.json <<'EOF'
{ "name": "edge-rum-fixture", "version": "0.0.0", "private": true }
EOF
cat > capacitor.config.json <<'EOF'
{ "appId": "com.nathanclaire.rum.fixture", "appName": "Fixture", "webDir": "www" }
EOF
npm install --no-audit --no-fund \
  "@capacitor/core@$cap_version" "@capacitor/cli@$cap_version" "@capacitor/$platform@$cap_version" \
  "@capacitor/app@$cap_version" "@capacitor/device@$cap_version" "@capacitor/network@$cap_version" \
  "$work"/tarballs/*.tgz

npx cap add "$platform"
npx cap sync "$platform"

if [ "$platform" = ios ]; then
  # K2: the native class must declare the JS-facing name `EdgeRum`.
  grep -rq 'jsName = "EdgeRum"' node_modules/@nathanclaire/rum-capacitor/ios/Plugin
  (cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    CODE_SIGNING_ALLOWED=NO build)
else
  grep -q 'com.nathanclaire.rum' android/app/src/main/assets/capacitor.plugins.json
  grep -rq '@CapacitorPlugin(name = "EdgeRum")' node_modules/@nathanclaire/rum-capacitor/android/src
  (cd android && ./gradlew --no-daemon assembleDebug)
fi

echo "[fixture] $platform OK ($work/fixture)"
