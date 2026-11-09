# Tasks

## 1. CairnCore

- [x] 1.1 `RepoReport` : dernière activité, fichiers modifiés et commits non poussés du dossier principal, `removing(branches:worktrees:)`
- [x] 1.2 `GitMaintenance.refreshSizes` (tailles remesurées sans analyse) ; test `Git.deletion_updates_one_repo_without_reanalysis`

## 2. App

- [x] 2.1 Menu « … » par ligne (dépôts, branches, worktrees), plus de cases à cocher ni de présélection
- [x] 2.2 Feuille de confirmation par action (worktree, branche, corbeille, compactage) avec confirmation dédiée du travail perdu
- [x] 2.3 Mise à jour du seul dépôt après suppression ; pas de gc lors d'une suppression
- [x] 2.4 Colonne « Dernière activité » et tri des colonnes de l'onglet Dépôts
- [x] 2.5 « Relancer l'analyse » en haut à droite, « Exporter… » dans l'onglet Branches ; indicateur de chargement simple
- [x] 2.6 Traductions en/fr, captures (`Snapshot.swift`)

## 3. Vérification

- [x] 3.1 `just test`, captures de l'écran Git
- [x] 3.2 `openspec validate git-row-actions`
