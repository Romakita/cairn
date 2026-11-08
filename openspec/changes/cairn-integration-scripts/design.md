# Design

## Context

- **L'app actuelle** (`WorkspaceStorage/`) : un package SwiftPM, SwiftUI, macOS 14+, compilé avec les seules Command Line Tools (sans Xcode).
  - Le plugin de macro `@State` est absent, d'où l'alias `@ViewState`.
  - Le scanner utilise fts(3) en parallèle sur les dossiers de niveau 2 et est déjà en lecture seule.
- **Les scripts bash** qui fixent le comportement à reprendre (voir `proposal.md`) :
  - `scripts/backup.sh` : inventaire, exclusions, snapshots SQLite par `sqlite3 .backup`, rsync ;
  - `scripts/restore.sh` : ordre d'installation, suffixe `.pre-restore`, droits des secrets ;
  - `scripts/git-cleanup.sh` : détection des squash merges par `git patch-id`, journal des SHA.
- **Le stockage cible** : un NAS Synology joignable en SMB. Des drives en ligne viendront ensuite.
- **Les contraintes du dépôt** (`AGENTS.md`) : tout est en français, chaque opération destructive est explicite et a un mode simulation, et les règles « régénérable » de l'analyse et de la sauvegarde restent cohérentes.

## Goals / Non-Goals

**Goals:**
- Un seul binaire `Cairn`, à la fois app SwiftUI et commande `cairn`, au-dessus d'un cœur partagé et testable sans interface.
- Parité fonctionnelle avec les trois scripts avant leur retrait, vérifiée en comparant les sorties sur les mêmes données.
- Un moteur de sauvegarde qui écrit dans un système de fichiers local monté. Les fournisseurs se chargent seulement de fournir ce point de montage, ce qui permet d'ajouter un drive en ligne sans toucher au moteur.
- Une interface inspirée du style de l'app Codex (voir la décision 11).

**Non-Goals:**
- Pas de démon ni d'agent launchd : les sauvegardes ne partent que si l'app tourne.
- Pas de déduplication par blocs ni de format de sauvegarde maison : on reste sur des fichiers plus des liens physiques, lisibles sans Cairn.
- Pas de sauvegarde du Trousseau macOS ni des applications graphiques.
- Pas de signature ni de notarisation : l'app reste signée ad hoc pour un usage personnel.

## Decisions

### 1. Structure du package : `CairnCore` + exécutable `Cairn`
- `CairnCore` (bibliothèque) regroupe la configuration, le scanner, la sauvegarde et les fournisseurs, l'inventaire, git, la restauration, le verrouillage et le journal. Il n'importe pas SwiftUI.
- `Cairn` (exécutable) regroupe l'interface SwiftUI et le routeur de commandes. Un `main.swift` regarde les arguments : une sous-commande connue lance le mode ligne de commande, sinon `CairnApp.main()` démarre l'interface.
- Le lien `~/.local/bin/cairn` pointe vers `Cairn.app/Contents/MacOS/Cairn`.
- *Alternative écartée* : deux binaires, l'app et la commande. Il faudrait les garder à la même version et les installer séparément, pour aucun gain.

### 2. Fichier TOML : un parseur maison sans perte, limité à un sous-ensemble
La spec exige de réécrire `config.toml` en conservant les commentaires et les clés inconnues.
- Les bibliothèques Swift existantes (TOMLKit, qui repose sur toml++) perdent les commentaires quand elles réécrivent.
- On écrit donc un parseur qui garde un arbre syntaxique avec les espaces et les commentaires. Il couvre : tables, tableaux de tables, chaînes, entiers, booléens, tableaux de scalaires et tables en ligne simples.
- Une fonctionnalité TOML non gérée (dates, par exemple) donne une erreur avec la ligne.
- Coût estimé : environ 500 lignes, testées sur des fichiers d'exemple.
- *Alternative écartée* : JSON, ou les préférences macOS. L'utilisateur demande explicitement un fichier à la manière de Codex.

