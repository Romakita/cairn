# tool-inventory Specification

## Purpose
Recense les outils en ligne de commande installés sur la machine, pour les exporter puis les réinstaller sur un autre Mac. Les applications graphiques n'en font pas partie.

## Requirements

### Requirement: Détection des CLI installés
Cairn SHALL détecter les outils en ligne de commande installés avec :
- Homebrew (formules et taps, sans les casks) ;
- mise (outils et versions) ;
- npm global (dans le Node géré par mise) ;
- uv tools (avec extras et version de Python) ;
- pipx ;
- `cargo install` ;
- `go install` ;
- les exécutables de `~/.local/bin`.

Chaque outil indique sa source et sa version.

#### Scenario: Outil installé par uv
- **WHEN** `ruff` est installé avec `uv tool install ruff --python 3.12`
- **THEN** l'inventaire contient `ruff`, source `uv`, avec la version de Python 3.12

#### Scenario: Lien vers un environnement uv
- **WHEN** `~/.local/bin/ruff` est un lien vers un environnement uv
- **THEN** l'outil n'apparaît qu'une fois, avec la source `uv`

### Requirement: Exclusion des applications
L'inventaire MUST NOT contenir d'applications graphiques : ni casks Homebrew, ni contenu de `/Applications`, ni apps du Mac App Store.

#### Scenario: Cask installé
- **WHEN** `visual-studio-code` est installé en cask
- **THEN** il n'apparaît pas dans l'inventaire

### Requirement: Affinage par la configuration du home et l'usage
Cairn SHALL marquer comme « utilisé » un outil :
- qui a un fichier ou dossier de configuration dans le home (par exemple `~/.aws` → `aws`, `~/.kube` → `kubectl`, `~/.config/gh` → `gh`, `~/.npmrc` → `npm`) ;
- ou qui apparaît au moins 3 fois dans l'historique du shell ;
- ou qui est requis par un marqueur de projet dans les dossiers suivis (`justfile` → `just`, `pnpm-lock.yaml` → `pnpm`, `Cargo.toml` → `cargo`…).

Un outil requis mais absent MUST être signalé comme manquant.

#### Scenario: Configuration sans outil
- **WHEN** `~/.kube/config` existe mais `kubectl` n'est pas installé
- **THEN** l'inventaire signale `kubectl` comme requis et manquant, avec la raison « ~/.kube »

#### Scenario: Outil installé jamais utilisé
- **WHEN** une formule brew n'a ni configuration, ni usage dans l'historique, ni marqueur de projet
- **THEN** elle est marquée « non utilisée » et l'utilisateur peut l'exclure de l'export

### Requirement: Choix de l'utilisateur
L'utilisateur SHALL pouvoir cocher ou décocher chaque outil avant l'export. Ses choix sont mémorisés dans `config.toml` et réappliqués aux inventaires suivants.

#### Scenario: Outil exclu
- **WHEN** l'utilisateur décoche `cowsay` puis relance l'inventaire
- **THEN** `cowsay` reste décoché

### Requirement: Export réinstallable
Cairn SHALL exporter les outils retenus dans un fichier `tools.toml` versionné qui regroupe les outils par source avec leurs paramètres d'installation. Il exporte aussi un `Brewfile` compatible avec `brew bundle`. L'export est inclus dans chaque sauvegarde et peut être enregistré séparément.

#### Scenario: Export manuel
- **WHEN** l'utilisateur exporte l'inventaire vers un dossier
- **THEN** le dossier contient `tools.toml` et un `Brewfile` sans aucune ligne `cask` ni `mas`
