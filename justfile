# Lance les scripts depuis la racine du projet : `just` liste les commandes.
set positional-arguments

# Liste les commandes
default:
    @just --list

# Sauvegarde home + workspace vers DEST (options : --mirror, --no-home, --no-workspace)
backup dest *args:
    scripts/backup.sh "$@"

# Simulation de la sauvegarde (rien n'est copié, seul le manifest est écrit)
backup-dry dest *args:
    scripts/backup.sh "$@" --dry-run

# Redéploie la sauvegarde DIR sur ce Mac (options : --yes, --apps, --skip-home, --skip-workspace…)
restore dir *args:
    #!/usr/bin/env bash
    set -euo pipefail
    dir="$1"; shift
    "$dir/restore.sh" "$@"

# Vérifie seulement les outils requis listés dans la sauvegarde DIR
check dir:
    "$1/restore.sh" --check

# Simulation du nettoyage git (options : --root, --only, --fetch)
git-clean *args:
    scripts/git-cleanup.sh "$@"

# Nettoyage git réel : branches "gone" fusionnées + git gc (options : --include-unmerged, --prune-now, --fetch)
git-clean-apply *args:
    scripts/git-cleanup.sh --apply "$@"

# Lance les tests de Cairn (exécutable cairn-selftest ; FILTRE optionnel sur le nom des tests)
test *filter:
    swift build --package-path Cairn --product cairn-selftest
    Cairn/.build/debug/cairn-selftest {{filter}}

# Construit l'app Cairn et l'installe dans ~/Applications
storage-install:
    Cairn/build-app.sh

# Ouvre l'app Cairn (l'installe si besoin)
storage:
    #!/usr/bin/env bash
    set -euo pipefail
    app="$HOME/Applications/Cairn.app"
    [[ -d "$app" ]] || Cairn/build-app.sh
    open "$app"

# Résumé de l'occupation disque dans le terminal (DIR par défaut : /Volumes/workspaces)
storage-report dir="/Volumes/workspaces":
    #!/usr/bin/env bash
    set -euo pipefail
    swift build -c release --package-path Cairn --product Cairn >/dev/null 2>&1
    "$(swift build -c release --package-path Cairn --show-bin-path)/Cairn" analyze "$1"
