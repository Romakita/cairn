# Spec Delta

## Purpose

Montre ce qui occupe l'espace dans les dossiers configurés (gros fichiers, gros projets, dossiers régénérables) pour décider quoi nettoyer, sans jamais modifier le disque pendant l'analyse.

## ADDED Requirements

### Requirement: Analyse des dossiers configurés
Cairn SHALL analyser chacun des dossiers suivis de `config.toml` et afficher, par dossier et au total, la taille occupée sur disque et le nombre de fichiers. Un fichier qui a plusieurs liens physiques MUST n'être compté qu'une fois. L'analyse ne franchit pas les points de montage.

#### Scenario: Deux dossiers suivis
- **WHEN** `config.toml` suit `/Volumes/workspaces` et `~/Projets`
- **THEN** Cairn affiche la taille de chacun et leur total, et chaque total est à 1 % près de `du -sk` sur le même dossier

#### Scenario: Fichiers liés par pnpm
- **WHEN** un même fichier est lié dans plusieurs `node_modules`
- **THEN** sa taille n'est comptée qu'une fois dans le total

### Requirement: Lecture seule pendant l'analyse
L'analyse MUST NOT créer, modifier ni supprimer de fichier dans les dossiers analysés.

#### Scenario: Analyse d'un dossier
- **WHEN** une analyse se termine
- **THEN** aucune date de modification ni aucun contenu n'a changé dans le dossier analysé

### Requirement: Classement par type de contenu
Cairn SHALL répartir l'espace entre ces types : sources, historique git, dépendances, builds, iOS/Xcode, Python, caches et corbeille du volume. Les noms génériques (`build`, `out`, `target`, `vendor`, `.build`, `.gradle`) MUST n'être classés régénérables qu'à côté d'un fichier de projet correspondant.

#### Scenario: Dossier build sans projet
- **WHEN** un dossier `build/` se trouve à côté d'aucun `package.json`, `build.gradle`, `CMakeLists.txt` ni `pubspec.yaml`
- **THEN** il est compté comme sources

#### Scenario: .build de SwiftPM
- **WHEN** un dossier `.build/` est à côté d'un `Package.swift`
- **THEN** il est compté comme build régénérable

### Requirement: Gros objets : fichiers et dossiers
Cairn SHALL lister les gros objets, triés par taille, avec leur chemin et leur type :
- **gros fichiers** : un fichier dont la taille dépasse un seuil configurable (50 Mo par défaut) ;
- **gros dossiers** : un dossier qui occupe plus d'un seuil configurable (1 Go par défaut) sans compter les gros fichiers déjà listés, quand aucun de ses sous-dossiers n'atteint ce seuil à lui seul.

On signale ainsi le dossier le plus précis où beaucoup de petits fichiers s'accumulent.

#### Scenario: Fichier de 2 Go
- **WHEN** un fichier de 2 Go se trouve dans un dossier suivi
- **THEN** il apparaît comme gros fichier avec son chemin

#### Scenario: Beaucoup de petits fichiers
- **WHEN** `fixtures/` contient 40 000 fichiers de 50 Ko (2 Go) répartis dans des sous-dossiers de 200 Mo chacun
- **THEN** `fixtures/` apparaît comme gros dossier, mais ni ses sous-dossiers ni son dossier parent

#### Scenario: Dossier dont la taille vient d'un gros fichier
- **WHEN** un dossier de 1,5 Go doit 1,4 Go à un seul fichier
- **THEN** seul le fichier est listé, pas le dossier

### Requirement: Gros projets
Cairn SHALL lister les projets (dépôts git, ou dossiers contenant un fichier de projet reconnu) triés par taille. Pour chacun, il indique la part de sources, de `.git` et de régénérable, ainsi que la taille de ses worktrees, rattachés au dépôt d'origine plutôt que listés comme des projets distincts.

#### Scenario: Dépôt avec node_modules
- **WHEN** un dépôt de 3 Go contient 2,5 Go de `node_modules`
- **THEN** la liste des projets l'affiche avec 2,5 Go régénérables

#### Scenario: Projet avec worktrees
- **WHEN** un dépôt de 2 Go a trois worktrees de 1 Go dans `.claude/worktrees/`
- **THEN** la liste l'affiche comme un seul projet de 5 Go, dont 3 Go de worktrees, avec un lien vers la maintenance git

### Requirement: Nettoyage confirmé
Cairn SHALL permettre de mettre à la corbeille ou de supprimer définitivement des éléments choisis dans l'analyse. Chaque opération MUST d'abord afficher une confirmation qui liste les chemins et la taille. Le choix proposé par défaut est la corbeille, et la suppression définitive est signalée comme irréversible.

#### Scenario: Annulation
- **WHEN** l'utilisateur annule la confirmation
- **THEN** aucun fichier n'est touché

#### Scenario: Mise à la corbeille
- **WHEN** l'utilisateur confirme la mise à la corbeille de trois `node_modules`
- **THEN** ils sont déplacés dans la corbeille, les totaux sont mis à jour sans nouvelle analyse, et un message rappelle que l'espace est libéré une fois la corbeille vidée

### Requirement: Progression et annulation
Pendant une analyse, Cairn SHALL afficher le nombre de fichiers et d'octets parcourus et le chemin en cours, et permettre d'arrêter l'analyse à tout moment.

#### Scenario: Arrêt en cours d'analyse
- **WHEN** l'utilisateur arrête une analyse en cours
- **THEN** l'analyse s'arrête en moins de 2 secondes et le résultat précédent reste affiché
