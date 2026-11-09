# Spec Delta

## Purpose

Définit comment Cairn est distribué, installé et mis à jour, et garantit qu'une nouvelle version reprend les données, les secrets et les sauvegardes de la précédente sans intervention.

## ADDED Requirements

### Requirement: Archive de distribution
Chaque release SHALL publier une archive `Cairn-<version>-<arch>.zip` (`arch` = `arm64`, ou `x86_64` si publié) contenant `Cairn.app` à sa racine, avec l'identifiant `fr.lenzotti.cairn`, la version de la release, et un fichier `.zip.sha256` à côté.

#### Scenario: Mise à jour depuis la version Swift
- **WHEN** l'app 0.8.x détecte la première release de la nouvelle version
- **THEN** elle télécharge, vérifie et installe l'archive, et la nouvelle app se relance avec la configuration existante

### Requirement: Signature et lancement
L'app SHALL être signée (ad hoc sans compte développeur) pour se lancer sur Apple Silicon. Les options d'exécution qui permettraient d'utiliser l'app comme interpréteur de code arbitraire MUST être désactivées dans l'app publiée.

#### Scenario: Exécutable détourné
- **WHEN** quelqu'un lance l'exécutable de l'app avec une variable d'environnement demandant un mode interpréteur
- **THEN** l'app ignore la demande et ne lance pas le code fourni

### Requirement: Même exécutable pour l'app et la commande
L'exécutable de l'app MUST répondre en ligne de commande quand son premier argument est une commande Cairn, sans fenêtre ni icône dans le Dock, y compris quand l'app est déjà ouverte. Un lien `~/.local/bin/cairn` vers cet exécutable, déjà installé ou créé à l'installation, SHALL continuer de fonctionner après une mise à jour.

#### Scenario: Lien existant après mise à jour
- **WHEN** l'utilisateur lance `cairn --version` par son lien existant après la mise à jour
- **THEN** la nouvelle version s'affiche sur la sortie standard, sans autre texte, avec le code 0

#### Scenario: Commande pendant que l'app est ouverte
- **WHEN** l'app est ouverte et l'utilisateur lance `cairn analyze --json`
- **THEN** la commande s'exécute et rend la main, sans ouvrir de fenêtre ni quitter l'app

### Requirement: Reprise des données de la version précédente
Une nouvelle version MUST relire sans migration manuelle `config.toml`, l'état et les journaux de `~/.cairn`, les sauvegardes existantes (images, versions, manifests, empreintes) et les entrées du Trousseau écrites par la version précédente. Elle MUST écrire ces fichiers dans un format que la version précédente sait relire.

#### Scenario: Sauvegarde existante reconnue
- **WHEN** la nouvelle version ouvre une destination sauvegardée par la version précédente
- **THEN** l'image de ce Mac et l'historique des versions sont reconnus, et la sauvegarde suivante crée une nouvelle version dans la même image

#### Scenario: Retour à la version précédente
- **WHEN** l'utilisateur réinstalle la version précédente après avoir utilisé la nouvelle
- **THEN** la version précédente relit `config.toml` et l'état sans erreur

### Requirement: Application de test hors du dépôt
Chaque release MUST passer un test de fumée de l'app empaquetée, lancée depuis un dossier hors du dépôt : version, aide en français et en anglais, sorties JSON, puis lancement de l'interface sans plantage.

#### Scenario: Ressources absentes
- **WHEN** l'app empaquetée est lancée hors du dépôt de sources
- **THEN** elle démarre avec ses traductions et ses ressources, sans chercher de fichier dans le dépôt