Schéma prévu (version 1) :

```toml
version = 1

[analysis]
big_file_threshold_mb = 50

[[folders]]
path = "/Volumes/workspaces"
backup = true
exclude = []                  # motifs en plus des règles régénérables

[home]
include = [".zshrc", ".ssh", ".config/mise", ".claude", ".codex"]
exclude = []

[ai.claude-code]
categories = ["conversations", "config", "memories"]

[ai.codex]
categories = ["conversations", "config", "memories", "credentials"]

[[destinations]]
id = "nas"
provider = "smb"
url = "smb://nas.local/backups"
username = "romain"
keychain = "cairn.nas"        # référence du Trousseau, jamais le secret
encrypted = true
retention = 7

[schedule]
frequency = "daily"           # daily | weekly | manual
time = "12:30"
weekday = "monday"            # avec weekly
launch_at_login = false

[git]
fetch_before = false
gc = true

[tools]
excluded = ["cowsay"]
```

### 3. Moteur de sauvegarde : rsync en sous-processus, versions par `--link-dest`
- **Moteur** : `rsync` lancé en sous-processus. On prend `/opt/homebrew/bin/rsync` (GNU, avec `-aH` et `--info=progress2`) s'il est présent, sinon `/usr/bin/rsync` (openrsync). La progression vient de la sortie, et l'annulation envoie SIGTERM.
- **Organisation** : `<racine>/cairn/<machine>/versions/<horodatage>/{folders/<nom>, home, ai, tools, manifest.json}`.
- **Versions** : une version en cours s'écrit dans `.incomplete-<horodatage>`. Elle est renommée seulement en cas de succès, puis le lien `latest` est mis à jour. La rétention ne supprime que des versions terminées.
- **Fichiers inchangés** : `--link-dest=<version précédente>` les transforme en liens physiques, donc ils ne prennent pas de place en plus.
- **Exclusions** : générées par le cœur à partir de la même table que l'analyse, reprise de `backup.sh`. Pour `lib/`, `build/` et les autres noms génériques dans un dépôt, on appelle `git check-ignore`, comme le script.
- *Alternatives écartées* :
  - réécrire la copie en Swift : il faudrait réimplémenter les métadonnées, les liens physiques et la reprise, ce que rsync fait déjà ;
  - Time Machine (`tmutil`) : pas de contrôle des dossiers inclus, ni d'export lisible.

### 4. Fournisseurs : chacun fournit un dossier local, la sauvegarde va dans une image disque
- Le protocole `BackupProvider` expose `prepare() -> URL` (dossier local monté où écrire) et `finish()` (démonter et nettoyer). Deux fournisseurs dans cette version :
  - `local` : un dossier ou un disque externe ;
  - `smb` : montage avec NetFS (`NetFSMountURLSync`), identifiants lus dans le Trousseau, puis démontage s'il a monté lui-même.
- Sur un NAS en SMB, les liens physiques et les droits POSIX ne sont pas fiables. Le moteur écrit donc dans une image disque **sparsebundle APFS** posée sur la destination. Elle est chiffrée en AES-256 si `encrypted = true`, et créée et montée avec `hdiutil -stdinpass -nobrowse`. Le dossier local n'utilise l'image que si le chiffrement est demandé.
- Un sparsebundle est découpé en fichiers de 8 Mo, ce qui se synchronise bien. Les futurs fournisseurs Google Drive ou iCloud Drive (dossiers synchronisés dans `~/Library/CloudStorage`) pourront donc réutiliser cette mécanique. Un fournisseur qui passe par une API (OneDrive, S3…) ajoutera une étape d'envoi des fichiers de l'image après `finish()`.
- *Alternative écartée* : rsync directement vers le partage. Les liens physiques sont incertains en SMB, et les secrets seraient en clair.

