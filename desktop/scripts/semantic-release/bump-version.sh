#!/bin/zsh
# Change la version de Cairn (app Electron) : desktop/package.json (source de la version, lue par electron-builder
# pour CFBundleShortVersionString et par la CLI pour `cairn --version`), Cairn/VERSION tant qu'il existe
# (`just version`, app Swift) et le CHANGELOG (section [Unreleased] datée et remplie avec les notes).
# Usage : desktop/scripts/semantic-release/bump-version.sh X.Y.Z [<fichier de notes>]
#   Appelé par semantic-release (release-prepare.sh) avec la version calculée depuis les commits.
set -euo pipefail
ROOT="${0:A:h:h:h:h}"
NEW="${1:-}"
NOTES_FILE="${2:-}"
if [[ ! "$NEW" =~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ]]; then
  echo "usage : bump-version.sh X.Y.Z (semver)" >&2; exit 2
fi
PKG="$ROOT/desktop/package.json"
OLD="$(/usr/bin/plutil -extract version raw -o - "$PKG")"

# Remplacement ciblé de la seule ligne "version" de premier niveau (le reste du fichier garde sa mise en forme).
sed -i '' -E "1,/^  \"version\": \"[^\"]*\",$/ s/^  \"version\": \"[^\"]*\",$/  \"version\": \"$NEW\",/" "$PKG"
[[ "$(/usr/bin/plutil -extract version raw -o - "$PKG")" == "$NEW" ]] || { echo "package.json non mis à jour" >&2; exit 1; }
files="desktop/package.json"
if [[ -f "$ROOT/Cairn/VERSION" ]]; then echo "$NEW" > "$ROOT/Cairn/VERSION"; files+=", Cairn/VERSION"; fi

if ! grep -q "^## \[$NEW\]" "$ROOT/CHANGELOG.md"; then
  # [Unreleased] devient [NEW] - date, rempli avec les notes fournies (les mêmes que la release GitHub).
  # Tout texte ajouté à la main sous [Unreleased] est remplacé : le CHANGELOG ne se rédige pas à la main.
  awk -v new="$NEW" -v date="$(date +%F)" -v notes="${NOTES_FILE:-/dev/null}" '
    function flush(  l) { while ((getline l < notes) > 0) { print l } print "" }
    /^## \[Unreleased\]$/ { print; print ""; print "## [" new "] - " date; print ""; on=1; next }
    on && /^## \[/ { flush(); on=0 }
    on { next }
    { print }
    END { if (on) flush() }
' "$ROOT/CHANGELOG.md" > "$ROOT/CHANGELOG.md.tmp" && mv "$ROOT/CHANGELOG.md.tmp" "$ROOT/CHANGELOG.md"
fi
echo "✔ $OLD → $NEW ($files, CHANGELOG)"
[[ -n "$NOTES_FILE" ]] || echo "En temps normal, c'est la CI qui fait ce bump au merge sur main (semantic-release)."
