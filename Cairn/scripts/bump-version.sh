#!/bin/zsh
# Change la version de Cairn : Cairn/VERSION, la constante du code et le CHANGELOG (section [Unreleased] datée).
# Usage : Cairn/scripts/bump-version.sh 0.2.0
set -euo pipefail
ROOT="${0:A:h:h:h}"
NEW="${1:-}"
if [[ ! "$NEW" =~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ]]; then
  echo "usage : bump-version.sh X.Y.Z (semver)" >&2; exit 2
fi
OLD="$(tr -d '[:space:]' < "$ROOT/Cairn/VERSION")"
echo "$NEW" > "$ROOT/Cairn/VERSION"
sed -i '' "s/public static let fallback = \"$OLD\"/public static let fallback = \"$NEW\"/" "$ROOT/Cairn/Sources/CairnCore/BackupEngine.swift"
grep -q "fallback = \"$NEW\"" "$ROOT/Cairn/Sources/CairnCore/BackupEngine.swift" || { echo "constante non mise à jour" >&2; exit 1; }
if ! grep -q "^## \[$NEW\]" "$ROOT/CHANGELOG.md"; then
  sed -i '' "s/^## \[Unreleased\]$/## [Unreleased]\\
\\
## [$NEW] - $(date +%F)/" "$ROOT/CHANGELOG.md"
fi
echo "✔ $OLD → $NEW (VERSION, CairnVersion.fallback, CHANGELOG)"
echo "Ensuite : relire CHANGELOG.md, commiter, puis : git tag v$NEW && git push origin main v$NEW"
