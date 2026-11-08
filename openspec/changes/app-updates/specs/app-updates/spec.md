# Spec Delta

## Purpose

Prévient l'utilisateur qu'une nouvelle version de Cairn est publiée et l'installe à sa demande, sans quitter l'app, à la manière de Codex.

## ADDED Requirements

### Requirement: Détection d'une nouvelle version
L'app SHALL lire la dernière release publiée du dépôt GitHub de Cairn au lancement puis toutes les 6 heures, tant que `updates.check` vaut `true` (valeur par défaut). Une release est proposée seulement si sa version est strictement supérieure à la version installée et si elle contient l'archive de l'architecture du Mac et son fichier `.sha256`. La ligne de commande `cairn` MUST NOT faire d'appel réseau pour les mises à jour.

#### Scenario: Nouvelle version publiée
- **WHEN** Cairn 0.1.1 tourne sur un Mac arm64 et que la release `v0.2.0` contient `Cairn-0.2.0-arm64.zip` et `Cairn-0.2.0-arm64.zip.sha256`
- **THEN** la mise à jour 0.2.0 est proposée

#### Scenario: Déjà à jour
- **WHEN** la dernière release est `v0.1.1` et que Cairn 0.1.1 tourne
- **THEN** rien n'est proposé

#### Scenario: Contrôle désactivé
- **WHEN** `config.toml` contient `[updates] check = false`
- **THEN** aucun contrôle automatique n'a lieu, mais « Rechercher les mises à jour… » reste disponible

### Requirement: Proposition dans le rail
Quand une mise à jour est disponible, l'app SHALL afficher un bouton à l'accent de l'app en bas de la barre d'icônes, au-dessus de la pastille d'état, avec l'infobulle « Mise à jour disponible ». Le bouton ouvre un panneau qui montre la version installée, la nouvelle version, les notes de version et les actions « Installer et relancer », « Voir la release » et « Plus tard ».

#### Scenario: Ouverture du panneau
- **WHEN** l'utilisateur clique sur le bouton de mise à jour
- **THEN** le panneau affiche « 0.1.1 → 0.2.0 » et les notes de la release

#### Scenario: Contrôle manuel sans nouveauté
- **WHEN** l'utilisateur choisit « Rechercher les mises à jour… » et que Cairn est à jour
- **THEN** un message indique que Cairn est à jour avec sa version

### Requirement: Installation vérifiée et relance
« Installer et relancer » SHALL télécharger l'archive, MUST vérifier son SHA-256 et que l'app extraite a l'identifiant `fr.lenzotti.cairn` et la version annoncée, puis remplacer le bundle en place après la fermeture de l'app et la relancer. Si une vérification échoue, rien n'est remplacé et l'erreur s'affiche dans le panneau. Si le remplacement échoue, l'ancienne app MUST être remise en place.

#### Scenario: Archive altérée
- **WHEN** le SHA-256 de l'archive téléchargée ne correspond pas au fichier `.sha256`
- **THEN** l'installation s'arrête avec une erreur et `Cairn.app` n'est pas modifiée

#### Scenario: Mise à jour réussie
- **WHEN** l'archive est valide
- **THEN** Cairn se ferme, `~/Applications/Cairn.app` est remplacée par la version 0.2.0 et l'app se relance

### Requirement: Garde-fous de l'installation
L'installation MUST être refusée pendant une sauvegarde. Quand l'app ne tourne pas depuis un bundle `.app` dont le dossier parent est modifiable, « Installer et relancer » SHALL être remplacé par l'ouverture de la page de la release.

#### Scenario: Sauvegarde en cours
- **WHEN** une sauvegarde tourne et que l'utilisateur ouvre le panneau
- **THEN** « Installer et relancer » est désactivé avec l'explication

### Requirement: Réglage des mises à jour
`config.toml` SHALL accepter la table `[updates]` avec la clé booléenne `check` (`true` par défaut). Les réglages de l'app SHALL afficher la version installée et une case pour ce réglage.

#### Scenario: Case décochée
- **WHEN** l'utilisateur décoche « Rechercher automatiquement les mises à jour »
- **THEN** `config.toml` contient `check = false` dans `[updates]`, commentaires conservés
