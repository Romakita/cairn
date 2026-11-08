# Tasks

## 1. Socle : renommage, structure du package et tests

- [ ] 1.1 Renommer `WorkspaceStorage/` en `Cairn/` (package `Cairn`, bundle `fr.lenzotti.cairn`, `build-app.sh` qui installe `~/Applications/Cairn.app` et retire `Workspace Storage.app`) ; vérifier que `./build-app.sh` produit et lance `Cairn.app`
- [ ] 1.2 Découper le package en une bibliothèque `CairnCore`, sans SwiftUI, qui contient le modèle et le scanner actuels, et un exécutable `Cairn` ; vérifier que `swift build -c release` passe et que `grep -r "import SwiftUI" Sources/CairnCore` ne renvoie rien
- [ ] 1.3 Déterminer le mécanisme de test disponible avec les Command Line Tools (swift-testing, XCTest, ou à défaut un exécutable `cairn-selftest`) et ajouter `just test` ; vérifier qu'un test trivial passe et qu'un test volontairement faux échoue
- [ ] 1.4 Ajouter `main.swift`, qui envoie vers le mode ligne de commande quand une sous-commande est passée et vers l'app sinon, avec `cairn --help` ; vérifier que `Cairn --help` affiche l'aide sans fenêtre avec le code 0, et qu'un lancement sans argument ouvre l'app
- [ ] 1.5 Ajouter le verrou d'opération (`~/.cairn/state/operation.lock`) et le journal (`~/.cairn/logs/`) dans `CairnCore`, avec des tests : un second verrou est refusé, et le verrou est libéré si le processus se termine

## 2. Configuration (`app-configuration`)

- [ ] 2.1 Écrire le parseur et l'écrivain TOML sans perte (tables, tableaux de tables, scalaires, tableaux, tables en ligne simples) ; vérifier par des tests de bout en bout (lire puis réécrire donne un fichier identique, commentaires et clés inconnues compris) et par une erreur avec numéro de ligne sur les fonctionnalités non gérées
- [ ] 2.2 Définir le modèle de configuration v1 (dossiers, home, destinations, planification, git, outils, analyse), ses valeurs par défaut et sa validation ; vérifier par des tests sur une clé inconnue, une erreur de type et un dossier absent signalé comme indisponible
- [ ] 2.3 Mettre en place le chargement depuis `~/.cairn/config.toml` (création du dossier en `700`), l'option `--config`, la surveillance des changements avec rechargement, et la migration de version avec `config.toml.bak` ; vérifier par des tests de migration v0 vers v1 et par le rechargement observé dans l'app après une modification à la main
- [ ] 2.4 Écrire l'accès au Trousseau (`fr.lenzotti.cairn.*` : mots de passe internet et génériques) ; vérifier par un test qui écrit, lit puis supprime une entrée, et en constatant qu'aucun secret n'apparaît dans `config.toml`
- [ ] 2.5 Ajouter `cairn config show | path | validate` avec les codes de sortie 0, 1 et 2 ; vérifier que `cairn config validate` sur un fichier invalide renvoie 2 avec la ligne fautive
- [ ] 2.6 Documenter le schéma de `config.toml` avec un exemple commenté dans `Cairn/README.md` ; vérifier que `cairn config validate --config` accepte l'exemple tel quel

## 3. Interface de base inspirée de Codex

- [ ] 3.1 Créer les composants de mise en page (barre d'icônes, barre latérale avec sections, `PillPicker` centré, `Card`, jetons de couleur clair et sombre avec un seul accent) ; vérifier visuellement en clair et en sombre avec une capture de chaque vue jointe à la tâche
- [ ] 3.2 Construire l'accueil (grand titre centré, actions rapides en pilules, état de la dernière sauvegarde et des dossiers suivis) et la navigation entre les sections ; vérifier que chaque icône de la barre ouvre sa section
- [ ] 3.3 Construire l'assistant de premier lancement (dossiers suivis avec propositions détectées, dont l'ancien `rootPath` ; sélection du home ; outils IA détectés et leurs catégories ; destination ou « plus tard » ; planification ; « Restaurer une sauvegarde ») qui écrit `config.toml` à la fin seulement ; vérifier sur un compte sans `~/.cairn` : l'abandon n'écrit rien, et la fin écrit un fichier valide
- [ ] 3.4 Construire l'écran de réglages, qui édite les mêmes clés en conservant les commentaires ; vérifier qu'un ajout de dossier depuis les réglages garde un commentaire écrit à la main
- [ ] 3.5 Ajouter l'icône dans la barre des menus (état, « Sauvegarder maintenant », ouvrir Cairn) et l'ouverture à la connexion (`SMAppService.mainApp`, avec la solution de repli du design si elle échoue) ; vérifier que l'app reste active fenêtre fermée et qu'elle se relance après une fermeture de session

