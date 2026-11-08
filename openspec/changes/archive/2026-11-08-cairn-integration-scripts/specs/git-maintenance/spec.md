# Spec Delta

## Purpose

Allège les dépôts git des dossiers suivis : suppression des branches locales dont la branche distante a disparu et des worktrees devenus obsolètes, puis compactage. Le tout en simulation par défaut et en gardant de quoi annuler, comme le faisait `git-cleanup.sh`.

## ADDED Requirements

### Requirement: Découverte des dépôts
Cairn SHALL trouver tous les dépôts git des dossiers suivis, sans descendre dans les dossiers régénérables ni dans les métadonnées de volume. Pour chaque dépôt, il affiche la taille de `.git` et la part d'objets non compressés.

#### Scenario: Dépôt dans node_modules
- **WHEN** un `.git` se trouve sous un `node_modules`
- **THEN** ce dépôt n'est pas listé

### Requirement: Branches supprimables
Une branche locale est « gone » quand sa branche distante a été supprimée. Cairn SHALL lui donner l'un de ces statuts par rapport à la branche principale (`origin/HEAD`, sinon `main`, `master` ou `develop`) :
- **fusionnée** : ses commits sont déjà dans la branche principale ;
- **squashée** : la branche principale contient un commit au contenu identique ;
- **non fusionnée** : ni l'un ni l'autre.

#### Scenario: Squash merge
- **WHEN** une branche « gone » a été intégrée par squash merge
- **THEN** elle a le statut « squashée » et elle est proposée à la suppression

#### Scenario: Branche non fusionnée
- **WHEN** une branche « gone » contient des commits absents de la branche principale
- **THEN** elle a le statut « non fusionnée » et elle n'est pas sélectionnée par défaut

### Requirement: Branches protégées
La branche courante, la branche principale et toute branche extraite dans un worktree MUST NOT être proposées à la suppression, sauf si ce worktree est supprimé dans la même opération.

#### Scenario: Branche extraite dans un worktree
- **WHEN** une branche « gone » est extraite dans un worktree qu'on garde
- **THEN** elle n'est pas proposée à la suppression

### Requirement: Simulation par défaut
L'analyse git MUST être en lecture seule. Elle affiche, par dépôt, les branches qui seraient supprimées et l'espace récupérable estimé. Le réseau n'est sollicité (`fetch --prune`) que si l'utilisateur le demande.

#### Scenario: Analyse sans application
- **WHEN** l'utilisateur lance l'analyse git
- **THEN** aucune branche n'est supprimée, aucun `gc` n'est lancé et aucun appel réseau n'est fait

### Requirement: Application confirmée et traçable
L'application SHALL exiger une confirmation qui récapitule les dépôts, les branches et les options. Avant chaque suppression, Cairn MUST écrire le nom et le SHA de la branche dans `.git/cleanup-deleted-branches.log` du dépôt. Dans l'app, les branches non fusionnées ne sont supprimées que si l'utilisateur les a cochées une par une.

#### Scenario: Récupération d'une branche supprimée
- **WHEN** une branche a été supprimée sans prune immédiat
- **THEN** son nom et son SHA figurent dans `cleanup-deleted-branches.log`, et `git branch <nom> <sha>` la recrée

### Requirement: Optimisation
Après le nettoyage des branches, Cairn SHALL lancer `git gc` sur les dépôts choisis, sauf si l'utilisateur le désactive. L'option « libérer immédiatement » MUST expirer le reflog des objets inaccessibles et lancer le prune immédiatement, et elle est signalée comme empêchant la récupération des branches supprimées.

#### Scenario: Libération immédiate
- **WHEN** l'utilisateur applique avec « libérer immédiatement »
- **THEN** l'espace des branches supprimées est rendu tout de suite, et la confirmation a prévenu que leur récupération ne serait plus possible

### Requirement: Rapport
Chaque analyse SHALL produire un rapport exportable (TSV) avec, par branche, le dépôt, le nom, le statut, le SHA, la date du dernier commit et le sujet, ainsi qu'un récapitulatif global (dépôts, taille totale des `.git`, espace récupérable, branches supprimées et gardées).

#### Scenario: Export du rapport
- **WHEN** l'utilisateur exporte le rapport
- **THEN** le fichier TSV contient une ligne par branche « gone » avec les colonnes décrites

### Requirement: Inventaire des worktrees
Pour chaque dépôt, Cairn SHALL lister ses worktrees, y compris ceux créés par des outils (par exemple `.claude/worktrees/`), avec :
- leur chemin et leur branche ;
- leur taille, régénérable comprise ;
- la date de leur dernière modification ;
- leur état : modifications non commitées, fichiers non suivis, commits non poussés.

#### Scenario: Worktree d'agent
- **WHEN** un dépôt a un worktree dans `.claude/worktrees/feature-x`
- **THEN** il apparaît sous ce dépôt avec sa branche, sa taille et son état

### Requirement: Détection des worktrees obsolètes
Un worktree SHALL être signalé comme obsolète dans l'un de ces cas :
- **orphelin** : son dossier n'existe plus ;
- **fusionné** : sa branche est fusionnée ou squashée dans la branche principale, ou bien « gone » ;
- **inactif** : sans modification depuis un nombre de jours configurable (30 par défaut).

Un worktree avec des modifications non commitées, des fichiers non suivis ou des commits non poussés MUST être signalé « à risque » et n'est jamais présélectionné.

#### Scenario: Worktree orphelin
- **WHEN** le dossier d'un worktree a été supprimé à la main
- **THEN** il est signalé « orphelin » et son nettoyage ne fait que retirer l'entrée de git

#### Scenario: Worktree propre et fusionné
- **WHEN** la branche d'un worktree sans modifications a été squashée dans `main`
- **THEN** il est signalé « fusionné », présélectionné, et l'espace récupérable inclut ses `node_modules`

#### Scenario: Worktree avec du travail en cours
- **WHEN** un worktree inactif depuis 60 jours contient des modifications non commitées
- **THEN** il est signalé « à risque », non présélectionné, et sa suppression demande de cocher une confirmation dédiée

### Requirement: Suppression des worktrees
La suppression d'un worktree SHALL passer par git, qui retire le dossier et l'entrée du worktree, puis proposer de supprimer sa branche si elle est fusionnée. Avant la suppression, Cairn MUST écrire le chemin, la branche et le SHA du worktree dans `cleanup-deleted-branches.log`, en simulation par défaut comme pour les branches.

#### Scenario: Suppression puis récupération de la branche
- **WHEN** un worktree fusionné et sa branche sont supprimés sans prune immédiat
- **THEN** le journal contient le chemin, la branche et le SHA, et `git branch <nom> <sha>` recrée la branche
