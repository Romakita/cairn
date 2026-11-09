#!/bin/zsh
# Étape « prepare » de semantic-release : applique la version calculée puis construit et vérifie l'archive.
# Usage : release-prepare.sh <version> [<commit du dernier tag>]
# Ensuite, semantic-release commite VERSION, la constante et le CHANGELOG, crée le tag et publie la release.
set -euo pipefail
ROOT="${0:A:h:h:h}"
VERSION="$1" SINCE="${2:-}"
cd "$ROOT"

mkdir -p Cairn/build
"$ROOT/Cairn/scripts/release-notes.sh" "$SINCE" > Cairn/build/changes.md
"$ROOT/Cairn/scripts/bump-version.sh" "$VERSION" Cairn/build/changes.md

swift test --package-path Cairn
Cairn/build-app.sh --no-install --zip
Cairn/scripts/smoke-test-app.sh Cairn/build/Cairn-"$VERSION"-*.zip
