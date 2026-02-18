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
  echo "==> Using pre-compiled server binary: $MYWEBTERM_BIN"
  cp "$MYWEBTERM_BIN" "$MACOS_DIR/mywebterm"
else
  echo "==> Compiling server binary..."
  bun build --compile "$ROOT_DIR/src/index.ts" --outfile "$MACOS_DIR/mywebterm" \
    --define "BUILD_VERSION='\"$VERSION\"'"
fi

chmod +x "$MACOS_DIR/MyWebTermTray" "$MACOS_DIR/mywebterm"

# 3. Write Info.plist
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
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST

echo "==> Built $APP_DIR (version: $VERSION)"