### 5. Secrets : services du Trousseau `fr.lenzotti.cairn.*`
- Mots de passe SMB : `kSecClassInternetPassword`, en reprenant l'entrée existante de macOS si l'utilisateur l'autorise.
- Mots de passe des images chiffrées : `kSecClassGenericPassword`. Ils sont générés aléatoirement à la création et affichés une fois avec une invitation à les noter (indispensables pour restaurer sur un Mac neuf).
- `config.toml` ne contient que la clé de l'entrée.

### 6. Outils IA : profils déclaratifs et snapshots SQLite
- **Profils** : chaque outil est décrit dans une ressource `ai-tools/<id>.json` versionnée, avec la racine, les chemins par catégorie (`conversations`, `config`, `memories`, `credentials`), les bases SQLite, les exclusions et les éléments à réinstaller. Profils fournis, d'après ce qu'on trouve sur la machine :
  - **Claude Code** (`~/.claude`, `~/.claude.json`) :
    - conversations : `projects/`, `sessions/`, `history.jsonl`, `file-history/` ;
    - configuration : `settings.json`, `CLAUDE.md`, `skills/`, `hooks/`, la partie MCP et projets de `~/.claude.json` ;
    - à réinstaller : `plugins/` (liste des marketplaces et plugins installés) ;
    - exclus : `cache/`, `telemetry/`, `shell-snapshots/`, `session-env/`, `spares/` ;
    - identifiants : aucun fichier, le jeton est dans le Trousseau, donc reconnexion nécessaire.
  - **Claude Desktop** (`~/Library/Application Support/Claude`) :
    - conversations : `claude-code-sessions/` ;
    - configuration : `claude_desktop_config.json`, `config.json`, `ccd-*.json`, `cowork-*.json` ;
    - tout le reste (caches Chromium, cookies) est exclu.
  - **Codex** (`~/.codex`) :
    - conversations : `sessions/`, `archived_sessions/`, `session_index.jsonl`, `history.jsonl`, `thread_history_*.sqlite`, `state_*.sqlite` ;
    - configuration : `config.toml`, `AGENTS.md`, `hooks.json`, `profiles/`, `rules/` ;
    - mémoires : `memories*`, `goals_*.sqlite` ;
    - identifiants : `auth.json`, `.credentials.json` ;
    - à réinstaller : `plugins/`, `packages/` ;
    - exclus : `cache/`, `logs_*.sqlite`, `.tmp/`, `tmp/`, `..codex-global-state.json.*`.
