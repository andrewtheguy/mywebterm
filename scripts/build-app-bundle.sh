#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="${VERSION:-dev}"
APP_DIR="$ROOT_DIR/dist/MyWebTerm.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

# Clean previous build
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

# 1. Build the Swift tray binary
echo "==> Compiling tray binary..."
swiftc -framework Cocoa -O -o "$MACOS_DIR/MyWebTermTray" "$ROOT_DIR/src/tray/tray.swift"

# 2. Copy or compile the server binary
if [ -n "${MYWEBTERM_BIN:-}" ]; then
  if [ ! -f "$MYWEBTERM_BIN" ]; then
    echo "Error: MYWEBTERM_BIN does not exist: $MYWEBTERM_BIN" >&2
    exit 1
  fi
  echo "==> Using pre-compiled server binary: $MYWEBTERM_BIN"
  cp "$MYWEBTERM_BIN" "$MACOS_DIR/mywebterm"
else
  echo "==> Compiling server binary..."
  bun build --compile "$ROOT_DIR/src/index.ts" --outfile "$MACOS_DIR/mywebterm" \
    --define "BUILD_VERSION='\"$VERSION\"'"
fi

chmod +x "$MACOS_DIR/MyWebTermTray" "$MACOS_DIR/mywebterm"

# 3. Generate app icon from pre-rendered PNG
RESOURCES_DIR="$CONTENTS_DIR/Resources"
mkdir -p "$RESOURCES_DIR"
LOGO_PNG="$ROOT_DIR/src/logo-1024.png"
ICONSET_DIR=$(mktemp -d)/AppIcon.iconset
mkdir -p "$ICONSET_DIR"

echo "==> Generating app icon..."
sips -z 16 16     "$LOGO_PNG" --out "$ICONSET_DIR/icon_16x16.png"    >/dev/null
sips -z 32 32     "$LOGO_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32     "$LOGO_PNG" --out "$ICONSET_DIR/icon_32x32.png"    >/dev/null
sips -z 64 64     "$LOGO_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128   "$LOGO_PNG" --out "$ICONSET_DIR/icon_128x128.png"    >/dev/null
sips -z 256 256   "$LOGO_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$LOGO_PNG" --out "$ICONSET_DIR/icon_256x256.png"    >/dev/null
sips -z 512 512   "$LOGO_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$LOGO_PNG" --out "$ICONSET_DIR/icon_512x512.png"    >/dev/null
cp "$LOGO_PNG"                      "$ICONSET_DIR/icon_512x512@2x.png"

iconutil -c icns -o "$RESOURCES_DIR/AppIcon.icns" "$ICONSET_DIR"
rm -rf "$(dirname "$ICONSET_DIR")"

# 4. Write Info.plist
cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>MyWebTermTray</string>
    <key>CFBundleIdentifier</key>
    <string>com.mywebterm.app</string>
    <key>CFBundleName</key>
    <string>MyWebTerm</string>
    <key>CFBundleDisplayName</key>
    <string>MyWebTerm</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST

echo "==> Built $APP_DIR (version: $VERSION)"
