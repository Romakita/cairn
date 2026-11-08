# Spec Delta

## Purpose

Sauvegarde les dossiers suivis et la partie du home choisie par l'utilisateur vers une ou plusieurs destinations (NAS Synology, dossier local, puis drives en ligne), de façon chiffrée, versionnée et planifiée, en reprenant ce que faisait `backup.sh`.

## ADDED Requirements

### Requirement: Contenu d'une sauvegarde
Une sauvegarde SHALL contenir :
- les dossiers suivis activés pour la sauvegarde ;
- les éléments du home sélectionnés ;
- les données des outils IA sélectionnées (voir la capacité `ai-tools`) ;
- l'inventaire des outils ;
- un manifest (date, machine, architecture, version de macOS, version de Cairn, liste des parties).

#### Scenario: Sauvegarde complète
- **WHEN** une sauvegarde de `/Volumes/workspaces` et du home se termine
- **THEN** la destination contient ces dossiers, la partie `ai/` des outils IA, l'inventaire des outils et un manifest daté

### Requirement: Exclusions du contenu régénérable
La sauvegarde des dossiers MUST exclure les mêmes contenus régénérables que l'analyse (dépendances, builds, caches, environnements Python, métadonnées de volume). Dans un dépôt git, les dossiers génériques (`lib`, `build`, `out`, `target`, `tmp`, `vendor`) MUST n'être exclus que s'ils sont ignorés par le `.gitignore` du dépôt. L'utilisateur SHALL pouvoir ajouter ses propres motifs d'exclusion.

#### Scenario: Projet Node
- **WHEN** un projet contient `node_modules/` et `dist/`
- **THEN** ni l'un ni l'autre n'est copié

#### Scenario: Dossier lib versionné
- **WHEN** un dépôt git suit un dossier `lib/` qui n'est pas ignoré
- **THEN** `lib/` est copié

### Requirement: Sélection du home par l'utilisateur
L'utilisateur SHALL choisir les éléments du home à sauvegarder dans une liste d'éléments détectés (fichiers de configuration du shell, `~/.config/*`, `~/.ssh`, `~/.aws`, `~/.gitconfig`, configurations des outils IA…) ou par chemins libres. Rien d'autre du home n'est copié. Les caches et installations reconstructibles MUST être exclus même s'ils se trouvent dans un élément sélectionné.

#### Scenario: Sélection restreinte
- **WHEN** l'utilisateur sélectionne seulement `~/.zshrc`, `~/.ssh` et `~/.config/mise`
- **THEN** la sauvegarde du home ne contient que ces trois éléments

#### Scenario: Cache dans un dossier sélectionné
- **WHEN** l'utilisateur sélectionne `~/.config/gcloud`
- **THEN** ses sous-dossiers de cache et de journaux ne sont pas copiés

### Requirement: Destinations par fournisseur
Chaque destination SHALL être décrite par un type de fournisseur et ses paramètres. Dès cette version, les fournisseurs « dossier local / disque externe » et « NAS SMB » (Synology) MUST être disponibles. L'ajout d'un fournisseur de drive en ligne MUST se faire sans modifier le moteur de sauvegarde.

#### Scenario: NAS non monté
- **WHEN** une sauvegarde vise `smb://nas.local/backups` et le partage n'est pas monté
- **THEN** Cairn monte le partage avec les identifiants du Trousseau, sauvegarde, puis démonte ce qu'il a monté

#### Scenario: Destination injoignable
- **WHEN** le NAS ne répond pas
- **THEN** la sauvegarde échoue avec un message clair, aucune version partielle n'est marquée comme réussie et les autres destinations sont quand même traitées

### Requirement: Chiffrement
Une destination SHALL pouvoir être chiffrée (activé par défaut). Les données sont alors écrites dans une image disque chiffrée en AES-256 sur la destination, dont le mot de passe est dans le Trousseau. Sans chiffrement, Cairn MUST avertir que des secrets du home seront stockés en clair.

#### Scenario: Destination chiffrée
- **WHEN** une sauvegarde vers une destination chiffrée se termine
- **THEN** la destination ne contient qu'une image chiffrée, illisible sans le mot de passe

#### Scenario: Désactivation du chiffrement
- **WHEN** l'utilisateur désactive le chiffrement sur une destination alors que `~/.ssh` est sélectionné
- **THEN** Cairn affiche un avertissement et demande une confirmation explicite

### Requirement: Versions et rétention
Chaque sauvegarde réussie SHALL créer une version datée. Les fichiers inchangés depuis la version précédente ne sont pas recopiés et ne prennent pas de place en plus. Cairn MUST garder le nombre de versions configuré (7 par défaut) et supprimer les plus anciennes seulement après la réussite d'une nouvelle version.

#### Scenario: Huitième sauvegarde
- **WHEN** une 8ᵉ version réussit avec une rétention de 7
- **THEN** la plus ancienne version est supprimée et 7 versions restent

#### Scenario: Sauvegarde échouée
- **WHEN** une sauvegarde échoue
- **THEN** aucune version existante n'est supprimée

### Requirement: Planification tant que l'app est ouverte
Cairn SHALL lancer les sauvegardes selon la récurrence de `config.toml` (quotidienne à une heure donnée, hebdomadaire, ou manuelle) tant que l'app tourne, y compris fenêtre fermée grâce à son icône dans la barre des menus. Une échéance manquée pendant que l'app était fermée MUST déclencher une sauvegarde au prochain lancement. L'ouverture de Cairn à la connexion SHALL être une option.

#### Scenario: Échéance manquée
- **WHEN** la sauvegarde quotidienne de 12 h a été manquée parce que l'app était fermée et que l'app est lancée à 15 h
- **THEN** une sauvegarde démarre dans la minute

#### Scenario: Sauvegarde déjà en cours
- **WHEN** une échéance arrive alors qu'une sauvegarde est déjà en cours
- **THEN** aucune seconde sauvegarde n'est lancée

### Requirement: Simulation, progression et journal
Cairn SHALL proposer une simulation qui indique ce qui serait copié et sa taille sans rien écrire. Pendant une sauvegarde, il affiche la progression et permet l'annulation. Chaque exécution MUST écrire un journal dans `~/.cairn/logs/` et un état (succès, échec, durée, taille) consultable dans l'app.

#### Scenario: Simulation
- **WHEN** l'utilisateur lance une simulation
- **THEN** Cairn affiche le volume à copier par partie, et la destination n'est pas modifiée

#### Scenario: Notification d'échec
- **WHEN** une sauvegarde planifiée échoue
- **THEN** une notification macOS indique l'échec et donne accès au journal
