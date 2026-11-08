# Spec Delta

## Purpose

Rend les fonctions de Cairn utilisables depuis un terminal ou un script (`just`, CI, vérifications d'agents), avec les mêmes règles de sécurité que l'app et des sorties lisibles par une machine.

## ADDED Requirements

### Requirement: Commande cairn
Le binaire de l'app SHALL répondre en mode ligne de commande, sans ouvrir de fenêtre, aux sous-commandes `analyze`, `backup`, `restore`, `tools`, `ai`, `git` et `config`. Cairn SHALL fournir un lien `cairn` installable dans `~/.local/bin`. `cairn --help` et `cairn <sous-commande> --help` décrivent les options en français.

#### Scenario: Aide
- **WHEN** l'utilisateur lance `cairn --help`
- **THEN** la liste des sous-commandes s'affiche, sans fenêtre, avec un code de sortie 0

### Requirement: Même configuration que l'app
Le mode ligne de commande MUST utiliser `~/.cairn/config.toml`. L'option `--config <fichier>` permet d'en utiliser un autre. Les options passées en ligne de commande priment sur le fichier, uniquement pour l'exécution en cours.

#### Scenario: Dossier passé en option
- **WHEN** l'utilisateur lance `cairn analyze ~/Projets`
- **THEN** seul `~/Projets` est analysé, et `config.toml` n'est pas modifié

### Requirement: Simulation par défaut pour les opérations destructives
`cairn git` et `cairn restore` MUST être en simulation sans l'option `--apply`. `cairn backup --dry-run` SHALL simuler la sauvegarde. Aucune commande ne demande de confirmation interactive quand `--yes` est passé.

#### Scenario: Nettoyage git sans --apply
- **WHEN** l'utilisateur lance `cairn git`
- **THEN** le rapport s'affiche et aucune branche n'est supprimée

### Requirement: Sorties et codes de sortie
Chaque sous-commande SHALL accepter `--json` pour une sortie structurée sur la sortie standard. Les messages de progression vont sur la sortie d'erreur. Le code de sortie est 0 en cas de succès, 1 en cas d'échec et 2 en cas d'erreur d'usage ou de configuration.

#### Scenario: Configuration invalide
- **WHEN** `config.toml` est invalide et l'utilisateur lance `cairn backup`
- **THEN** l'erreur est affichée sur la sortie d'erreur et le code de sortie est 2

#### Scenario: Analyse en JSON
- **WHEN** l'utilisateur lance `cairn analyze --json`
- **THEN** la sortie standard contient un JSON valide avec la taille de chaque dossier et sa répartition par type

### Requirement: Pas d'exécution concurrente
Une sauvegarde ou une restauration lancée en ligne de commande MUST refuser de démarrer si une autre est déjà en cours, dans l'app ou dans un autre terminal.

#### Scenario: Sauvegarde déjà lancée par l'app
- **WHEN** l'app sauvegarde et l'utilisateur lance `cairn backup`
- **THEN** la commande s'arrête avec un message et le code 1

### Requirement: Commande ai
`cairn ai` SHALL lister les outils IA détectés avec leur taille par catégorie et les catégories retenues. `cairn backup --only ai` et `cairn restore --parts ai` limitent la sauvegarde et la restauration à la partie IA, éventuellement à un outil avec `--tool <id>`.

#### Scenario: Sauvegarde des seules données IA
- **WHEN** l'utilisateur lance `cairn backup --only ai --tool codex`
- **THEN** seule la partie Codex est sauvegardée dans une nouvelle version
