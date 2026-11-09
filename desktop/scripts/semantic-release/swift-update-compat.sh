#!/bin/zsh
# Tâche 13.5 (spec app-packaging, « Mise à jour depuis la version Swift ») : prouve que l'updater de la 0.8.0 installe
# un zip Electron. Tout se passe dans un dossier temporaire : l'app installée de l'utilisateur n'est jamais touchée.
#   1. copie ~/Applications/Cairn.app (0.8.0, Swift) dans <tmp>/Applications, CAIRN_HOME temporaire avec un config.toml ;
#   2. sert un faux flux GitHub sur 127.0.0.1 (releases/latest + zip + .sha256, version finale : l'updater refuse
#      les préversions) ;
#   3. lance la copie 0.8.0 avec CAIRN_UPDATE_URL : son contrôle automatique (5 s) doit interroger le flux ;
#   4. rejoue UpdateController.install() avec le code de Updater.swift du tag v0.8.0 (compilé tel quel) : check,
#      download + prepare (SHA-256, ditto -x -k, identifiant, version, quarantaine), scheduleSwap après le pid de l'app ;
#   5. quitte l'app 0.8.0 (comme NSApp.terminate), attend le remplacement, puis vérifie la nouvelle app : version par
#      un lien `cairn` existant, relecture du config.toml, interface lancée par LaunchServices (`open`) sans plantage.
# Usage : swift-update-compat.sh <Cairn-X.Y.Z-arm64.zip> (version finale > 0.8.0, ex. construite avec 99.0.0)
set -euo pipefail
ZIP="${1:A}"
REPO="${0:A:h:h:h:h}"
NAME="${ZIP:t}"
[[ "$NAME" =~ '^Cairn-([0-9]+\.[0-9]+\.[0-9]+)-(arm64|x86_64)\.zip$' ]] || { echo "nom de zip inattendu : $NAME" >&2; exit 2; }
VERSION="${match[1]}"
[[ -f "$ZIP.sha256" ]] || { echo "$ZIP.sha256 manquant" >&2; exit 2; }
SOURCE_APP="$HOME/Applications/Cairn.app"
[[ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$SOURCE_APP/Contents/Info.plist")" == 0.8.* ]] ||
  { echo "il faut la 0.8.x installée dans ~/Applications" >&2; exit 2; }

WORK="$(realpath "$(mktemp -d)")"
SERVER="" OLD=""
cleanup() {
  for p in $SERVER $OLD; do kill "$p" 2>/dev/null || true; done
  # Interface et helpers Chromium de la nouvelle app (elle peut ignorer SIGTERM juste après son lancement).
  pkill -9 -f "$WORK/Applications/" 2>/dev/null || true
  sleep 1
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "✘ $*" >&2; exit 1; }

# 1. App 0.8.0 et données de test.
mkdir -p "$WORK/Applications" "$WORK/home" "$WORK/feed" "$WORK/bin" "$WORK/data"
cp -R "$SOURCE_APP" "$WORK/Applications/"
BUNDLE="$WORK/Applications/Cairn.app"
export CAIRN_HOME="$WORK/home"
cat > "$CAIRN_HOME/config.toml" <<TOML
# config écrit pour la 0.8.0 (test de mise à jour)
version = 1
language = "fr-FR"

[[folders]]
path = "$WORK/data"
backup = true
TOML
ln -s "$BUNDLE/Contents/MacOS/Cairn" "$WORK/bin/cairn"   # lien `cairn` installé avant la mise à jour
[[ "$("$WORK/bin/cairn" --version)" == "cairn 0.8.0" ]] || fail "la copie 0.8.0 ne répond pas"
"$WORK/bin/cairn" config validate > /dev/null || fail "la 0.8.0 refuse le config.toml de test"

# 2. Faux flux GitHub.
cp "$ZIP" "$ZIP.sha256" "$WORK/feed/"
PORT=$((20000 + RANDOM % 20000))
BASE="http://127.0.0.1:$PORT"
cat > "$WORK/feed/latest" <<JSON
{"tag_name": "v$VERSION", "draft": false, "prerelease": false, "html_url": "$BASE/release",
 "body": "### Added\n- test release",
 "assets": [{"name": "$NAME", "browser_download_url": "$BASE/$NAME"},
            {"name": "$NAME.sha256", "browser_download_url": "$BASE/$NAME.sha256"}]}
JSON
(cd "$WORK/feed" && exec /usr/bin/python3 -I -m http.server "$PORT" --bind 127.0.0.1) > "$WORK/server.log" 2>&1 &
SERVER=$!
for _ in {1..50}; do /usr/bin/curl -sf "$BASE/latest" > /dev/null && break; sleep 0.1; done
export CAIRN_UPDATE_URL="$BASE/latest"

# 3. L'app 0.8.0 lancée détecte la release (contrôle automatique 5 s après le lancement).
"$BUNDLE/Contents/MacOS/Cairn" > "$WORK/old.log" 2>&1 &
OLD=$!
for _ in {1..30}; do grep -q 'GET /latest' "$WORK/server.log" && break; sleep 0.5; done
grep -q 'GET /latest' "$WORK/server.log" || fail "l'app 0.8.0 n'a pas interrogé le flux"
echo "✔ l'app 0.8.0 (pid $OLD) interroge CAIRN_UPDATE_URL"

