#!/bin/zsh
# Lance la commande cairn : celle de ~/Applications/Cairn.app si elle est installée, sinon une version compilée ici.
set -euo pipefail
APP="$HOME/Applications/Cairn.app/Contents/MacOS/Cairn"
if [[ -x "$APP" ]]; then exec "$APP" "$@"; fi
cd "${0:A:h}"
swift build -c release --product Cairn >/dev/null
exec "$(swift build -c release --show-bin-path)/Cairn" "$@"
