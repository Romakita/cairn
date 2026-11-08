# Spec Delta

## Purpose

Allège les dépôts git des dossiers suivis : suppression des branches locales dont la branche distante a disparu, puis compactage. Le tout en simulation par défaut et en gardant de quoi annuler, comme le faisait `git-cleanup.sh`.

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

La branche courante et la branche principale MUST NOT être proposées.

#### Scenario: Squash merge
- **WHEN** une branche « gone » a été intégrée par squash merge
- **THEN** elle a le statut « squashée » et elle est proposée à la suppression

#### Scenario: Branche non fusionnée
- **WHEN** une branche « gone » contient des commits absents de la branche principale
- **THEN** elle a le statut « non fusionnée » et elle n'est pas sélectionnée par défaut

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