## 4. Analyse multi-dossiers (`storage-analysis`)

- [ ] 4.1 Étendre le scanner à la liste des dossiers suivis (un nœud racine par dossier, dossiers indisponibles signalés) et à la table régénérable partagée avec la sauvegarde ; vérifier par des tests sur une arborescence créée pour l'occasion, et par l'écart de moins de 1 % avec `du -sk` sur `/Volumes/workspaces`
- [ ] 4.2 Ajouter la détection des projets (dépôts git et marqueurs de projet) avec la répartition sources / `.git` / régénérable, et le seuil des gros fichiers lu dans la configuration ; vérifier par un test sur un dépôt avec `node_modules` et sur un seuil modifié
- [ ] 4.3 Réintégrer les vues existantes (Explorateur, Nettoyable, Projets, Gros fichiers) dans la nouvelle mise en page, avec arrêt de l'analyse en moins de 2 s et nettoyage confirmé (corbeille par défaut) ; vérifier à la main l'annulation d'une confirmation et la mise à jour des totaux après une mise à la corbeille
- [ ] 4.4 Ajouter `cairn analyze [dossiers…] [--json]` à la place de `--report` ; vérifier que la sortie `--json` est du JSON valide (`python3 -m json.tool`) et que les totaux correspondent à `du`

## 5. Inventaire des outils (`tool-inventory`)

- [ ] 5.1 Écrire les adaptateurs de sources (brew formules et taps sans casks, mise, npm global, uv avec extras et Python, pipx, cargo, go, `~/.local/bin` avec rattachement des liens) ; vérifier par des tests sur des sorties enregistrées et par un inventaire réel sans aucun cask
- [ ] 5.2 Écrire les règles d'affinage dans `rules.json` (configuration du home vers l'outil, marqueur de projet vers l'outil, historique zsh et bash avec au moins 3 utilisations) avec les statuts utilisé, non utilisé et requis manquant ; vérifier par des tests (`~/.kube` sans `kubectl` donne « requis manquant » avec sa raison)
- [ ] 5.3 Ajouter l'export `tools.toml` et `Brewfile` (sans `cask` ni `mas`) et la mémorisation des outils exclus dans `[tools].excluded` ; vérifier que `brew bundle check --file` accepte le `Brewfile` exporté et qu'un outil décoché le reste après un nouvel inventaire
- [ ] 5.4 Construire la vue Outils (liste par source, filtres de statut, cases à cocher, export) et `cairn tools [--json] [--export DIR]` ; vérifier que l'export en ligne de commande produit les deux fichiers
- [ ] 5.5 Documenter l'inventaire et l'ajout d'une règle dans `rules.json` dans `Cairn/README.md`

## 6. Maintenance git (`git-maintenance`)

- [ ] 6.1 Porter la découverte des dépôts, la détection de la branche principale et le statut des branches « gone » (fusionnée, squashée, non fusionnée) ; vérifier par des tests sur des dépôts créés pour l'occasion (merge, squash merge, branche non fusionnée, branche courante exclue)
- [ ] 6.2 Porter l'estimation d'espace (`rev-list --disk-usage`, objets non compressés) et le rapport TSV ; vérifier que, sur `/Volumes/workspaces`, `cairn git --json` donne les mêmes branches et statuts que `scripts/git-cleanup.sh` (comparaison des deux rapports)
- [ ] 6.3 Écrire l'application : journal des SHA dans `cleanup-deleted-branches.log` avant suppression, `gc`, « libérer immédiatement », `fetch --prune` optionnel non interactif, au plus 4 dépôts en parallèle ; vérifier par un test qu'une branche supprimée se recrée depuis le journal
- [ ] 6.4 Construire la vue Git (tableau des dépôts, détail des branches, cases à cocher, branches non fusionnées décochées, confirmation récapitulative) et `cairn git [--apply] [--include-unmerged] [--prune-now] [--fetch] [--only]` ; vérifier qu'aucune modification n'a lieu sans `--apply`

