# Changelog

Toutes les évolutions notables de Cairn. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions en [SemVer](https://semver.org/lang/fr/). Le numéro courant est dans `Cairn/VERSION`.

## [Unreleased]

## [0.1.1] - 2026-11-08

### Corrigé
- L'app téléchargée depuis une release plantait au lancement : son bundle de ressources n'était cherché que dans le
  dossier de build de la machine qui l'avait compilée. Les ressources sont maintenant cherchées dans
  `Cairn.app/Contents/Resources` (y compris via le lien `cairn`), et la CI lance l'app construite hors de ce dossier.
- Maintenance git : la branche principale locale n'est jamais proposée, même extraite dans un worktree lié.
- Restauration des outils IA : une base SQLite absente du Mac est toujours restaurée ; un dossier de projet Claude
  n'est supprimé qu'après une fusion réussie.

### Ajouté
- `cairn restore --tool ID` pour choisir les outils IA à restaurer.

## [0.1.0] - 2026-11-08

Première version publique.

### Ajouté
- Analyse de l'occupation des dossiers suivis : explorateur, contenu régénérable (nettoyage vers la corbeille après
  confirmation), gros projets (worktrees compris), gros objets.
- Sauvegardes versionnées par rsync (`--link-dest`) vers un dossier, un disque ou un NAS SMB, dans une image disque
  chiffrée (AES-256) ; rétention par paliers, reprise d'une sauvegarde interrompue, contrôle d'intégrité (SHA-256),
  planification tant que l'app est ouverte, attente d'un NAS injoignable.
- Sauvegarde et restauration des conversations et de la configuration des outils IA (Claude Code, Claude Desktop,
  Codex) par profils déclaratifs, avec copies cohérentes des bases SQLite.
- Inventaire des outils en ligne de commande (brew, mise, npm, uv, pipx, cargo, go) et export réinstallable.
- Maintenance git : branches gone, fusionnées ou squashées, worktrees obsolètes, gc ; simulation par défaut et journal
  des SHA supprimés.
- Restauration sélective (format Cairn et anciennes sauvegardes `backup.sh`), y compris sur un Mac neuf.
- Barre des menus avec résumé du stockage et alertes de disque plein.
- Commande `cairn` (même binaire que l'app) ; interface en anglais et en français.
