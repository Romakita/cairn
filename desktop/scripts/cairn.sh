#!/bin/zsh
# Lance la commande cairn : celle de ~/Applications/Cairn.app si elle est installée, sinon l'app de développement
# (build de desktop/ puis `electron . <commande>`).
set -euo pipefail
APP="$HOME/Applications/Cairn.app/Contents/MacOS/Cairn"
if [[ -x "$APP" ]]; then exec "$APP" "$@"; fi
cd "${0:A:h:h}"
bun scripts/build.ts >&2   # sur stderr : la sortie de la commande (--json) reste propre
exec node_modules/.bin/electron . "$@"
