#!/bin/zsh
# Test de fumée de l'app empaquetée, lancée comme sur le Mac d'un utilisateur : copiée hors du dépôt, avec un
# CAIRN_HOME vide (spec app-packaging : « Application de test hors du dépôt », « Exécutable détourné »,
# « Lien existant après mise à jour », « Ressources absentes »).
# Usage : desktop/scripts/smoke-test-app.sh <Cairn.app | Cairn-x.y.z-arch.zip> (par défaut : release/Cairn-<v>-*.zip)
set -euo pipefail
DESKTOP="${0:A:h:h}"
VERSION="$(/usr/bin/plutil -extract version raw -o - "$DESKTOP/package.json")"
if (( $# )); then SRC="${1:A}"; else SRC="$(print -r -- "$DESKTOP"/release/Cairn-"$VERSION"-*.zip(N[1]))"; fi
[[ -e "$SRC" ]] || { echo "usage : smoke-test-app.sh <Cairn.app | Cairn-$VERSION-<arch>.zip>" >&2; exit 2; }

# Dossier de travail hors du dépôt (mktemp → /var/folders/…) : ni dist/, ni node_modules, ni sources à portée.
# Chemin réel (/private/var/…) : lancé par un chemin qui traverse un lien (/var → /private/var), Electron écrit
# « sandbox_extension_issue_file_to_process failed » sur stderr ; une app installée (~/Applications) n'est pas concernée.
WORK="$(realpath "$(mktemp -d)")"
GUI=""
# Fin : tout process lancé depuis la copie (interface, helpers Chromium) est arrêté avant de supprimer le dossier.
cleanup() { pkill -9 -f "$WORK/Cairn.app/" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "✘ $*" >&2; exit 1; }
# Arrête un process de l'interface : SIGTERM, puis SIGKILL au bout de 10 s (avec un avertissement).
stop() {
  kill "$1" 2>/dev/null || return 0
  for _ in {1..20}; do kill -0 "$1" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$1" 2>/dev/null; then
    echo "⚠ l'interface ne s'est pas arrêtée 10 s après SIGTERM : SIGKILL" >&2
    kill -9 "$1" 2>/dev/null || true
  fi
  wait "$1" 2>/dev/null || true
}

if [[ "$SRC" == *.zip ]]; then
  /usr/bin/ditto -x -k "$SRC" "$WORK"
  [[ -d "$WORK/Cairn.app" ]] || fail "Cairn.app absent de la racine du zip"
else
  cp -R "$SRC" "$WORK/"
fi
BUNDLE="$WORK/Cairn.app"
APP="$BUNDLE/Contents/MacOS/Cairn"
export CAIRN_HOME="$WORK/home"
# Données Chromium et verrou d'instance à part : une Cairn déjà ouverte sur ce Mac ne fait pas quitter l'interface testée.
export CAIRN_E2E_USER_DATA="$WORK/user-data"
cd "$WORK"

# Contrat de l'updater 0.8.x et Info.plist.
plist() { /usr/bin/plutil -extract "$1" raw -o - "$BUNDLE/Contents/Info.plist"; }
[[ "$(plist CFBundleIdentifier)" == fr.lenzotti.cairn ]] || fail "CFBundleIdentifier : $(plist CFBundleIdentifier)"
[[ "$(plist CFBundleShortVersionString)" == "$VERSION" ]] || fail "CFBundleShortVersionString : $(plist CFBundleShortVersionString)"
[[ "$(plist LSMinimumSystemVersion)" == 14.0 ]] || fail "LSMinimumSystemVersion : $(plist LSMinimumSystemVersion)"
[[ "$(plist LSUIElement)" == true ]] || fail "LSUIElement absent"
[[ "$(plist CFBundleLocalizations)" == 2 ]] || fail "CFBundleLocalizations : attendu en et fr"
/usr/bin/codesign --verify --deep --strict "$BUNDLE" || fail "signature invalide"
[[ -f "$BUNDLE/Contents/Resources/app.asar.unpacked/native/build/Release/cairn_native.node" ]] || fail "module natif non déballé"

# Fuses : l'app n'est pas un interpréteur Node (RunAsNode, NODE_OPTIONS, --inspect fermés ; asar seul et vérifié).
fuses="$("$DESKTOP/node_modules/.bin/electron-fuses" read --app "$BUNDLE")"
for f in "RunAsNode is Disabled" "EnableNodeOptionsEnvironmentVariable is Disabled" \
         "EnableNodeCliInspectArguments is Disabled" "EnableEmbeddedAsarIntegrityValidation is Enabled" \
         "OnlyLoadAppFromAsar is Enabled" "EnableCookieEncryption is Enabled"; do
  [[ "$fuses" == *"$f"* ]] || fail "fuse : « $f » attendu"$'\n'"$fuses"
done

# Scénario « Exécutable détourné » : en mode Node, `--version` afficherait la version de Node, et le script fourni
# (par argument ou par NODE_OPTIONS=--require) écrirait le fichier témoin.
print -r -- "require('node:fs').writeFileSync('$WORK/pwned', 'pwned')" > "$WORK/inject.js"
out="$(ELECTRON_RUN_AS_NODE=1 "$APP" --version 2>&1)"
[[ "$out" == "cairn $VERSION" ]] || fail "ELECTRON_RUN_AS_NODE pris en compte : $out"
out="$(NODE_OPTIONS="--require $WORK/inject.js" "$APP" --version 2>&1)"
[[ "$out" == "cairn $VERSION" ]] || fail "NODE_OPTIONS pris en compte : $out"
# Sans commande Cairn, l'exécutable ouvre l'interface au lieu d'exécuter le script : on l'arrête au bout de 5 s.
ELECTRON_RUN_AS_NODE=1 "$APP" "$WORK/inject.js" > /dev/null 2>&1 &
pid=$!
for _ in 1 2 3 4 5; do kill -0 $pid 2>/dev/null || break; sleep 1; done
kill -9 $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
[[ ! -e "$WORK/pwned" ]] || fail "le script fourni a été exécuté (mode interpréteur ouvert)"

# Scénario « Lien existant après mise à jour » : `cairn --version` par un lien, sortie exacte, rien sur stderr.
# Même disposition que chez l'utilisateur (~/.local/bin/cairn → ~/Applications/Cairn.app/Contents/MacOS/Cairn) :
# le lien est dans un autre dossier que l'app. Lancé ainsi, Chromium cherche ses helpers à partir du chemin du lien
# (« Unable to find helper app ») : le main doit se relancer par le chemin réel avant de démarrer quoi que ce soit.
mkdir -p "$WORK/bin"
ln -s "$APP" "$WORK/bin/cairn"
out="$("$WORK/bin/cairn" --version 2> "$WORK/stderr")" || fail "cairn --version : code $?"
[[ "$out" == "cairn $VERSION" ]] || fail "version inattendue : « $out »"
[[ ! -s "$WORK/stderr" ]] || fail "bruit sur stderr : $(<"$WORK/stderr")"

# Aide dans les deux langues, sorties JSON valides (traductions et ressources prises dans l'app).
"$WORK/bin/cairn" --lang fr-FR help | grep -q "Commandes" || fail "aide en français"
"$WORK/bin/cairn" --lang en-US help | grep -q "Commands" || fail "aide en anglais"
json() { /usr/bin/python3 -I -c "import json, sys; json.load(sys.stdin)" || fail "JSON invalide : $1"; }
"$APP" ai --json | json ai
"$APP" tools --json | json tools
mkdir -p "$WORK/sample/repo"
print -r -- "hello" > "$WORK/sample/file.txt"
"$APP" analyze --json "$WORK/sample" | json analyze
# Pool git (worker_threads chargé depuis l'asar) sur un vrai dépôt.
/usr/bin/git -C "$WORK/sample/repo" init -q
/usr/bin/git -C "$WORK/sample/repo" -c user.email=smoke@cairn -c user.name=smoke commit -q --allow-empty -m init
"$APP" git --json --root "$WORK/sample" > "$WORK/git.json"
json git < "$WORK/git.json"
grep -q '"repos"' "$WORK/git.json" || fail "cairn git : pas de dépôt analysé"

# Interface : lancée 8 s, elle doit tourner encore (une ressource introuvable la ferait planter au démarrage).
"$APP" > "$WORK/gui.log" 2>&1 &
GUI=$!
for _ in 1 2 3 4 5 6 7 8; do kill -0 $GUI 2>/dev/null || break; sleep 1; done
if ! kill -0 $GUI 2>/dev/null; then
  wait $GUI && code=0 || code=$?
  GUI=""
  echo "✘ l'interface s'est arrêtée au lancement (code $code)" >&2; cat "$WORK/gui.log" >&2; exit 1
fi
# Scénario « Commande pendant que l'app est ouverte » : la commande rend la main, l'interface tourne toujours.
"$WORK/bin/cairn" analyze --json "$WORK/sample" | json "analyze (app ouverte)"
kill -0 $GUI 2>/dev/null || fail "l'interface s'est fermée pendant une commande"
stop $GUI
GUI=""
echo "✔ app OK hors du dépôt ($VERSION, $(basename "$SRC"))"