- **Organisation dans la sauvegarde** : `ai/<outil>/<catégorie>/…`, chemins relatifs à la racine de l'outil, avec un `ai/<outil>/profile.json` qui enregistre la version du profil et le home d'origine.
- **Snapshots** : les bases sont copiées avec l'API `sqlite3_backup_*` de `libsqlite3`, liée au système, et non plus avec le CLI `sqlite3`. Les fichiers `-wal` et `-shm` sont exclus. Les catégories cochées deviennent une liste de fichiers passée à rsync (`--files-from`), après les snapshots.
- **Restauration par fusion** : rsync avec `--update --backup --suffix=.pre-restore`, conversation par conversation. La version la plus récente gagne et l'autre est conservée. Les bases SQLite restaurées remplacent la base locale seulement si l'utilisateur le confirme, l'ancienne étant conservée en `.pre-restore`.
- **Chemins** : Claude Code nomme ses dossiers de projets en remplaçant `/` et `.` par `-`. À la restauration, une table « ancien préfixe → nouveau préfixe » (home d'origine et cibles des dossiers suivis) renomme ces dossiers. Les chemins internes aux bases Codex ne sont pas réécrits, et c'est signalé.
- *Alternative écartée* : laisser les dossiers des outils IA dans la sélection du home. Pas de catégories, plus de 1,4 Go de paquets copiés pour rien, et pas de fusion à la restauration.

### 7. Inventaire : sources par adaptateur, règles d'affinage en ressource
- Chaque source (brew, mise, npm, uv, pipx, cargo, go, local-bin) est un adaptateur qui lance sa commande et lit sa sortie. Les formats viennent de `backup.sh` (reçus uv, `npm ls -g --parseable`, `brew leaves` plus taps).
- Les liens de `~/.local/bin` qui pointent vers des environnements uv ou pipx sont rattachés à leur source.
- Les règles d'affinage (configuration du home → outil, marqueur de projet → outil) sont dans une ressource `rules.json` versionnée : on en ajoute sans recompiler la logique.
- L'historique est lu depuis `~/.zsh_history` (format étendu) et `~/.bash_history`.

### 8. Maintenance git : portage direct du script
- Mêmes commandes git : `for-each-ref` avec `upstream:track`, `merge-base --is-ancestor`, `patch-id --stable` pour les squash merges, `rev-list --disk-usage` pour l'estimation, `gc` et `reflog expire`.
- Au plus 4 dépôts traités en parallèle.
- Variables d'environnement `GIT_TERMINAL_PROMPT=0` et ssh `BatchMode`, pour qu'aucun `fetch` ne bloque.

### 9. Restauration : rsync `--backup`, étapes administrateur dans Terminal
- La copie utilise `rsync -a --backup --suffix=.pre-restore`.
- Une sauvegarde héritée est reconnue à la présence de `manifest/system.txt` et de `home/`, puis adaptée au même modèle interne que le format Cairn.
- L'installation des Command Line Tools ou de Homebrew s'ouvre dans Terminal (`osascript` avec `do script`). Cairn attend ensuite la présence de `brew` ou de `xcode-select -p`, en vérifiant toutes les 5 secondes, sans jamais manipuler de mot de passe administrateur.
- L'app tourne sans les CLT, puisque le runtime Swift fait partie de macOS : elle peut donc être le premier outil lancé sur un Mac neuf.

### 10. Planification et exclusivité
- **Planificateur** : un planificateur dans l'app (`MenuBarExtra` et une minuterie toutes les minutes). Il compare l'échéance à la dernière réussite enregistrée dans `~/.cairn/state/runs.json`, ce qui couvre aussi les échéances manquées.
- **Ouverture à la connexion** : `SMAppService.mainApp`.
- **Une seule opération à la fois** : un verrou `flock` sur `~/.cairn/state/operation.lock`, partagé par l'app et la commande, protège la sauvegarde et la restauration.
- **Notifications** : `UNUserNotificationCenter`.

### 11. Interface inspirée de Codex
Disposition :
- à gauche, une **barre d'icônes** étroite (Accueil, Analyse, Sauvegardes, Outils IA, Outils CLI, Git, Restauration, avec Réglages et l'état en bas) ;
- puis une **barre latérale** gris très clair, avec des sections titrées en gris (« Dossiers suivis », « Projets », « Destinations ») et des lignes icône et libellé sans séparateurs ;
- enfin une **zone de contenu** blanche et aérée.

Éléments :
- en haut de la zone de contenu, un **sélecteur segmenté** centré en forme de pilule pour les sous-vues (par exemple Explorateur / Nettoyable / Gros fichiers) ;
- un **accueil** centré : grand titre (« Que voulez-vous faire ? »), carte très arrondie (rayon 16 à 20) avec une ombre légère, actions rapides en pilules (Analyser, Sauvegarder maintenant, Restaurer) et état de la dernière sauvegarde ;
- une typographie SF Pro, des icônes SF Symbols monochromes et un seul accent bleu. Les couleurs des catégories ne servent qu'aux graphiques. Mode sombre pris en charge.

Mise en œuvre :
- des composants maison (`Sidebar`, `RailButton`, `PillPicker`, `Card`) plutôt que les styles de liste par défaut ;
- l'alias `@ViewState` est conservé, et `@Observable` et `#Preview` restent évités ;
- on reprend l'esprit (sobriété, hiérarchie), jamais le logo, le nom ni les éléments propres à OpenAI.

