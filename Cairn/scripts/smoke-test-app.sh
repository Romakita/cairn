#!/bin/zsh
# Lance l'app construite comme sur le Mac d'un utilisateur : copiée hors du dépôt, sans le dossier de build
# (Cairn/.build est caché le temps du test, sinon les ressources y seraient trouvées par erreur).
# Usage : Cairn/scripts/smoke-test-app.sh <Cairn.app | Cairn-x.y.z-arch.zip>
set -euo pipefail
SRC="${1:A}"
CAIRN="${0:A:h:h}"
WORK="$(mktemp -d)"
HIDDEN=""
restore() { [[ -n "$HIDDEN" && -d "$HIDDEN" ]] && mv "$HIDDEN" "$CAIRN/.build"; rm -rf "$WORK"; }
trap restore EXIT

if [[ "$SRC" == *.zip ]]; then ditto -x -k "$SRC" "$WORK"; else cp -R "$SRC" "$WORK/"; fi
APP="$WORK/Cairn.app/Contents/MacOS/Cairn"
if [[ -d "$CAIRN/.build" ]]; then HIDDEN="$CAIRN/.build-smoke-hidden"; mv "$CAIRN/.build" "$HIDDEN"; fi

export CAIRN_HOME="$WORK/home"
ln -s "$APP" "$WORK/cairn"
VERSION="$(tr -d '[:space:]' < "$CAIRN/VERSION")"
[[ "$("$WORK/cairn" --version)" == "cairn $VERSION" ]] || { echo "version inattendue" >&2; exit 1; }
"$APP" --lang fr-FR help | grep -q "Commandes"
"$APP" --lang en-US help | grep -q "Commands"
"$APP" ai --json > /dev/null
"$APP" tools --json > /dev/null
# Interface : l'app 0.1.0 plantait dès la construction des menus (ressources introuvables), chemin que les
# commandes ci-dessus ne parcourent pas. On la lance et on vérifie qu'elle tourne encore après quelques secondes.
"$APP" > "$WORK/gui.log" 2>&1 &
GUI=$!
for _ in 1 2 3 4 5 6 7 8; do kill -0 $GUI 2>/dev/null || break; sleep 1; done
if ! kill -0 $GUI 2>/dev/null; then
  wait $GUI; code=$?
  echo "l'interface s'est arrêtée au lancement (code $code)" >&2; cat "$WORK/gui.log" >&2; exit 1
fi
kill $GUI; wait $GUI 2>/dev/null || true
echo "✔ app OK hors du dossier de build ($VERSION)"
