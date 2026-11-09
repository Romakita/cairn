# Proposal

## Why

Retours de test de l'écran Git : la présélection des branches et worktrees est dangereuse (un clic sur
« Supprimer… » emporte tout ce que Cairn a coché), le bouton « Supprimer » global est ambigu sur l'onglet Dépôts où
rien n'est sélectionnable, « Lancer git gc » et « Libérer immédiatement » ne sont pas compréhensibles, supprimer un
worktree relance l'analyse complète (plusieurs minutes), et rien ne permet de repérer les très vieux dépôts.

## What Changes

- Plus de cases à cocher ni de présélection dans l'app : chaque ligne (dépôt, branche, worktree) a un menu « … »
  avec ses actions, et chaque suppression se confirme une par une. La ligne de commande garde sa sélection par défaut.
- La suppression d'une branche ou d'un worktree ne met à jour que ce dépôt : les lignes supprimées disparaissent et
  ses tailles sont remesurées, sans relancer l'analyse. Elle ne lance plus `git gc`.
- Compactage (`git gc`) : action du menu d'un dépôt, avec l'option expliquée de libérer tout de suite l'espace des
  branches supprimées (elles ne sont alors plus récupérables).
- Onglet Dépôts : colonne « Dernière activité » (commit le plus récent ou fichier le plus récemment modifié),
  colonnes triables, et action « Placer le dépôt dans la corbeille » (confirmée, travail non poussé signalé).
- Actions globales en haut à droite : « Relancer l'analyse », et « Exporter… » dans l'onglet Branches seulement.
- Pendant l'analyse, une table encore vide affiche un simple indicateur de chargement.

## Capabilities

### Modified Capabilities

- `git-maintenance` : découverte (dernière activité), application confirmée (par ligne), optimisation (action par
  dépôt), détection des worktrees obsolètes (présélection limitée à la ligne de commande), et nouvelles exigences
  « Actions par ligne » et « Mise à jour ciblée après suppression ».

## Impact

- `Cairn/Sources/CairnCore/GitMaintenance.swift` : `RepoReport` (dernière activité, travail non poussé du dossier
  principal, `removing`), `refreshSizes`.
- `Cairn/Sources/Cairn/GitView.swift`, `AppModel.swift`, `Snapshot.swift`, traductions ; test
  `Git.deletion_updates_one_repo_without_reanalysis`.
