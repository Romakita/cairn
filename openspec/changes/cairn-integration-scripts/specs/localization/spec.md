# Spec Delta

## Purpose

Rend Cairn utilisable en anglais (en-US) et en français (fr-FR), dans l'app comme en ligne de commande, avec des dates, nombres et tailles au format de la langue, sans que la langue change les fichiers ni les sorties lues par des machines.

## ADDED Requirements

### Requirement: Langues prises en charge
Cairn SHALL être entièrement traduit en en-US et en fr-FR : interface, assistant, notifications, messages d'erreur, confirmations, aide et messages de la ligne de commande. Les textes visibles par l'utilisateur MUST NOT être codés en dur dans une seule langue.

#### Scenario: Interface en anglais
- **WHEN** Cairn s'affiche en en-US
- **THEN** tous les écrans, confirmations et notifications sont en anglais

#### Scenario: Aide en français
- **WHEN** l'utilisateur lance `cairn backup --help` avec la langue fr-FR
- **THEN** l'aide de la sous-commande s'affiche en français

### Requirement: Choix de la langue
Par défaut, Cairn SHALL suivre la langue préférée de macOS : fr-FR si le français est la première langue prise en charge dans les préférences du système, en-US sinon. L'utilisateur MUST pouvoir l'imposer avec la clé `language` de `config.toml` (`auto`, `en-US` ou `fr-FR`) ou depuis les réglages. La ligne de commande accepte aussi `--lang` pour l'exécution en cours.

#### Scenario: Système en allemand
- **WHEN** les langues préférées de macOS sont l'allemand puis l'anglais
- **THEN** Cairn s'affiche en en-US

#### Scenario: Langue imposée
- **WHEN** macOS est en français et `config.toml` contient `language = "en-US"`
- **THEN** l'app et la commande `cairn` s'affichent en anglais

#### Scenario: Changement depuis les réglages
- **WHEN** l'utilisateur change la langue dans les réglages
- **THEN** l'interface passe dans la nouvelle langue sans redémarrage de l'app

### Requirement: Formats régionaux
Les dates, heures, nombres, tailles et durées SHALL être formatés selon la langue active.

#### Scenario: Taille et date en fr-FR
- **WHEN** Cairn affiche une taille de 1 234 567 890 octets et une date en fr-FR
- **THEN** la taille s'écrit avec une virgule décimale et l'unité française (« 1,23 Go ») et la date au format jour/mois

#### Scenario: Taille en en-US
- **WHEN** la même taille est affichée en en-US
- **THEN** elle s'écrit « 1.23 GB »

### Requirement: Données indépendantes de la langue
La langue MUST NOT changer :
- les clés et valeurs de `config.toml` ;
- les noms de fichiers et de dossiers des sauvegardes ;
- les manifests ;
- les rapports TSV ;
- les clés et valeurs codées des sorties `--json`.

Les tailles y sont en octets, les dates en ISO 8601 et les statuts sont des identifiants stables. Une sauvegarde faite dans une langue SHALL se restaurer dans l'autre.

#### Scenario: JSON identique dans les deux langues
- **WHEN** `cairn git --json` est lancé en en-US puis en fr-FR sur les mêmes dépôts
- **THEN** les deux sorties sont identiques

#### Scenario: Restauration dans l'autre langue
- **WHEN** une sauvegarde faite avec Cairn en fr-FR est restaurée avec Cairn en en-US
- **THEN** la restauration fonctionne et toutes les parties sont reconnues

### Requirement: Complétude des traductions
Chaque texte de Cairn MUST exister dans les deux langues. Un texte absent dans la langue active SHALL s'afficher en en-US plutôt que sous forme de clé technique.

#### Scenario: Texte manquant en français
- **WHEN** un texte n'a pas encore de traduction française
- **THEN** il s'affiche en anglais, et la vérification des traductions du projet le signale comme manquant
