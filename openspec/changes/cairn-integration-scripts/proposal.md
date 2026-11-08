# Proposal

## Why

La sauvegarde, la restauration et le nettoyage git du Mac reposent sur trois scripts bash (`scripts/backup.sh`, `scripts/restore.sh`, `scripts/git-cleanup.sh`). Leurs chemins sont figés (`/Volumes/workspaces`), ils se lancent à la main depuis un terminal et ne savent écrire que dans un dossier local. L'app « Workspace Storage » montre déjà ce qui occupe le disque, mais elle est séparée de ces outils. Ce changement réunit le tout dans une seule app macOS, **Cairn** :
- elle est configurée une fois ;
- elle sauvegarde vers un NAS Synology, puis vers d'autres stockages en ligne ;
- elle permet de remonter une nouvelle machine sans passer par le terminal.

## What Changes

- **BREAKING** L'app « Workspace Storage » devient **Cairn** (bundle `fr.lenzotti.cairn`, `~/Applications/Cairn.app`), et son dossier `WorkspaceStorage/` est renommé `Cairn/`.
- **Configuration** : un fichier `~/.cairn/config.toml`, sur le modèle de `~/.codex/config.toml`. Il décrit les dossiers suivis, les éléments du home à sauvegarder, les destinations, la planification et les préférences git. Au premier lancement, un assistant guide la configuration. Le fichier reste modifiable à la main ou depuis les réglages de l'app.
- **Analyse** : elle porte sur tous les dossiers configurés, et non plus sur le seul `/Volumes/workspaces`. Elle repère les gros objets (gros fichiers, et gros dossiers faits de nombreux petits fichiers), les gros projets (dépôts et racines de projet, worktrees compris) et les dossiers régénérables.
- **Sauvegarde** : les dossiers configurés et une sélection du home choisie par l'utilisateur sont copiés vers une ou plusieurs destinations.
  - Fournisseurs : dossier local ou disque externe, et NAS Synology en SMB dès cette version. Une interface de fournisseur permettra d'ajouter des drives en ligne (Google Drive, iCloud Drive, OneDrive…) plus tard.
  - Les sauvegardes sont versionnées, avec une rétention par paliers simple à régler : par défaut, toutes les versions des 30 derniers jours, puis une par semaine pendant un an.
  - Le chiffrement est activé par défaut dans une image disque chiffrée.
  - Un contrôle d'intégrité par empreintes SHA-256 vérifie les versions chaque mois, ou à la demande.
  - Une sauvegarde interrompue reprend là où elle s'était arrêtée.
  - Les sauvegardes planifiées tournent en tâche de fond, si l'utilisateur l'accepte au premier lancement, et seulement quand le Mac est éveillé. Une destination injoignable met la sauvegarde en attente jusqu'à son retour, avec une notification seulement après un jour de retard.
- **Outils IA** : sauvegarde et restauration dédiées des conversations, de la configuration (settings, `CLAUDE.md`/`AGENTS.md`, skills, hooks, MCP, `config.toml`), des mémoires et des identifiants de Claude Code, Claude Desktop et Codex. Chaque outil est décrit par un profil déclaratif, pour en ajouter d'autres plus tard. Les plugins et paquets ne sont pas copiés mais listés pour être réinstallés. À la restauration, les conversations sont fusionnées, et les chemins de projets Claude sont réécrits si les dossiers ont changé de place. Les identifiants ne sont sauvegardés par défaut que vers des destinations chiffrées.
- **Inventaire des outils en ligne de commande** : il liste les CLI installés (Homebrew, mise, npm global, uv, pipx, cargo, go, `~/.local/bin`) et précise la liste à l'aide des fichiers de configuration du home et de l'historique du shell. L'export est relisible pour une réinstallation. **BREAKING** Les applications graphiques (casks, `Brewfile.apps`) ne sont plus inventoriées.
- **Maintenance git** : `git-cleanup.sh` est porté dans l'app (branches « gone » fusionnées ou squashées, `git gc`, prune immédiat), avec en plus l'inventaire des worktrees et la détection de ceux qui sont obsolètes (orphelins, fusionnés, inactifs). L'app reste en simulation par défaut, demande une confirmation explicite avant d'appliquer et journalise les SHA supprimés.
- **Restauration** : l'app choisit une sauvegarde sur une destination, sélectionne les parties à restaurer (outils, home, dossiers, conversations IA) et réinstalle les CLI de l'inventaire. Elle conserve les fichiers écrasés avec le suffixe `.pre-restore` et sait relire les sauvegardes produites par `backup.sh`.
- **Barre des menus** : une icône permanente, comme pour Slack, ouvre un panneau qui résume le stockage (jauges des volumes, espace récupérable, état des sauvegardes) et donne les actions courantes. Sa présentation s'inspire de CleanMyMac.
- **Alertes de disque plein** : des notifications intelligentes signalent un volume presque plein ou qui se remplit vite. Elles ne harcèlent pas (une par jour au plus, sauf passage critique) et proposent directement le nettoyage.
- **Journaux** : les journaux de plus de 90 jours sont supprimés automatiquement.
- **Langues** : l'app et la commande `cairn` sont disponibles en anglais (en-US) et en français (fr-FR). Elles suivent la langue de macOS ou une langue imposée dans `config.toml`. Les fichiers, sauvegardes et sorties JSON ne dépendent pas de la langue.
- **Interface en ligne de commande** : le même binaire répond à `cairn analyze | backup | verify | restore | tools | ai | git` pour l'automatisation et les vérifications.
- **BREAKING** `scripts/backup.sh`, `scripts/restore.sh` et `scripts/git-cleanup.sh` sont retirés une fois la parité atteinte. Les recettes `just` appellent alors `cairn`.

