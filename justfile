# Cairn depuis la racine du projet : `just` liste les commandes.
set positional-arguments

cairn := "Cairn/cairn.sh"

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

# Lance les tests de Cairn (FILTRE optionnel sur le nom des tests)
test *filter:
    swift build --package-path Cairn
    Cairn/.build/debug/cairn-selftest {{filter}}

# Construit l'app Cairn, l'installe dans ~/Applications et relie ~/.local/bin/cairn
storage-install:
    Cairn/build-app.sh

# Ouvre l'app Cairn (l'installe si besoin)
storage:
    #!/usr/bin/env bash
    set -euo pipefail
    app="$HOME/Applications/Cairn.app"
    [[ -d "$app" ]] || Cairn/build-app.sh
    open "$app"

# Résumé de l'occupation disque dans le terminal (par défaut : dossiers suivis de config.toml)
storage-report *args:
    {{cairn}} analyze "$@"

# Version courante de Cairn (Cairn/VERSION)
version:
    @cat Cairn/VERSION

# Notes de la prochaine release (sujets des commits depuis le dernier tag)
release-notes:
    Cairn/scripts/release-notes.sh "$(git rev-list -n1 "$(git describe --tags --abbrev=0 --match 'v[0-9]*')")"

# Construit l'archive de release en local (build/Cairn-<version>-<arch>.zip), sans installer
release-build:
    Cairn/build-app.sh --no-install --zip
