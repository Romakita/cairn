# Spec Delta

## Purpose

Sauvegarde et restaure les conversations, la configuration et les mémoires des outils IA (Claude Code, Claude Desktop et Codex pour commencer). On choisit ce qu'on garde par outil, on obtient des copies cohérentes, et un nouvel outil s'ajoute sans modifier le moteur.

## ADDED Requirements

### Requirement: Profils d'outils IA
Chaque outil pris en charge SHALL être décrit par un profil déclaratif. Le profil donne :
- l'emplacement des données de l'outil ;
- la catégorie de chaque chemin : conversations, configuration, mémoires ou identifiants ;
- les bases SQLite ;
- les chemins exclus (caches, journaux, fichiers temporaires) ;
- les éléments à réinstaller plutôt qu'à copier.

Les profils Claude Code, Claude Desktop et Codex MUST être fournis dans cette version. Ajouter un outil MUST se limiter à ajouter un profil.

#### Scenario: Outil absent
- **WHEN** Codex n'est pas installé (pas de `~/.codex`)
- **THEN** il est affiché comme « non détecté » et la sauvegarde l'ignore sans erreur

#### Scenario: Profil ajouté
- **WHEN** un profil pour un nouvel outil est ajouté aux ressources de Cairn
- **THEN** l'outil apparaît dans la vue IA avec ses catégories, sans aucune autre modification du code de sauvegarde

### Requirement: Sélection par outil et par catégorie
Pour chaque outil détecté, l'utilisateur SHALL choisir les catégories à sauvegarder : conversations, configuration, mémoires et identifiants. Les conversations, la configuration et les mémoires sont cochées par défaut. Les choix sont enregistrés dans `config.toml`.

#### Scenario: Configuration seulement
- **WHEN** l'utilisateur ne coche que « configuration » pour Codex
- **THEN** la sauvegarde contient `config.toml`, `AGENTS.md`, `hooks.json` et les profils de Codex, mais pas `sessions/` ni les bases d'historique

### Requirement: Identifiants seulement sur destination chiffrée
La catégorie « identifiants » (par exemple `~/.codex/auth.json`, `~/.codex/.credentials.json`) MUST être cochée par défaut uniquement si toutes les destinations de la sauvegarde sont chiffrées. Si l'utilisateur la coche avec une destination non chiffrée, Cairn SHALL afficher un avertissement et demander une confirmation. Les identifiants rangés par un outil dans le Trousseau macOS ne sont pas sauvegardés, et l'app l'indique.

#### Scenario: Destination non chiffrée
- **WHEN** une destination de la sauvegarde n'est pas chiffrée
- **THEN** « identifiants » est décoché par défaut pour tous les outils

#### Scenario: Jeton dans le Trousseau
- **WHEN** l'outil range son jeton dans le Trousseau macOS (cas de Claude Code)
- **THEN** la vue IA indique qu'une reconnexion sera nécessaire après restauration

### Requirement: Copies cohérentes
Les bases SQLite d'un outil MUST être copiées par snapshot cohérent, jamais par copie brute de fichiers en cours d'écriture. Les fichiers `-wal` et `-shm` ne sont pas copiés. Si l'outil est ouvert au moment de la sauvegarde, Cairn SHALL le noter dans le journal et faire quand même le snapshot.

#### Scenario: Codex ouvert
- **WHEN** Codex écrit dans `thread_history_1.sqlite` pendant la sauvegarde
- **THEN** la copie sauvegardée passe `PRAGMA integrity_check` et le journal indique que Codex était ouvert

### Requirement: Plugins et paquets réinstallés plutôt que copiés
Les plugins, paquets et caches des outils (par exemple `~/.codex/packages`, `~/.codex/plugins`, `~/.claude/plugins`) MUST NOT être copiés. Cairn SHALL sauvegarder la liste des plugins et des sources de plugins déclarés dans la configuration de l'outil, pour les réinstaller.

#### Scenario: Plugins Codex
- **WHEN** Codex a 466 Mo de plugins installés
- **THEN** la sauvegarde ne contient pas ces fichiers mais la liste des plugins déclarés

### Requirement: Pas de double copie avec le home
Les dossiers gérés par un profil d'outil IA MUST être exclus de la sélection du home. Ils ne sont sauvegardés qu'à travers la partie IA.

#### Scenario: ~/.claude sélectionné dans le home
- **WHEN** l'utilisateur a aussi coché `~/.claude` dans la sélection du home
- **THEN** son contenu n'est copié qu'une fois, dans la partie IA, selon les catégories choisies

### Requirement: Vue des outils IA
Cairn SHALL afficher, pour chaque outil détecté :
- la taille par catégorie ;
- le nombre de conversations et la date de la plus récente ;
- la taille de ce qui sera sauvegardé ;
- la date de la dernière sauvegarde réussie de l'outil.

#### Scenario: Consultation
- **WHEN** l'utilisateur ouvre la vue IA
- **THEN** il voit Claude Code, Claude Desktop et Codex avec leurs tailles par catégorie et leur nombre de conversations

### Requirement: Restauration par fusion
La restauration des conversations SHALL fusionner les données au lieu de remplacer le dossier entier. Une conversation absente localement est ajoutée. Une conversation qui existe des deux côtés garde la version la plus récente, et l'autre est conservée avec le suffixe `.pre-restore`. Cairn MUST demander de quitter l'outil concerné avant d'écrire ses données.

#### Scenario: Conversations locales plus récentes
- **WHEN** une conversation locale est plus récente que sa version sauvegardée
- **THEN** la version locale est gardée et la version sauvegardée est écrite à côté avec le suffixe `.pre-restore`

#### Scenario: Outil ouvert
- **WHEN** Codex est ouvert au moment de restaurer ses données
- **THEN** Cairn attend qu'il soit quitté, ou que l'utilisateur passe cet outil

### Requirement: Réécriture des chemins de projets
Quand le chemin du home ou d'un dossier suivi diffère entre la machine d'origine et la cible, Cairn SHALL renommer les dossiers de conversations de Claude Code qui encodent le chemin du projet (`~/.claude/projects/-Volumes-workspaces-…`) pour qu'ils correspondent aux nouveaux chemins. Il MUST signaler les données d'outils dont les chemins ne peuvent pas être réécrits.

#### Scenario: Workspace restauré ailleurs
- **WHEN** `/Volumes/workspaces` est restauré dans `~/workspaces`
- **THEN** le dossier `-Volumes-workspaces-exports` devient `-Users-<nom>-workspaces-exports`, et Claude Code retrouve les conversations du projet
