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
