# Spec Delta

## MODIFIED Requirements

### Requirement: Découverte des dépôts
Cairn SHALL trouver tous les dépôts git des dossiers suivis, sans descendre dans les dossiers régénérables ni dans les métadonnées de volume. Pour chaque dépôt, il affiche la taille de `.git`, la part d'objets non compressés et la date de dernière activité (commit le plus récent, toutes branches, ou fichier le plus récemment modifié hors dossiers régénérables).

#### Scenario: Dépôt dans node_modules
- **WHEN** un `.git` se trouve sous un `node_modules`
- **THEN** ce dépôt n'est pas listé

#### Scenario: Repérer les vieux dépôts
- **WHEN** l'utilisateur trie l'onglet Dépôts par « Dernière activité »
- **THEN** les dépôts sans activité depuis le plus longtemps apparaissent en premier

### Requirement: Application confirmée et traçable
L'application SHALL exiger une confirmation qui récapitule ce qui sera supprimé. Avant chaque suppression, Cairn MUST écrire le nom et le SHA de la branche dans `.git/cleanup-deleted-branches.log` du dépôt. Dans l'app, rien n'est présélectionné : chaque branche ou worktree se supprime depuis le menu « … » de sa ligne, et une branche non fusionnée ou un worktree à risque demande de cocher une confirmation dédiée.

#### Scenario: Récupération d'une branche supprimée
- **WHEN** une branche a été supprimée sans prune immédiat
- **THEN** son nom et son SHA figurent dans `cleanup-deleted-branches.log`, et `git branch <nom> <sha>` la recrée

### Requirement: Optimisation
En ligne de commande, Cairn SHALL lancer `git gc` sur les dépôts nettoyés, sauf si l'utilisateur le désactive. Dans l'app, le compactage est une action du menu d'un dépôt, confirmée, et une suppression de branche ou de worktree ne le lance pas. L'option « libérer immédiatement » MUST expirer le reflog des objets inaccessibles et lancer le prune immédiatement, et elle est expliquée comme empêchant la récupération des branches supprimées.

#### Scenario: Libération immédiate
- **WHEN** l'utilisateur compacte un dépôt avec « libérer aussi tout de suite l'espace des branches supprimées »
- **THEN** l'espace des branches supprimées est rendu tout de suite, et la confirmation a prévenu que leur récupération ne serait plus possible

### Requirement: Détection des worktrees obsolètes
Un worktree SHALL être signalé comme obsolète dans l'un de ces cas :
- **orphelin** : son dossier n'existe plus ;
- **fusionné** : sa branche est fusionnée ou squashée dans la branche principale, ou bien « gone » ;
- **inactif** : sans modification depuis un nombre de jours configurable (30 par défaut).

Un worktree avec des modifications non commitées, des fichiers non suivis ou des commits non poussés MUST être signalé « à risque » et n'est jamais sélectionné par défaut par la ligne de commande.

#### Scenario: Worktree orphelin
- **WHEN** le dossier d'un worktree a été supprimé à la main
- **THEN** il est signalé « orphelin » et son nettoyage ne fait que retirer l'entrée de git

#### Scenario: Worktree propre et fusionné
- **WHEN** la branche d'un worktree sans modifications a été squashée dans `main`
- **THEN** il est signalé « fusionné », la ligne de commande le propose à la suppression, et l'espace récupérable inclut ses `node_modules`

#### Scenario: Worktree avec du travail en cours
- **WHEN** un worktree inactif depuis 60 jours contient des modifications non commitées
- **THEN** il est signalé « à risque », jamais proposé par défaut, et sa suppression demande de cocher une confirmation dédiée

## ADDED Requirements

### Requirement: Actions par ligne
Dans l'app, chaque ligne de l'écran Git SHALL avoir un menu « … » : afficher dans le Finder et copier le chemin ou le nom ; pour un dépôt, l'analyser seul, le compacter et le placer dans la corbeille ; pour une branche ou un worktree, le supprimer. Les suppressions sont indisponibles pendant l'analyse, pendant une autre opération sur le même dépôt, et pour une branche extraite dans un worktree (on supprime alors le worktree, qui propose sa branche, non cochée par défaut).

#### Scenario: Dépôt placé dans la corbeille
- **WHEN** l'utilisateur place dans la corbeille un dépôt qui a des commits absents de tout dépôt distant
- **THEN** la confirmation le signale et demande de cocher une confirmation dédiée ; une fois confirmé, le dossier va dans la corbeille et la ligne disparaît

### Requirement: Mise à jour ciblée après suppression
Après une suppression ou un compactage, l'app MUST mettre à jour seulement le dépôt concerné (lignes supprimées retirées, branches libérées, tailles remesurées) sans relancer l'analyse des autres dépôts.

#### Scenario: Suppression d'un worktree
- **WHEN** l'utilisateur supprime un worktree
- **THEN** sa ligne disparaît, les autres résultats restent affichés, et aucune analyse n'est relancée
