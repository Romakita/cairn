#!/bin/zsh
# Construit « Workspace Storage.app » et l'installe dans ~/Applications.
# Usage : ./build-app.sh [--no-install]
set -euo pipefail
cd "${0:A:h}"

APP_NAME="Workspace Storage"
BUNDLE="build/$APP_NAME.app"

swift build -c release
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp .build/release/WorkspaceStorage "$BUNDLE/Contents/MacOS/WorkspaceStorage"

swift scripts/make-icon.swift build
iconutil -c icns build/AppIcon.iconset -o "$BUNDLE/Contents/Resources/AppIcon.icns"
rm -rf build/AppIcon.iconset

cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>fr.lenzotti.workspace-storage</string>
  <key>CFBundleExecutable</key><string>WorkspaceStorage</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleDevelopmentRegion</key><string>fr</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$BUNDLE"
echo "✔ $BUNDLE"

if [[ "${1:-}" != "--no-install" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$APP_NAME.app"
  cp -R "$BUNDLE" "$HOME/Applications/"
  echo "✔ installé dans ~/Applications/$APP_NAME.app"
fi
