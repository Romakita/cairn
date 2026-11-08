# Sauvegarde, analyse et redéploiement du Mac — Cairn

Tout passe par **Cairn** (`Cairn/`) : une app macOS et la commande `cairn` (même binaire). Elle remplace les anciens
scripts `backup.sh`, `restore.sh` et `git-cleanup.sh` (retirés ; ils restent dans l'historique git).
Documentation détaillée : [Cairn/README.md](Cairn/README.md).

```bash
just storage-install   # construit Cairn.app, l'installe dans ~/Applications et relie ~/.local/bin/cairn
just storage           # ouvre l'app : l'assistant configure ~/.cairn/config.toml au premier lancement
just                   # liste les commandes
```

| Commande | Rôle |
|---|---|
| `just backup` / `just backup-dry` | sauvegarde vers les destinations configurées / simulation |
| `just restore …` | restaure une sauvegarde (simulation sans `--apply`) |
| `just check` | vérifie seulement les outils requis listés dans la sauvegarde |
| `just verify` | contrôle d'intégrité des sauvegardes (`--full` : tout) |
| `just git-clean` / `just git-clean-apply` | branches « gone » et worktrees obsolètes : simulation / application |
| `just tools` | outils CLI à réinstaller (`--export DOSSIER`) |
| `just storage-report` | occupation disque dans le terminal |
| `just test` | tests de Cairn |

Les options passent à la suite : `just backup --destination nas --only home`.

## Sauvegarder

Au premier lancement, l'assistant de Cairn fait choisir les dossiers suivis (`/Volumes/workspaces`…), les éléments du
home, les outils IA (Claude Code, Claude Desktop, Codex), la destination (NAS Synology en SMB, disque externe, dossier)
et la planification. Les sauvegardes sont chiffrées par défaut (image disque AES-256, mot de passe dans le Trousseau),
versionnées (30 jours en quotidien puis un an en hebdomadaire) et vérifiées chaque mois par empreintes SHA-256.

Ce qui n'est jamais copié : dépendances et sorties de build (`node_modules`, `dist`, `Pods`, `DerivedData`, `.venv`…),
caches, plugins et paquets des outils IA (réinstallés), applications. Les dossiers génériques (`lib/`, `build/`, `out/`,
`target/`, `vendor/`) ne sont exclus que s'ils sont générés (ignorés par le `.gitignore` du dépôt ou à côté d'un fichier
de projet).

## Redéployer sur l'autre Mac

Installer Cairn (`just storage-install`, les Command Line Tools suffisent), l'ouvrir et choisir « Restaurer une sauvegarde
à la place » dans l'assistant, ou :

```bash
cairn restore --destination nas            # simulation de la dernière version
cairn restore --destination nas --apply    # restauration
```

Cairn sait aussi relire une ancienne sauvegarde faite par `backup.sh` (`cairn restore --from /Volumes/Disque/mac-backup`).
Il réinstalle les outils (Homebrew, mise, npm, uv, pipx, cargo), restaure le home et les dossiers en gardant les fichiers
remplacés avec le suffixe `.pre-restore`, fusionne les conversations IA et peut créer le volume APFS `workspaces`.
L'installation de Homebrew s'ouvre dans Terminal.

## Nettoyer les dépôts git

```bash
just git-clean                     # simulation : branches gone (fusionnées, squashées), worktrees obsolètes, gain estimé
just git-clean --fetch             # idem après git fetch --prune
just git-clean-apply --prune-now   # suppression (après confirmation) + git gc, espace libéré tout de suite
```

Une branche n'est supprimée que si elle est fusionnée ou squashée dans la branche principale (sauf
`--include-unmerged`), jamais si elle est extraite dans un worktree conservé. Un worktree avec du travail non commité ou
non poussé n'est jamais supprimé sans `--include-at-risk`. Les SHA supprimés sont notés dans
`.git/cleanup-deleted-branches.log` : `git branch <nom> <sha>` recrée une branche tant que l'espace n'a pas été libéré.
