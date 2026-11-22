#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/GoogleOnePoolMenu.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

mkdir -p "$MACOS_DIR"

cat > "$CONTENTS_DIR/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>vi</string>
  <key>CFBundleExecutable</key>
  <string>GoogleOnePoolMenu</string>
  <key>CFBundleIdentifier</key>
  <string>local.googleonepool.menubar</string>
  <key>CFBundleName</key>
  <string>Google One Pool</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

swiftc -O -parse-as-library -framework Cocoa \
  "$ROOT_DIR/macos/GoogleOnePoolMenu.swift" \
  -o "$MACOS_DIR/GoogleOnePoolMenu"

chmod +x "$MACOS_DIR/GoogleOnePoolMenu"
echo "Built $APP_DIR"
