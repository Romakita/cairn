#!/bin/zsh
# Construit « Cairn.app », l'installe dans ~/Applications et y relie la commande `cairn`.
# Usage : ./build-app.sh [--no-install] [--zip]
#   --no-install  construit seulement build/Cairn.app (CI, release)
#   --zip         produit aussi build/Cairn-<version>-<arch>.zip et son .sha256 (release)
# La version vient de Cairn/VERSION ; CAIRN_BUILD (numéro de build) vaut par défaut le nombre de commits.
set -euo pipefail
cd "${0:A:h}"

APP_NAME="Cairn"
BUNDLE="build/$APP_NAME.app"
VERSION="$(tr -d '[:space:]' < VERSION)"
BUILD="${CAIRN_BUILD:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"
INSTALL=1; ZIP=0
for arg in "$@"; do
  case "$arg" in
    --no-install) INSTALL=0 ;;
    --zip) ZIP=1 ;;
    *) echo "option inconnue : $arg" >&2; exit 2 ;;
  esac
done

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
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>fr</string></array>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$BUNDLE"
echo "✔ $BUNDLE ($VERSION, build $BUILD)"

if (( ZIP )); then
  ARCHIVE="build/$APP_NAME-$VERSION-$(uname -m).zip"
  rm -f "$ARCHIVE"
  ditto -c -k --keepParent "$BUNDLE" "$ARCHIVE"
  (cd build && shasum -a 256 "${ARCHIVE:t}" > "${ARCHIVE:t}.sha256")
  echo "✔ $ARCHIVE"
fi

if (( INSTALL )); then
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