# 4. Installation avec le code de l'updater 0.8.0.
H="$WORK/harness"
mkdir -p "$H"
git -C "$REPO" show v0.8.0:Cairn/Sources/CairnCore/Updater.swift > "$H/Updater.swift"
cat > "$H/Stubs.swift" <<'SWIFT'
import Foundation
public enum L10n { public static func tr(_ key: String, _ args: CVarArg...) -> String { "\(key) \(args)" } }
public enum CairnVersion { public static let current = "0.8.0" }
SWIFT
cat > "$H/main.swift" <<'SWIFT'
// Même enchaînement que UpdateController.install() de la 0.8.0, sans l'interface.
import Foundation
let bundle = CommandLine.arguments[1]
let pid = Int32(CommandLine.arguments[2])!
Task {
    do {
        guard let installable = Updater.installableBundle(bundle) else { print("✘ bundle non remplaçable"); exit(1) }
        guard let r = try await Updater.check(current: "0.8.0") else { print("✘ aucune release plus récente"); exit(1) }
        print("✔ check : \(r.version), \(r.archiveURL.lastPathComponent) + \(r.checksumURL.lastPathComponent)")
        let app = try await Updater.download(r, replacing: installable)
        print("✔ download + prepare (SHA-256, ditto, identifiant, version) : \(app.path)")
        try Updater.scheduleSwap(newApp: app, replacing: installable, after: pid, relaunch: false)
        print("✔ remplacement programmé après la fin du pid \(pid)")
        exit(0)
    } catch { print("✘ \(error)"); exit(1) }
}
dispatchMain()
SWIFT
/usr/bin/swiftc -O -o "$H/updater" "$H/Updater.swift" "$H/Stubs.swift" "$H/main.swift"
"$H/updater" "$BUNDLE" "$OLD"
[[ -z "$(/usr/bin/xattr -p com.apple.quarantine "$WORK/Applications/.cairn-update/Cairn.app" 2>/dev/null)" ]] ||
  fail "quarantaine non retirée"

# 5. L'app 0.8.0 quitte ; le script de la 0.8.0 remplace le bundle.
kill "$OLD"; wait "$OLD" 2>/dev/null || true; OLD=""
for _ in {1..50}; do [[ ! -d "$WORK/Applications/.cairn-update" ]] && break; sleep 0.2; done
[[ ! -d "$WORK/Applications/.cairn-update" ]] || fail "remplacement non terminé (.cairn-update encore là)"
plist() { /usr/bin/plutil -extract "$1" raw -o - "$BUNDLE/Contents/Info.plist"; }
[[ "$(plist CFBundleShortVersionString)" == "$VERSION" && -f "$BUNDLE/Contents/Resources/app.asar" ]] ||
  fail "le bundle installé n'est pas la nouvelle app"
echo "✔ Cairn.app remplacée par $VERSION (Electron)"

# Scénario « Lien existant après mise à jour ».
out="$("$WORK/bin/cairn" --version 2> "$WORK/stderr")" || fail "cairn --version : code $?"
[[ "$out" == "cairn $VERSION" && ! -s "$WORK/stderr" ]] || fail "cairn --version : « $out » $(<"$WORK/stderr")"
echo "✔ lien cairn existant : $out"
# Configuration de la 0.8.0 relue.
"$WORK/bin/cairn" config path | grep -qx "$CAIRN_HOME/config.toml" || fail "config path"
"$WORK/bin/cairn" config validate > "$WORK/validate.log" 2>&1 || { cat "$WORK/validate.log" >&2; fail "config validate"; }
"$WORK/bin/cairn" config show --json |
  /usr/bin/python3 -I -c 'import json, sys; c = json.load(sys.stdin)["config"]; sys.exit(c["folders"][0]["path"] != sys.argv[1])' "$WORK/data" ||
  fail "config show ne relit pas le config.toml de la 0.8.0"
"$WORK/bin/cairn" help | grep -q "Commandes" || fail "langue fr-FR du config.toml non appliquée"
echo "✔ config.toml de la 0.8.0 relu (dossiers, langue)"

# Relance comme le script (`open`), avec le même CAIRN_HOME (open ne transmet pas l'environnement sans --env).
/usr/bin/open -n --env CAIRN_HOME="$CAIRN_HOME" --env CAIRN_E2E_USER_DATA="$WORK/user-data" \
  --env CAIRN_UPDATE_URL="$CAIRN_UPDATE_URL" "$BUNDLE"
sleep 8
pgrep -f "$BUNDLE/Contents/MacOS/Cairn" > /dev/null || fail "la nouvelle app ne tourne pas après open"
echo "✔ nouvelle app lancée par open, toujours active après 8 s"
echo "✔ mise à jour 0.8.0 → $VERSION vérifiée"
