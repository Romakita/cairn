# restore Specification

## Purpose
Remet en place une sauvegarde sur un Mac neuf ou existant : réinstallation des outils, copie du home, des conversations IA et des dossiers. On choisit les parties à restaurer, et tout fichier écrasé est conservé. Reprend ce que faisait `restore.sh`.

## Requirements

### Requirement: Choix de la sauvegarde
Cairn SHALL lister les versions disponibles sur une destination configurée, ou dans un dossier choisi à la main. Pour chacune, il affiche la date, la machine d'origine, l'architecture et les parties présentes. Une destination chiffrée MUST demander son mot de passe s'il n'est pas dans le Trousseau.

#### Scenario: Nouveau Mac
- **WHEN** Cairn est lancé sur un Mac neuf et que l'utilisateur choisit « Restaurer une sauvegarde » dans l'assistant
- **THEN** il peut se connecter au NAS, choisir une version et voir son contenu avant de restaurer

#### Scenario: Architecture différente
- **WHEN** la version a été faite sur une architecture différente de celle de la machine
- **THEN** Cairn affiche un avertissement avant la restauration

### Requirement: Compatibilité avec les anciennes sauvegardes
Cairn MUST savoir restaurer une sauvegarde produite par `backup.sh` (dossiers `home/`, `workspaces/`, `ai/`, `manifest/`). Il en reprend les listes d'outils (`Brewfile`, `mise-config.toml`, `npm-globals.txt`, `uv-tools.txt`, `pipx.json`).

#### Scenario: Sauvegarde héritée
- **WHEN** l'utilisateur choisit un dossier produit par `backup.sh`
- **THEN** Cairn le reconnaît et propose les mêmes parties à restaurer

### Requirement: Restauration sélective
L'utilisateur SHALL choisir les parties à restaurer : outils, éléments du home, données de chaque outil IA (restaurées selon la capacité `ai-tools`), et chaque dossier suivi avec son emplacement cible. Avant d'écrire quoi que ce soit, Cairn MUST afficher un récapitulatif avec les tailles et demander une confirmation.

#### Scenario: Home seulement
- **WHEN** l'utilisateur ne coche que le home
- **THEN** seuls les éléments du home sont restaurés, et aucun outil n'est installé

#### Scenario: Dossier cible absent
- **WHEN** le dossier cible `/Volumes/workspaces` n'existe pas
- **THEN** Cairn propose de créer un volume APFS `workspaces` ou de choisir un autre emplacement

### Requirement: Conservation des fichiers écrasés
Un fichier existant remplacé par la restauration MUST être conservé à côté avec le suffixe `.pre-restore`. Cairn SHALL rétablir les droits restrictifs des secrets restaurés (`~/.ssh` en `700`, clés privées en `600`, fichiers d'authentification des outils IA en `600`).

#### Scenario: .zshrc existant
- **WHEN** `~/.zshrc` existe et diffère de la sauvegarde
- **THEN** l'ancien fichier est conservé en `~/.zshrc.pre-restore`

### Requirement: Réinstallation des outils
Cairn SHALL réinstaller les outils de l'inventaire dans cet ordre : Homebrew (formules et taps), mise, npm global, uv, pipx, puis cargo et go. Les outils déjà présents sont ignorés et chaque échec est journalisé sans arrêter les suivants. Une étape qui demande un mot de passe administrateur (installation de Homebrew ou des Command Line Tools) MUST s'ouvrir dans Terminal plutôt que de demander ce mot de passe dans l'app.

#### Scenario: Homebrew absent
- **WHEN** Homebrew n'est pas installé
- **THEN** Cairn ouvre Terminal avec la commande officielle d'installation, attend la fin de l'installation, puis reprend

#### Scenario: Échec d'un outil
- **WHEN** l'installation d'un paquet npm échoue
- **THEN** l'échec est noté et les outils suivants sont quand même installés

### Requirement: Vérification finale
À la fin d'une restauration, et à la demande, Cairn SHALL vérifier que chaque outil de l'inventaire est disponible et afficher la liste des manquants. Il rappelle aussi les actions manuelles : reconnexion à gh, claude, codex et docker, trousseau, et outils gérés par l'entreprise.

#### Scenario: Vérification seule
- **WHEN** l'utilisateur lance la vérification sans restauration
- **THEN** Cairn affiche les outils présents et manquants sans rien modifier
