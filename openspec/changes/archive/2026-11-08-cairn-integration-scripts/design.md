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
- **Les maquettes validées** : https://claude.ai/artifact/RKZ4RFn7EzrFbxA4k9sc1Y (10 écrans : premier lancement, accueil, analyse, sauvegardes, outils IA, git, outils CLI, restauration, barre des menus, alerte).
- **Les contraintes du dépôt** (`AGENTS.md`) : la documentation et le code du projet sont en français (l'app, elle, est bilingue : voir la décision 13), chaque opération destructive est explicite et a un mode simulation, et les règles « régénérable » de l'analyse et de la sauvegarde restent cohérentes.

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
language = "auto"             # auto | en-US | fr-FR

[analysis]
big_file_threshold_mb = 50
big_folder_threshold_gb = 1

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
# entrée du Trousseau déduite de url + username, jamais le secret dans le fichier
encrypted = true
retention = { mode = "tiered", days = 30, weeks = 48 }   # ou { mode = "count", count = 12 }

[schedule]
frequency = "daily"           # daily | weekly | manual (défaut : daily)
time = "12:30"
weekday = "monday"            # avec weekly
background = true             # accord donné au premier lancement
on_battery_min_percent = 20

[alerts]
low_percent = 10
low_gb = 20
critical_percent = 5
critical_gb = 5

[logs]
retention_days = 90

[git]
fetch_before = false
gc = true
worktree_stale_days = 30

[tools]
excluded = ["cowsay"]
```

### 3. Moteur de sauvegarde : rsync en sous-processus, versions par `--link-dest`
- **Moteur** : `rsync` lancé en sous-processus. On prend `/opt/homebrew/bin/rsync` (GNU, avec `-aH` et `--info=progress2`) s'il est présent, sinon `/usr/bin/rsync` (openrsync). La progression vient de la sortie, et l'annulation envoie SIGTERM.
- **Organisation** : `<racine>/cairn/<machine>/versions/<horodatage>/{folders/<nom>, home, ai, tools, manifest.json}`.
- **Versions** : une version en cours s'écrit dans `.incomplete-<horodatage>`. Elle est renommée seulement en cas de succès, puis le lien `latest` est mis à jour.
- **Reprise** : une seule version incomplète existe à la fois. Au lancement suivant, rsync repart dans ce même dossier : les fichiers déjà copiés sont reconnus par leur taille et leur date, sans hash, et un gros fichier à moitié copié reprend avec `--partial-dir=.cairn-partial`. Si la version incomplète date de plus de 7 jours, elle est jetée et la sauvegarde repart de la dernière version terminée.
- **Rétention par paliers** : après chaque réussite, on calcule les versions à garder. Le mode `tiered` garde toutes les versions de moins de `days` jours, puis la plus récente de chaque semaine ISO sur `weeks` semaines. Le mode `count` garde les `count` versions les plus récentes. Les versions planifiées et manuelles comptent pareil. Les réglages n'exposent que trois choix (Recommandé, Nombre fixe, Personnalisé), et le TOML garde la même structure.
- **Fichiers inchangés** : `--link-dest` les transforme en liens physiques, donc ils ne prennent pas de place en plus. La base est choisie partie par partie : la version la plus récente qui contient cette partie.
- **Versions partielles** : une sauvegarde limitée (`--only`, outils IA seuls) écrit `"partial": true` dans son manifest. Elle ne devient pas `latest`, ne compte pas dans la rétention (elle est supprimée dès qu'une version complète plus récente existe) et n'est pas proposée par défaut à la restauration.
- **Simulation** : elle n'écrit rien sur la destination (ni image, ni dossier, ni `versions/`). Une destination encore vide est simulée contre un dossier temporaire vide.
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
- `config.toml` ne contient jamais de secret : l'entrée SMB se déduit de l'hôte de `url` et de `username` (celle du Finder est reprise), celle d'une image de l'identifiant de la destination et de la machine. L'ancienne clé `keychain` est encore lue, mais plus écrite.

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
- **Restauration par fusion** : fichier par fichier, écrite en Swift (`AIRestore.merge`) avec la même règle que `rsync --update --backup --suffix=.pre-restore`, pour compter ce qui est ajouté, remplacé ou gardé. L'outil doit être quitté avant (Cairn attend sa fermeture, sinon il est passé). La version la plus récente gagne et l'autre est conservée. Les bases SQLite restaurées remplacent la base locale seulement si l'utilisateur le confirme, l'ancienne étant conservée en `.pre-restore`.
- **Chemins** : Claude Code nomme ses dossiers de projets en remplaçant `/` et `.` par `-`. À la restauration, une table « ancien préfixe → nouveau préfixe » (home d'origine et cibles des dossiers suivis) renomme ces dossiers. Les chemins internes aux bases Codex ne sont pas réécrits, et c'est signalé.
- *Alternative écartée* : laisser les dossiers des outils IA dans la sélection du home. Pas de catégories, plus de 1,4 Go de paquets copiés pour rien, et pas de fusion à la restauration.

### 7. Inventaire : sources par adaptateur, règles d'affinage en ressource
- Chaque source (brew, mise, npm, uv, pipx, cargo, go, local-bin) est un adaptateur qui lance sa commande et lit sa sortie. Les formats viennent de `backup.sh` (reçus uv, `npm ls -g --parseable`, `brew leaves` plus taps).
- Les liens de `~/.local/bin` qui pointent vers des environnements uv ou pipx sont rattachés à leur source.
- Les règles d'affinage (configuration du home → outil, marqueur de projet → outil) sont dans une ressource `rules.json` versionnée : on en ajoute sans recompiler la logique.
- L'historique est lu depuis `~/.zsh_history` (format étendu) et `~/.bash_history`.

### 8. Maintenance git : portage direct du script, avec les worktrees
- Mêmes commandes git : `for-each-ref` avec `upstream:track`, `merge-base --is-ancestor`, `patch-id --stable` pour les squash merges, `rev-list --disk-usage` pour l'estimation, `gc` et `reflog expire`.
- Au plus 4 dépôts traités en parallèle, chacun dans un processus auxiliaire (`Cairn git-worker`) surveillé par `GitWorkerPool` : plafond de mémoire et de durée par worker (`proc_pid_rusage`), worker tué et dépôt signalé en échec au-delà. Les données passent de git à git par tuyau (`Git.pipe`), jamais chargées entières en mémoire.
- Variables d'environnement `GIT_TERMINAL_PROMPT=0` et ssh `BatchMode`, pour qu'aucun `fetch` ne bloque.
- **Worktrees** :
  - inventaire par `git worktree list --porcelain`, qui donne le chemin, le HEAD, la branche et l'état `prunable` ;
  - état de chaque worktree par `git -C <wt> status --porcelain` et `rev-list @{u}..` pour les commits non poussés, et date de dernière modification par le plus récent `mtime` hors dossiers régénérables ;
  - statut « fusionné » avec la même logique que pour les branches (`merge-base`, `patch-id`) ;
  - suppression par `git worktree remove` (`--force` seulement pour un worktree « à risque » coché explicitement), puis `git worktree prune` pour les orphelins ;
  - les branches extraites dans un worktree sont exclues des branches supprimables.
- **Dans l'analyse** : un dossier qui contient un fichier `.git` (et non un dossier) pointant vers `<dépôt>/.git/worktrees/<nom>` est marqué comme worktree et rattaché à son dépôt dans la liste des projets.

### 9. Restauration : rsync `--backup`, étapes administrateur dans Terminal
- La copie utilise `rsync -a --backup --suffix=.pre-restore`. Pour une sauvegarde héritée, les dossiers des outils IA sont exclus de la copie du home : ils passent par la fusion.
- **Mac neuf** : le Trousseau est vide. Les mots de passe du NAS et de l'image sont demandés (app et `cairn restore`) et ne servent qu'à la session ; l'image d'une autre machine est reprise, et l'app permet de se connecter à un NAS sans configuration.
- Une sauvegarde héritée est reconnue à la présence de `manifest/system.txt` et de `home/`, puis adaptée au même modèle interne que le format Cairn.
- L'installation des Command Line Tools ou de Homebrew s'ouvre dans Terminal (`osascript` avec `do script`). Cairn attend ensuite la présence de `brew` ou de `xcode-select -p`, en vérifiant toutes les 5 secondes, sans jamais manipuler de mot de passe administrateur.
- L'app tourne sans les CLT, puisque le runtime Swift fait partie de macOS : elle peut donc être le premier outil lancé sur un Mac neuf.

### 10. Planification, tâche de fond, veille et réseau
- **Planificateur** : un planificateur dans l'app (minuterie toutes les minutes). Il compare l'échéance à la dernière réussite enregistrée dans `~/.cairn/state/runs.json`, ce qui couvre aussi les échéances manquées.
- **Tâche de fond** : l'assistant explique pourquoi l'app doit rester active, et l'accord est enregistré dans `schedule.background`. Avec l'accord : `SMAppService.mainApp` (ouverture à la connexion) et une politique d'activation `.accessory` quand la fenêtre est fermée (icône dans la barre des menus, pas d'icône dans le Dock). Sans l'accord : app classique, dont la fermeture arrête tout.
- **Veille** : on n'utilise pas `pmset schedule wake`, donc Cairn ne réveille jamais le Mac. Pendant une sauvegarde, une assertion IOKit `PreventUserIdleSystemSleep` empêche seulement la veille par inactivité. Les notifications `NSWorkspace.willSleep` et `didWake` suspendent rsync (SIGSTOP), puis le relancent ou reprennent la version incomplète au réveil.
- **Batterie** : lue avec `IOPSCopyPowerSourcesInfo` et `ProcessInfo.isLowPowerModeEnabled`. Le planificateur attend tant que les conditions ne sont pas remplies.
- **Destinations joignables** : `NWPathMonitor` détecte les changements de réseau. Pour un fournisseur SMB, on sonde le port 445 de l'hôte (délai de 3 s) avant de monter le partage, et le fournisseur local vérifie la présence du volume. Une destination injoignable passe « en attente » dans `runs.json`, et chaque changement de réseau ou montage de volume relance la sonde. La notification de retard suit la règle de la spec (plus d'un jour de retard, une par jour au plus).
- **Une seule opération à la fois** : un verrou `flock` sur `~/.cairn/state/operation.lock`, partagé par l'app et la commande, protège la sauvegarde et la restauration.
- **Notifications** : `UNUserNotificationCenter`.

### 11. Interface inspirée de Codex
Disposition :
- à gauche, une **barre d'icônes** étroite (Accueil, Analyse, Sauvegardes, Outils IA, Outils CLI, Git, Restauration, avec Réglages et l'état en bas) ;
- puis une **barre latérale** gris très clair, avec des sections titrées en gris (« Dossiers suivis », « Projets », « Destinations ») et des lignes icône et libellé sans séparateurs ;
- enfin une **zone de contenu** blanche et aérée.

Éléments :
- en haut de la zone de contenu, un **sélecteur segmenté** centré en forme de pilule pour les sous-vues (par exemple Explorateur / Nettoyable / Gros objets) ;
- un **accueil** centré : grand titre (« Que voulez-vous faire ? »), carte très arrondie (rayon 16 à 20) avec une ombre légère, actions rapides en pilules (Analyser, Sauvegarder maintenant, Restaurer) et état de la dernière sauvegarde ;
- une typographie SF Pro, des icônes SF Symbols monochromes et un seul accent bleu. Les couleurs des catégories ne servent qu'aux graphiques. Mode sombre pris en charge.

Mise en œuvre :
- des composants maison (`Sidebar`, `RailButton`, `PillPicker`, `Card`) plutôt que les styles de liste par défaut ;
- l'alias `@ViewState` est conservé, et `@Observable` et `#Preview` restent évités ;
- on reprend l'esprit (sobriété, hiérarchie), jamais le logo, le nom ni les éléments propres à OpenAI.

### 12. Retrait des scripts après preuve de parité
On lance `cairn backup --dry-run` et `backup.sh --dry-run` sur les mêmes sources, puis on compare les listes de fichiers à copier. On fait de même pour `cairn git --json` et le rapport TSV de `git-cleanup.sh`. Les scripts ne sont supprimés que si les écarts sont expliqués (par exemple la sélection du home, qui change volontairement).

### 13. Langues : fichiers `.strings` par langue, clés anglaises stables
- **Catalogues** : les textes sont dans `Resources/en.lproj/Localizable.strings` et `Resources/fr.lproj/Localizable.strings` de `CairnCore` (avec `.stringsdict` pour les pluriels), et `defaultLocalization: "en"` est déclaré dans le package. Les clés sont des identifiants anglais stables (`backup.confirm.title`), pas des phrases.
- **Pourquoi pas les String Catalogs (`.xcstrings`)** : leur compilation passe par l'outillage de Xcode, absent ici. Les `.strings` sont copiés tels quels par SwiftPM avec les seules Command Line Tools.
- **Accès** : un utilitaire `L10n` charge le bundle de la langue active (`auto` → `Bundle.preferredLocalizations` limité à `en` et `fr`), et l'interface l'utilise à la place de `Text("…")`, qui chercherait dans le bundle principal. La langue active est publiée par l'app, donc un changement dans les réglages redessine l'interface sans redémarrage. La ligne de commande lit `--lang`, puis `config.toml`, puis le système.
- **Formats** : tous les formatages (tailles, nombres, dates, durées) passent par la `Locale` de la langue active, au lieu du `fr_FR` codé en dur aujourd'hui dans `Fmt`.
- **Données** : manifests, `config.toml`, TSV et `--json` utilisent des identifiants, des octets et des dates ISO 8601, jamais des textes traduits.
- **Contrôle** : un test compare les clés des deux catalogues et échoue s'il en manque une ou si un format (`%@`, `%lld`) diffère. Un second test cherche, dans les sources de l'interface et de la ligne de commande, des chaînes affichées sans passer par `L10n`.
- `build-app.sh` copie le bundle de ressources de SwiftPM dans `Cairn.app/Contents/Resources` et déclare `CFBundleLocalizations` (`en`, `fr`) dans `Info.plist`.
- *Alternative écartée* : tout traduire à la volée depuis des dictionnaires Swift. Pas de pluriels, et des textes mêlés au code.

### 14. Contrôle d'intégrité : empreintes incrémentales
- **Liste des empreintes** : chaque version contient `checksums.tsv` (chemin relatif, taille, `mtime`, SHA-256). Après rsync, la liste des fichiers transférés (`--out-format=%n`) donne ceux à hacher. Les autres reprennent la ligne de la version précédente, puisqu'ils sont liés au même fichier. Le hachage tourne en parallèle avec CryptoKit et une priorité basse.
- **Vérification mensuelle** : `hdiutil verify` de l'image, plus un échantillon aléatoire de 2 % des fichiers de la dernière version (au moins 500 et au plus 5 Go lus). La vérification complète relit tout.
- **Fichiers abîmés** : un fichier qui ne correspond plus est inscrit dans `damaged.tsv` de la version. La sauvegarde suivante passe ces chemins à rsync en `--files-from` sans `--link-dest`, ce qui force la recopie depuis la source au lieu de lier la copie abîmée.

### 15. Barre des menus inspirée de CleanMyMac
- **Mise en œuvre** : `MenuBarExtra` avec le style `.window`, ce qui donne un panneau libre (environ 360 × 520 pt) et non un menu texte. L'icône est un SF Symbol de Cairn, dont la variante change avec l'état (normal, en cours, attention, erreur).
- **Présentation**, dans l'esprit du menu de CleanMyMac :
  - en tête, une grande jauge circulaire du volume principal (espace utilisé et libre), avec les autres volumes suivis en petites jauges en dessous ;
  - des cartes arrondies : « Récupérable » (régénérable, worktrees obsolètes, corbeille), « Sauvegarde » (dernière, prochaine, en attente) et « Alertes » ;
  - en bas, des boutons pleine largeur : Nettoyer, Sauvegarder maintenant, et un menu « … » pour Analyser, Ouvrir Cairn, Réglages et Quitter.
- **Couleurs** : fond en dégradé sombre ou en matériau vibrant selon le mode, chiffres en grand. On reprend la lisibilité et la hiérarchie, jamais les illustrations, le nom ni les couleurs de marque de CleanMyMac.
- **Données** : le panneau lit uniquement l'état en mémoire (dernière analyse résumée, `runs.json`, capacité des volumes), ce qui garantit l'affichage en moins d'une demi-seconde.

### 16. Alertes de disque plein
- **Relevés** : la capacité vient de `URLResourceValues` (`volumeAvailableCapacityForImportantUsage`), relevée toutes les 15 minutes et à chaque fin d'opération, et gardée sur 30 jours dans `state/volumes.json`.
- **Prévision** : régression linéaire sur les relevés des 7 derniers jours. Pas d'alerte anticipée si la pente est positive (on libère de l'espace) ou s'il y a moins de 3 jours d'historique.
- **Anti-harcèlement** : état par volume (dernier niveau notifié, date, sourdine jusqu'à) avec une marge de 2 points pour éviter qu'un volume qui oscille autour du seuil déclenche plusieurs alertes. Notifications actionnables (« Nettoyer », « Ignorer 7 jours ») avec `UNNotificationCategory`.
- **Espace récupérable** : il vient du résumé de la dernière analyse, enregistré dans `state/analysis-summary.json`, et de la taille de `.Trashes`.

### 17. Journaux
Les journaux sont dans `~/.cairn/logs/<type>-<horodatage>.log`. Un nettoyage au démarrage, puis une fois par jour, supprime ceux qui dépassent `logs.retention_days`, sauf ceux cités dans le manifest d'une version encore gardée. Chaque manifest nomme son journal (`log`), et `runs.json` garde par destination la liste des journaux des versions présentes (`keptLogs`), lue par la purge même quand la destination est injoignable.

## Risks / Trade-offs

- [`swift test` n'a peut-être pas XCTest ni swift-testing avec les seules CLT] → La première tâche le vérifie. Sinon, les tests de `CairnCore` passent par un exécutable `cairn-selftest` lancé par `just test`.
- [`SMAppService.mainApp` pour une app ad hoc dans `~/Applications`] → À tester tôt. En cas d'échec, on se rabat sur un élément d'ouverture ajouté par AppleScript à System Events, ou on documente l'ajout manuel.
- [Perte du mot de passe de l'image chiffrée = sauvegarde irrécupérable] → Le mot de passe est affiché à la création, un export est proposé, et l'app demande de confirmer qu'il a été noté.
- [Une image sparsebundle montée au moment d'une coupure réseau peut être abîmée] → `hdiutil verify` avant chaque sauvegarde et `hdiutil compact` après la rétention. La version en cours ne devient visible qu'une fois renommée.
- [Différences entre openrsync et GNU rsync (options, progression)] → Le moteur détecte le binaire et adapte ses options, et les tests passent sur les deux.
- [Changement de comportement : le home passe d'une liste d'exclusions à une liste d'inclusions] → L'assistant présélectionne tout ce que `backup.sh` copiait. La comparaison de parité (décision 12) montre les éléments retirés.
- [Le hachage SHA-256 de la première sauvegarde (des dizaines de Go) allonge sa durée] → Il tourne en parallèle de la copie suivante, à basse priorité. Une version reste valide sans liste d'empreintes complète : elle est marquée « vérification en attente ».
- [Un SIGSTOP pendant la veille peut laisser une connexion SMB morte au réveil] → Au réveil, on vérifie que le partage est toujours monté et on remonte si besoin. Si rsync échoue, on le relance sur la même version incomplète.
- [La politique `.accessory` masque l'app du Dock et du sélecteur d'apps] → La fenêtre principale repasse en `.regular` à son ouverture.
- [Les formats internes de Claude et Codex changent sans prévenir] → Les profils sont versionnés et séparés du code. Un chemin attendu absent est signalé dans la vue IA au lieu de faire échouer la sauvegarde.
- [Fusionner des bases SQLite est impossible sans connaître leur schéma] → Les bases sont restaurées en bloc, sur confirmation et avec copie `.pre-restore`. Seuls les fichiers de conversations (`jsonl`) sont fusionnés un par un.
- [48 versions d'un workspace actif peuvent remplir le NAS malgré les liens physiques] → Chaque version affiche sa taille propre (ce qu'elle seule occupe), et les réglages montrent l'espace total des versions face à l'espace libre de la destination.
- [Des textes ajoutés dans une seule langue au fil des tâches] → Le test de parité des catalogues tourne avec `just test`, et chaque tâche d'interface est vérifiée dans les deux langues.
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
- Le jour et l'heure par défaut de la sauvegarde hebdomadaire : ajustables dans les réglages sans changer la spec.
