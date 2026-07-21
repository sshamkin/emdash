#!/usr/bin/env bash
# Build, package, and optionally install a local (ad-hoc signed) mac build of Emdash.
#
# Usage:
#   scripts/package-local.sh            # build + package into release/mac-<arch>/
#   scripts/package-local.sh --install  # ...and replace /Applications/Emdash.app
#
# The plain `package:mac` script cannot resolve electron or the hoisted workspace
# dependencies (node-linker=hoisted), so this mirrors scripts/release/build.ts
# (pnpm deploy dir + electron-builder with an explicit electronVersion) without
# rebuilding for both arches and without publishing anywhere.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

echo "==> Building workspace"
(cd "$ROOT_DIR" && pnpm run build)

echo "==> Creating deployment directory with production dependencies"
DEPLOY_DIR="$(mktemp -d "$ROOT_DIR/.emdash-deploy-local-XXXXXX")"
trap 'rm -rf "$DEPLOY_DIR"' EXIT
(cd "$ROOT_DIR" && pnpm --filter @emdash/emdash-desktop deploy --legacy --prod "$DEPLOY_DIR")

echo "==> Copying built assets"
rm -rf "$DEPLOY_DIR/out" "$DEPLOY_DIR/drizzle"
cp -R "$APP_DIR/out" "$DEPLOY_DIR/out"
cp -R "$APP_DIR/drizzle" "$DEPLOY_DIR/drizzle"

echo "==> Rebuilding native modules for $ARCH"
(cd "$APP_DIR" && node --experimental-strip-types scripts/release/rebuild-native.ts \
  --arch "$ARCH" --deploy-dir "$DEPLOY_DIR")

ELECTRON_VERSION="$(cd "$APP_DIR" && node -p "require('electron/package.json').version")"
echo "==> Packaging with electron-builder (Electron $ELECTRON_VERSION)"
(cd "$APP_DIR" && pnpm exec electron-builder --mac --"$ARCH" --publish never \
  --projectDir "$DEPLOY_DIR" \
  --config "$APP_DIR/electron-builder.config.ts" \
  -c.electronVersion="$ELECTRON_VERSION" \
  -c.npmRebuild=false)

APP_BUNDLE="$DEPLOY_DIR/release/mac-$ARCH/Emdash.app"
codesign --force --deep --sign - "$APP_BUNDLE"

echo "==> Copying artifacts to $APP_DIR/release"
mkdir -p "$APP_DIR/release"
rm -rf "$APP_DIR/release/mac-$ARCH"
cp -R "$DEPLOY_DIR/release/mac-$ARCH" "$APP_DIR/release/mac-$ARCH"
cp "$DEPLOY_DIR/release/emdash-$ARCH.dmg" "$DEPLOY_DIR/release/emdash-$ARCH.zip" \
  "$APP_DIR/release/" 2>/dev/null || true

if [[ "${1:-}" == "--install" ]]; then
  if pgrep -f "/Applications/[Ee]mdash.app/Contents" > /dev/null; then
    echo "Emdash is running — quit it, then re-run with --install" >&2
    echo "(or copy $APP_DIR/release/mac-$ARCH/Emdash.app to /Applications yourself)." >&2
    exit 1
  fi
  echo "==> Installing to /Applications/Emdash.app"
  rm -rf /Applications/Emdash.app /Applications/emdash.app
  cp -R "$APP_DIR/release/mac-$ARCH/Emdash.app" /Applications/Emdash.app
  echo "Installed. Launch with: open -a Emdash"
fi

echo "Done: $APP_DIR/release/mac-$ARCH/Emdash.app"
