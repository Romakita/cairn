#!/bin/zsh
# Change la version de Cairn : Cairn/VERSION, la constante du code et le CHANGELOG (section [Unreleased] datée).
# Usage : Cairn/scripts/bump-version.sh 0.2.0 [<fichier de notes>]
#   Appelé par la CI (semantic-release) avec la version calculée depuis les commits ; le fichier de notes remplit
#   la section si [Unreleased] est vide.
set -euo pipefail
ROOT="${0:A:h:h:h}"
NEW="${1:-}"
NOTES_FILE="${2:-}"
if [[ ! "$NEW" =~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ]]; then
  echo "usage : bump-version.sh X.Y.Z (semver)" >&2; exit 2
fi
OLD="$(tr -d '[:space:]' < "$ROOT/Cairn/VERSION")"
echo "$NEW" > "$ROOT/Cairn/VERSION"
sed -i '' "s/public static let fallback = \"$OLD\"/public static let fallback = \"$NEW\"/" "$ROOT/Cairn/Sources/CairnCore/BackupEngine.swift"
grep -q "fallback = \"$NEW\"" "$ROOT/Cairn/Sources/CairnCore/BackupEngine.swift" || { echo "constante non mise à jour" >&2; exit 1; }
if ! grep -q "^## \[$NEW\]" "$ROOT/CHANGELOG.md"; then
  # [Unreleased] devient [NEW] - date ; une section vide reçoit les notes fournies.
  awk -v new="$NEW" -v date="$(date +%F)" -v notes="${NOTES_FILE:-/dev/null}" '
    function flush(  l, n) { if (!body) { while ((getline l < notes) > 0) { print l; n++ } if (n) print "" } }
    /^## \[Unreleased\]$/ { print; print ""; print "## [" new "] - " date; on=1; next }
    on && /^## \[/ { flush(); on=0 }
    on && NF { body=1 }
    { print }
    END { if (on) flush() }
  ' "$ROOT/CHANGELOG.md" > "$ROOT/CHANGELOG.md.tmp" && mv "$ROOT/CHANGELOG.md.tmp" "$ROOT/CHANGELOG.md"
fi
echo "✔ $OLD → $NEW (VERSION, CairnVersion.fallback, CHANGELOG)"
[[ -n "$NOTES_FILE" ]] || echo "En temps normal, c'est la CI qui fait ce bump au merge sur main (semantic-release)."