## Capabilities

### New Capabilities
- `app-configuration` : le fichier `~/.cairn/config.toml` (schéma, valeurs par défaut, validation, migration), l'assistant de premier lancement et l'écran de réglages.
- `storage-analysis` : l'analyse de l'occupation des dossiers configurés, avec classement par type, gros fichiers, gros projets, dossiers régénérables et nettoyage confirmé.
- `backup` : la sauvegarde des dossiers et de la sélection du home vers des destinations (fournisseurs extensibles, chiffrement, versions, rétention, planification, journal et manifest).
- `ai-tools` : la sauvegarde et la restauration des conversations, de la configuration, des mémoires et des identifiants des outils IA, par profils d'outils et catégories.
- `tool-inventory` : la détection, l'affinage et l'export des outils en ligne de commande à réinstaller.
- `git-maintenance` : l'analyse et le nettoyage des dépôts git (branches « gone », gc, prune), avec simulation et traçabilité.
- `restore` : la restauration sélective d'une sauvegarde et la réinstallation des outils sur une machine neuve ou existante.
- `menu-bar` : l'icône de la barre des menus, le panneau de résumé du stockage et des sauvegardes, et les actions rapides.
- `storage-alerts` : la surveillance de l'espace libre des volumes suivis, les seuils, la prévision de remplissage et les notifications de disque plein.
- `localization` : les langues prises en charge (en-US, fr-FR), le choix de la langue, les formats régionaux et l'indépendance des données vis-à-vis de la langue.
- `command-line` : la commande `cairn` et ses sous-commandes, codes de sortie et sorties lisibles par une machine.

### Modified Capabilities
_Aucune : `openspec/specs/` est vide, aucun comportement n'est encore spécifié._

## Impact

- **Code** : `WorkspaceStorage/` est renommé et restructuré en `Cairn/`, avec des modules Analyse, Sauvegarde, Restauration, Outils, Git, Configuration et CLI. `scripts/*.sh` sont supprimés à la fin, et `justfile`, `README.md` et `AGENTS.md` sont mis à jour.
- **Dépendances** : aucune dépendance SwiftPM externe (le lecteur TOML est écrit dans le projet, voir `design.md`). Côté système : `rsync`, `git`, `hdiutil`, NetFS (montage SMB), `libsqlite3` et le Trousseau macOS (mots de passe du NAS et de l'image chiffrée). La compilation se fait toujours avec les seules Command Line Tools.
- **Interface** : nouvelle disposition inspirée de l'app Codex (barre d'icônes, barre latérale, sélecteur centré, cartes arrondies).
- **Données utilisateur** : création de `~/.cairn/` (configuration, journaux, état). Les sauvegardes existantes restent restaurables.
- **Sécurité** : le home contient des secrets (`.ssh`, `.aws`, tokens Claude et Codex). Le chiffrement est activé par défaut et les mots de passe ne figurent jamais dans `config.toml`.
- **Hors périmètre** : les fournisseurs de drives en ligne (seule l'interface est prévue), la sauvegarde quand l'app est fermée (pas d'agent launchd), la sauvegarde ou réinstallation des applications graphiques, et la distribution signée ou notarisée de l'app.