## 7. Sauvegarde (`backup`)

- [ ] 7.1 Générer les exclusions (table régénérable, `git check-ignore` pour les noms génériques, motifs de l'utilisateur, destination incluse dans la source) et la sélection du home avec ses exclusions de caches ; vérifier par des tests reprenant les cas de `backup.sh` (`lib/` versionné copié, `lib/` ignoré exclu, caches exclus d'un dossier sélectionné, dossiers des outils IA exclus du home)
- [ ] 7.2 Écrire le moteur rsync (choix GNU ou openrsync, progression, annulation, `.incomplete-*` renommé en cas de succès, `--link-dest`, lien `latest`, `manifest.json`) ; vérifier par un test qu'une deuxième version sans changement n'ajoute presque rien (`du`) et qu'une version annulée ne laisse aucune version visible
- [ ] 7.3 Écrire la rétention (suppression seulement après un succès) et l'état des exécutions dans `runs.json` ; vérifier par un test qu'une 8ᵉ version avec une rétention de 7 supprime la plus ancienne et qu'un échec ne supprime rien
- [ ] 7.4 Écrire les fournisseurs `local` et `smb` (montage NetFS avec identifiants du Trousseau, démontage de ce qui a été monté) et l'image sparsebundle APFS chiffrée ou non (`hdiutil` avec `-stdinpass`, vérification avant écriture, compactage après) ; vérifier sur le NAS Synology : une sauvegarde chiffrée ne laisse qu'une image sur le partage, et un NAS éteint donne un échec propre sans toucher aux autres destinations
- [ ] 7.5 Écrire le planificateur (quotidien, hebdomadaire ou manuel, rattrapage d'une échéance manquée, pas de doublon) et les notifications d'échec ; vérifier par des tests avec une horloge simulée, puis en conditions réelles avec une échéance proche
- [ ] 7.6 Construire la vue Sauvegardes (destinations avec ajout et test de connexion, avertissement si le chiffrement est désactivé, création et affichage unique du mot de passe de l'image, simulation, progression, historique et journaux) et `cairn backup [--dry-run] [--destination ID] [--json]` ; vérifier qu'une simulation ne modifie pas la destination et que `cairn backup` est refusé avec le code 1 pendant une sauvegarde lancée depuis l'app
- [ ] 7.7 Comparer `cairn backup --dry-run` et `scripts/backup.sh --dry-run` sur les mêmes dossiers et documenter les écarts voulus (sélection du home, casks) dans `Cairn/README.md` ; vérifier qu'il ne reste aucun écart inexpliqué sur le workspace

## 8. Outils IA (`ai-tools`)

- [ ] 8.1 Définir le format des profils (`ai-tools/<id>.json` : racine, chemins par catégorie, bases SQLite, exclusions, éléments à réinstaller, version) et son chargement avec détection des outils présents ; vérifier par des tests qu'un outil absent est « non détecté » sans erreur et qu'un profil ajouté dans un dossier de test apparaît sans autre changement de code
- [ ] 8.2 Écrire les profils Claude Code, Claude Desktop et Codex d'après le design ; vérifier sur cette machine que chaque chemin déclaré existe ou est signalé comme absent, et que `plugins/`, `packages/`, `cache/` et `logs_*.sqlite` ne figurent dans aucune catégorie copiée
- [ ] 8.3 Écrire les snapshots SQLite par `sqlite3_backup_*`, la construction de la liste de fichiers par catégorie (`--files-from`), la liste des plugins à réinstaller et le `profile.json` de chaque outil ; vérifier par un test qu'une base en mode WAL en cours d'écriture donne une copie qui passe `PRAGMA integrity_check`, et qu'aucun `-wal` ni `-shm` n'est copié
- [ ] 8.4 Brancher la partie IA dans le moteur de sauvegarde (`ai/<outil>/<catégorie>/`), exclure les dossiers des profils de la sélection du home, et décocher « identifiants » par défaut si une destination n'est pas chiffrée, avec avertissement si l'utilisateur le coche ; vérifier par des tests : `~/.claude` coché dans le home n'est copié qu'une fois, et « identifiants » est décoché avec une destination en clair
- [ ] 8.5 Écrire la restauration par fusion (`--update --backup --suffix=.pre-restore` pour les conversations, remplacement des bases SQLite sur confirmation, attente de la fermeture de l'outil) la réécriture des dossiers de projets Claude Code selon la table des préfixes, et la lecture des données IA des sauvegardes héritées (`ai/sqlite/`, `ai/claude-desktop/`, `home/.claude`, `home/.codex`) ; vérifier dans un home de test : une conversation locale plus récente est gardée et la sauvegardée est écrite à côté, et `-Volumes-workspaces-exports` devient `-Users-<nom>-workspaces-exports` quand le workspace est restauré dans `~/workspaces`
- [ ] 8.6 Construire la vue Outils IA (outils détectés, taille par catégorie, nombre de conversations et date de la plus récente, cases par catégorie, mention « reconnexion nécessaire » pour les jetons du Trousseau, dernière sauvegarde) et `cairn ai [--json]`, `cairn backup --only ai [--tool ID]`, `cairn restore --parts ai` ; vérifier que `cairn backup --only ai --tool codex` crée une version qui ne contient que `ai/codex/`
- [ ] 8.7 Documenter les profils (format, ajout d'un outil, catégories et ce qui n'est jamais copié) dans `Cairn/README.md` ; vérifier que l'exemple de profil documenté se charge avec le test de la tâche 8.1

## 9. Restauration (`restore`)

- [ ] 9.1 Écrire la lecture des sauvegardes : versions Cairn (manifest, parties, architecture) et sauvegardes héritées de `backup.sh` (`manifest/system.txt`, `Brewfile`, `npm-globals.txt`, `uv-tools.txt`, `pipx.json`) adaptées au même modèle ; vérifier par des tests sur une sauvegarde héritée réelle et sur une version Cairn
- [ ] 9.2 Écrire la copie sélective (`rsync --backup --suffix=.pre-restore`, cible de chaque dossier, proposition de volume APFS `workspaces` ou d'un autre emplacement) et les droits des secrets ; vérifier dans un home de test qu'un `.zshrc` existant devient `.zshrc.pre-restore` et que `~/.ssh` est en `700`
- [ ] 9.3 Écrire la réinstallation des outils dans l'ordre du design, avec les outils présents ignorés et les échecs journalisés ; les étapes administrateur (CLT, Homebrew) s'ouvrent dans Terminal avec attente de la fin ; vérifier par un test qu'un échec npm n'arrête pas les suivants, puis à la main l'ouverture de Terminal quand `brew` est absent
- [ ] 9.4 Écrire la vérification finale et les rappels manuels, et `cairn restore [--from DIR|--destination ID] [--version V] [--parts …] [--apply] [--check]` ; vérifier que `cairn restore --check` ne modifie rien et liste les outils manquants
- [ ] 9.5 Construire la vue Restauration (choix de la destination et de la version, contenu, cases par partie, récapitulatif avec tailles, confirmation, progression) et l'entrée « Restaurer une sauvegarde » de l'assistant ; vérifier par une restauration complète dans un compte macOS de test à partir d'une sauvegarde du NAS

## 10. Bascule et retrait des scripts

- [ ] 10.1 Faire passer les recettes `just` sur `cairn` (`backup`, `backup-dry`, `restore`, `check`, `git-clean`, `git-clean-apply`, `storage*`, `test`) et installer le lien `~/.local/bin/cairn` depuis `build-app.sh` ; vérifier que chaque recette de `just --list` s'exécute en mode simulation
- [ ] 10.2 Supprimer `scripts/backup.sh`, `scripts/restore.sh` et `scripts/git-cleanup.sh` après les comparaisons des tâches 6.2 et 7.7, et mettre à jour `README.md` et `AGENTS.md` (vérifications avec `just test` et `cairn … --dry-run`, contraintes de Cairn) ; vérifier que `grep -rn "scripts/" README.md AGENTS.md justfile` ne renvoie plus de référence aux scripts supprimés
- [ ] 10.3 Vérification de bout en bout : premier lancement sur un compte vierge, analyse de deux dossiers, sauvegarde chiffrée sur le NAS (outils IA compris), nettoyage git en simulation puis en application sur un dépôt de test, restauration de la version sur le compte de test ; consigner le résultat dans la section « Revue » de `tasks/todo.md`

## Workflow follow-up

- Lancer `/opsx:verify` puis archiver le changement (`/opsx:archive`) une fois la revue faite.
- Ajouter un premier fournisseur de drive en ligne dans un changement séparé.