### 12. Retrait des scripts après preuve de parité
On lance `cairn backup --dry-run` et `backup.sh --dry-run` sur les mêmes sources, puis on compare les listes de fichiers à copier. On fait de même pour `cairn git --json` et le rapport TSV de `git-cleanup.sh`. Les scripts ne sont supprimés que si les écarts sont expliqués (par exemple la sélection du home, qui change volontairement).

## Risks / Trade-offs

- [`swift test` n'a peut-être pas XCTest ni swift-testing avec les seules CLT] → La première tâche le vérifie. Sinon, les tests de `CairnCore` passent par un exécutable `cairn-selftest` lancé par `just test`.
- [`SMAppService.mainApp` pour une app ad hoc dans `~/Applications`] → À tester tôt. En cas d'échec, on se rabat sur un élément d'ouverture ajouté par AppleScript à System Events, ou on documente l'ajout manuel.
- [Perte du mot de passe de l'image chiffrée = sauvegarde irrécupérable] → Le mot de passe est affiché à la création, un export est proposé, et l'app demande de confirmer qu'il a été noté.
- [Une image sparsebundle montée au moment d'une coupure réseau peut être abîmée] → `hdiutil verify` avant chaque sauvegarde et `hdiutil compact` après la rétention. La version en cours ne devient visible qu'une fois renommée.
- [Différences entre openrsync et GNU rsync (options, progression)] → Le moteur détecte le binaire et adapte ses options, et les tests passent sur les deux.
- [Changement de comportement : le home passe d'une liste d'exclusions à une liste d'inclusions] → L'assistant présélectionne tout ce que `backup.sh` copiait. La comparaison de parité (décision 12) montre les éléments retirés.
- [Les formats internes de Claude et Codex changent sans prévenir] → Les profils sont versionnés et séparés du code. Un chemin attendu absent est signalé dans la vue IA au lieu de faire échouer la sauvegarde.
- [Fusionner des bases SQLite est impossible sans connaître leur schéma] → Les bases sont restaurées en bloc, sur confirmation et avec copie `.pre-restore`. Seuls les fichiers de conversations (`jsonl`) sont fusionnés un par un.
- [L'inventaire ne couvre plus les casks] → Voulu (proposition). L'ancien `Brewfile.apps` reste lisible lors de la restauration d'une sauvegarde héritée.
- [Un style trop proche de Codex] → Inspiration de mise en page seulement : palette, icône et nom propres à Cairn.

## Migration Plan

1. `WorkspaceStorage/` devient `Cairn/`, avec le bundle `fr.lenzotti.cairn`. `build-app.sh` installe `~/Applications/Cairn.app` et retire `Workspace Storage.app`.
2. Au premier lancement, la valeur `rootPath` des préférences de l'ancienne app est proposée comme dossier suivi dans l'assistant.
3. Pendant le développement, les scripts et `cairn` cohabitent, et les recettes `just` existantes ne changent pas.
4. Une fois la parité prouvée, les recettes `backup`, `restore`, `check`, `git-clean` et `git-clean-apply` appellent `cairn`, puis `scripts/*.sh` sont supprimés. Le README et `AGENTS.md` sont mis à jour.
5. Retour arrière : les scripts restent dans l'historique git (`git checkout <sha> -- scripts/`), et les sauvegardes Cairn restent lisibles sans Cairn (fichiers rsync dans une image que macOS sait monter).

## Open Questions

- Le nom du fournisseur et la méthode d'envoi du premier drive en ligne (Google Drive par dossier synchronisé ou par API) : à décider au moment de l'ajouter. L'interface du fournisseur ne change pas.
- L'heure par défaut de la sauvegarde quotidienne et la rétention par défaut (7) : ajustables dans les réglages sans changer la spec.
