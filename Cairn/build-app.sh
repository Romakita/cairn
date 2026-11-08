#!/bin/zsh
# Construit « Cairn.app », l'installe dans ~/Applications et y relie la commande `cairn`.
# Usage : ./build-app.sh [--no-install]
set -euo pipefail
cd "${0:A:h}"

APP_NAME="Cairn"
BUNDLE="build/$APP_NAME.app"

swift build -c release --product Cairn
BIN="$(swift build -c release --show-bin-path)"

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp "$BIN/Cairn" "$BUNDLE/Contents/MacOS/Cairn"
# Bundle de ressources SwiftPM (catalogues en/fr) : Bundle.module le cherche dans Contents/Resources.
cp -R "$BIN/Cairn_CairnCore.bundle" "$BUNDLE/Contents/Resources/"

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
  <key>CFBundleIdentifier</key><string>fr.lenzotti.cairn</string>
  <key>CFBundleExecutable</key><string>Cairn</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>fr</string></array>
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
  rm -rf "$HOME/Applications/Workspace Storage.app"   # ancien nom
  rm -rf "$HOME/Applications/$APP_NAME.app"
  cp -R "$BUNDLE" "$HOME/Applications/"
  echo "✔ installé dans ~/Applications/$APP_NAME.app"
  # Commande `cairn` (même binaire, mode ligne de commande).
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/Applications/$APP_NAME.app/Contents/MacOS/Cairn" "$HOME/.local/bin/cairn"
  echo "✔ commande cairn : ~/.local/bin/cairn"
fi
