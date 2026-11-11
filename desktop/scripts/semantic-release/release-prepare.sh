#!/bin/zsh
# Étape « prepare » de semantic-release pour l'app Electron (.releaserc.json) : applique la version
# calculée, puis teste, construit et vérifie l'archive (desktop/release/Cairn-<v>-arm64.zip et son .sha256).
# Usage : desktop/scripts/semantic-release/release-prepare.sh <version> [<commit du dernier tag>]
# Ensuite, semantic-release commite desktop/package.json et le CHANGELOG, crée le tag et publie.
set -euo pipefail
ROOT="${0:A:h:h:h:h}"
VERSION="$1" SINCE="${2:-}"
cd "$ROOT/desktop"

mkdir -p release
"$ROOT/desktop/scripts/semantic-release/release-notes.sh" "$SINCE" > release/changes.md
"$ROOT/desktop/scripts/semantic-release/bump-version.sh" "$VERSION" release/changes.md

bun install --frozen-lockfile
bun run build:native
bun run test
bun run dist
scripts/smoke-test-app.sh release/Cairn-"$VERSION"-arm64.zip
