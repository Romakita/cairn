# Spec Delta

## Purpose

Décrit comment Cairn est configuré : un fichier `~/.cairn/config.toml` lisible et modifiable à la main, un assistant au premier lancement et un écran de réglages, sans jamais stocker de secret en clair.

## ADDED Requirements

### Requirement: Fichier de configuration unique
Cairn SHALL lire et écrire sa configuration dans `~/.cairn/config.toml`. Le fichier contient au moins : les dossiers suivis, la sélection du home à sauvegarder, les catégories sauvegardées pour chaque outil IA, les destinations, la planification et les préférences git. Le dossier `~/.cairn/` contient aussi les journaux (`logs/`) et l'état des exécutions (`state/`).

#### Scenario: Création du dossier de configuration
- **WHEN** Cairn démarre et `~/.cairn/` n'existe pas
- **THEN** Cairn crée `~/.cairn/` avec les droits `700`, puis lance l'assistant de premier lancement

#### Scenario: Fichier modifié à la main
- **WHEN** l'utilisateur modifie `config.toml` pendant que l'app est ouverte
- **THEN** Cairn recharge la configuration et l'applique sans redémarrage

### Requirement: Assistant de premier lancement
Au premier lancement (aucun `config.toml`), Cairn SHALL afficher un assistant qui fait choisir :
- les dossiers à suivre ;
- les éléments du home à sauvegarder ;
- les outils IA détectés et leurs catégories à sauvegarder ;
- au moins une destination de sauvegarde, ou l'option « plus tard » ;
- la planification.

Il écrit ensuite `config.toml`. L'assistant MUST proposer des valeurs détectées, par exemple `/Volumes/workspaces` s'il existe.

#### Scenario: Premier lancement complet
- **WHEN** l'utilisateur termine l'assistant avec un dossier `/Volumes/workspaces` et une destination NAS
- **THEN** `config.toml` contient ce dossier et cette destination, et l'analyse du dossier démarre

#### Scenario: Assistant abandonné
- **WHEN** l'utilisateur ferme l'assistant avant la fin
- **THEN** aucun `config.toml` n'est écrit et l'assistant réapparaît au lancement suivant

### Requirement: Validation de la configuration
Cairn MUST valider `config.toml` au chargement. En cas d'erreur, il SHALL indiquer la clé fautive et la ligne, garder la dernière configuration valide et ne lancer aucune sauvegarde planifiée tant que le fichier est invalide.

#### Scenario: Dossier suivi inexistant
- **WHEN** un dossier suivi n'existe plus (volume démonté)
- **THEN** Cairn le signale comme indisponible, et l'analyse et la sauvegarde l'ignorent sans échouer pour les autres

#### Scenario: Syntaxe TOML invalide
- **WHEN** `config.toml` contient une erreur de syntaxe
- **THEN** Cairn affiche l'erreur avec sa ligne et désactive les sauvegardes planifiées jusqu'à correction

### Requirement: Aucun secret dans le fichier
Les mots de passe (NAS, image chiffrée, jetons de fournisseurs) MUST être stockés dans le Trousseau macOS et jamais dans `config.toml`. Le fichier ne contient qu'une référence à l'entrée du Trousseau.

#### Scenario: Ajout d'une destination NAS avec mot de passe
- **WHEN** l'utilisateur saisit le mot de passe du NAS dans l'app
- **THEN** le mot de passe est enregistré dans le Trousseau et `config.toml` ne contient que l'identifiant de l'entrée

### Requirement: Écran de réglages
Cairn SHALL proposer un écran de réglages qui modifie les mêmes clés que `config.toml` et réécrit le fichier en conservant les commentaires et les clés inconnues.

#### Scenario: Ajout d'un dossier depuis les réglages
- **WHEN** l'utilisateur ajoute `~/Projets` dans les réglages
- **THEN** `config.toml` contient ce dossier, et les commentaires écrits à la main sont toujours présents

### Requirement: Versionnement du schéma
`config.toml` MUST contenir un champ `version`. Quand le schéma évolue, Cairn SHALL migrer automatiquement un fichier plus ancien et garder une copie `config.toml.bak` de l'original.

#### Scenario: Fichier d'une version antérieure
- **WHEN** Cairn charge un `config.toml` dont la `version` est inférieure à la version courante
- **THEN** Cairn écrit `config.toml.bak`, migre le fichier et le recharge
