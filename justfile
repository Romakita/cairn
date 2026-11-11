# Cairn depuis la racine du projet : `just` liste les commandes. L'app est dans desktop/ (Electron + Bun).
set positional-arguments

cairn := "desktop/scripts/cairn.sh"

# Liste les commandes
default:
    @just --list

# Sauvegarde vers les destinations de ~/.cairn/config.toml (options : --destination ID, --only folders|home|tools|ai)
backup *args:
    {{cairn}} backup "$@"

# Simulation de la sauvegarde (rien n'est écrit)
backup-dry *args:
    {{cairn}} backup --dry-run "$@"

# Restaure une sauvegarde (simulation sans --apply ; --from DOSSIER ou --destination ID)
restore *args:
    {{cairn}} restore "$@"

# Vérifie seulement les outils requis listés dans la sauvegarde
check *args:
    {{cairn}} restore --check "$@"

# Contrôle d'intégrité des sauvegardes (--full : tout)
verify *args:
    {{cairn}} verify "$@"

# Simulation du nettoyage git : branches gone et worktrees obsolètes (options : --root, --only, --fetch)
git-clean *args:
    {{cairn}} git "$@"

# Nettoyage git réel, après confirmation (options : --include-unmerged, --prune-now, --worktrees-only)
git-clean-apply *args:
    {{cairn}} git --apply "$@"

# Outils CLI installés à réinstaller (--export DOSSIER)
tools *args:
    {{cairn}} tools "$@"

# Tests du core et de la CLI (bun test ; FILTRE optionnel sur le nom des tests)
test *filter:
    cd desktop && bun test ./test/core ./test/regressions ./test/tooling ${1:+--test-name-pattern "$1"}

# Tests de bout en bout sur la vraie app Electron (Playwright)
e2e:
    cd desktop && bun run test:e2e

# Lint (Biome + règles du design system) et vérification des types
lint:
    cd desktop && bun run lint && bun run typecheck

# Construit l'app Cairn, l'installe dans ~/Applications et relie ~/.local/bin/cairn
storage-install:
    desktop/scripts/install-app.sh

# Ouvre l'app Cairn (l'installe si besoin)
storage:
    #!/usr/bin/env bash
    set -euo pipefail
    app="$HOME/Applications/Cairn.app"
    [[ -d "$app" ]] || desktop/scripts/install-app.sh
    open "$app"

# App en développement (build puis Electron)
dev:
    cd desktop && bun run start

# Interface seule dans le navigateur, avec les données d'exemple (galerie : /#/gallery)
dev-web:
    cd desktop && bun run dev:web

# Résumé de l'occupation disque dans le terminal (par défaut : dossiers suivis de config.toml)
storage-report *args:
    {{cairn}} analyze "$@"

# Catalogue des composants de l'interface, depuis les sources du dépôt
gallery:
    cd desktop && bun run build && node_modules/.bin/electron . --gallery

# Exporte le catalogue en images PNG + index.html (dossier par défaut : build/gallery)
gallery-export dir="build/gallery":
    cd desktop && bun run build && node_modules/.bin/electron . --gallery-export "{{absolute_path(dir)}}"

# Captures de chaque écran en clair et en sombre (dossier desktop/shots)
shots:
    cd desktop && bun run shots

# Version courante de Cairn (desktop/package.json)
version:
    @/usr/bin/plutil -extract version raw -o - desktop/package.json

# Notes de la prochaine release (sujets des commits depuis le dernier tag)
release-notes:
    desktop/scripts/semantic-release/release-notes.sh "$(git rev-list -n1 "$(git describe --tags --abbrev=0 --match 'v[0-9]*')")"

# Construit l'archive de release en local (desktop/release/Cairn-<version>-arm64.zip), sans installer
release-build:
    cd desktop && bun run dist
