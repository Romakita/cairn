#!/bin/zsh
# Construit Cairn.app (bun run dist), l'installe dans ~/Applications et y relie la commande `cairn`.
# L'app installée est d'abord quittée si elle tourne. L'ancienne app est remplacée (même emplacement : macOS garde
# l'entrée dans Réglages, mais la signature ad hoc change à chaque build, il faut parfois ré-accorder l'Accès complet
# au disque).
set -euo pipefail
cd "${0:A:h:h}"
APP="$HOME/Applications/Cairn.app"

bun install --frozen-lockfile >/dev/null
bun run dist
BUILT="release/mac-arm64/Cairn.app"
[[ -d "$BUILT" ]] || { echo "$BUILT introuvable" >&2; exit 1; }

# Quitter l'app installée si elle tourne (demande polie, comme Cairn → Quitter).
if pgrep -f "$APP/Contents/MacOS/Cairn" >/dev/null; then
  osascript -e 'tell application id "fr.lenzotti.cairn" to quit' >/dev/null 2>&1 || true
  for _ in {1..20}; do pgrep -f "$APP/Contents/MacOS/Cairn" >/dev/null || break; sleep 0.5; done
fi

mkdir -p "$HOME/Applications"
rm -rf "$APP"
ditto "$BUILT" "$APP"
echo "✔ installé dans ~/Applications/Cairn.app ($(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist"))"

mkdir -p "$HOME/.local/bin"
ln -sf "$APP/Contents/MacOS/Cairn" "$HOME/.local/bin/cairn"
echo "✔ commande cairn : ~/.local/bin/cairn"
