# Cairn : liste de contrôle de parité fonctionnelle (Swift → Electron + TypeScript)

Sources lues : `openspec/specs/*/spec.md`, les delta specs de `openspec/changes/{app-updates,component-gallery,edit-and-delete-destination,git-row-actions,home-hub}`, `Cairn/Sources/CairnCore/*.swift`, les parties logiques de `Cairn/Sources/Cairn/*.swift` (BackupController, AppModel, GitView, BackupView, MenuBarPanel), les 26 fichiers de `Cairn/Tests/CairnTests`, `git log origin/main` (109 commits) et `tasks/lessons.md`.

Légende :
- ⚠ = écart entre spec et code ;
- 🆕 = comportement codé mais non spécifié ;
- ❌ = spécifié mais non codé, ou seulement en partie ;
- 🐞 = bug corrigé à verrouiller par un test.

---

## 1. Règles métier par domaine

### 1.1 backup

**Parties d'une version** (`BackupService.parts`). Elles sont produites dans cet ordre :
- `folders/<nom>` : un dossier suivi avec `backup=true` et disponible. Le nom est le dernier composant du chemin. En cas de doublon, on ajoute `-` jusqu'à ce que le nom soit unique.
- `home` : source = home, avec `--files-from` = les éléments sélectionnés qui existent, hors dossiers IA. Exclusions = `homeExcludes` + `[home].exclude`.
- `tools` : inventaire exporté (`tools.toml` + `Brewfile`) dans un dossier de staging temporaire.
- `ai/<outil>/<catégorie>` et `ai/<outil>/meta` (voir §1.6).
- Un manifest `manifest.json` (voir §3.9).

**Sélection `--only folders|home|tools|ai` ou `--tool`.** La version est marquée `partial:true`. Une version partielle :
- ne devient pas `latest` ;
- ne sert pas de base `--link-dest` (la base est choisie par partie) ;
- n'est pas comptée par la rétention ;
- n'est pas la version proposée par défaut à la restauration ;
- est supprimée dès qu'une version complète plus récente existe.

**Destinations.**
- Fournisseurs `local` et `smb`, via le protocole `BackupProvider` (`isReachable`, `prepare(create:)`, `finish`).
- Joignabilité locale : si le chemin est sous `/Volumes/X/…`, le volume `/Volumes/X` doit exister ; sinon, le dossier parent doit exister.
- Joignabilité SMB : connexion TCP au port de l'URL (445 par défaut) en moins de 3 s.
- 🆕 Une destination SMB passe **toujours** par une image sparsebundle, même sans chiffrement (`usesImage = smb || encrypted`), pour garder des liens physiques et des droits fiables. La spec ne parle d'image que pour le chiffrement.
- SMB déjà monté (`getmntinfo`, type `smbfs`, hôte et partage comparés en minuscules) : réutilisé, jamais démonté. Sinon, montage `NetFSMountURLSync` (pas d'interface, montage souple) avec le mot de passe Internet du Trousseau, puis démontage à la fin.
- Destination injoignable : `waitingSince` est posé, `lastAttempt` mis à jour, résultat `waiting:true`. **Ce n'est pas un échec** : pas de `lastFailure` (🐞 c459b58).
- Plusieurs destinations : copie séquentielle. La finalisation d'une destination (empreintes, vérification mensuelle, image, compactage) tourne en arrière-plan pendant la copie vers la suivante (🆕 eb1fc60).
- « Arrêter » sur une destination n'arrête qu'elle. Si toutes les destinations visées sont arrêtées, toute la sauvegarde s'arrête, préparation comprise.
- Un arrêt pendant la préparation lève `cancelled`. Ce n'est pas un échec : pas de `lastFailure`, pas de notification (🐞 bfbbb61).
- Une erreur **avant** les destinations (base IA illisible, inventaire…) est notée sur chaque destination visée : `lastAttempt`, `lastFailure`, `lastError` (🐞 7cc955d).

**Versions et reprise.**
- Nom de version : `yyyy-MM-dd'T'HHmmss` (heure locale, locale `en_US_POSIX`).
- Dossier de travail : `.incomplete-<nom>`. À la fin : renommage atomique, puis lien symbolique `latest` → nom de la version (sauf pour une version partielle).
- Reprise : on reprend le `.incomplete-*` le plus récent s'il a moins de 7 jours (`maxResumeAge`), on supprime les autres. Au-delà de 7 jours, on repart d'une nouvelle version.
- `--partial-dir=.cairn-partial` : un gros fichier interrompu reprend où il en était.

**Rétention.** Appliquée **uniquement après une version réussie** (voir §3.2).
- 🆕 Dans les réglages, quand la rétention est réduite, l'app calcule `excessVersions` et `uniqueBytes`, demande confirmation, supprime les versions puis compacte l'image.
- ⚠ Cette suppression manuelle (`BackupView.deleteVersions`) **ne prend pas `OperationLock`**, alors qu'une sauvegarde et une suppression de destination le prennent. Dans la nouvelle version, prendre le verrou.

**Planification** (`BackupSchedule.decide`, tick de l'app toutes les 60 s, plus au réveil, au montage d'un volume et au changement de réseau via NWPathMonitor, 5 s après). Les décisions sont testées dans cet ordre :
1. `manual` ;
2. `notDue` : `lastSuccess` est postérieur à la dernière échéance (`lastOccurrence`) ;
3. `alreadyRunning` ;
4. `retryLater` : `lastFailure` est postérieur à `lastSuccess` et date de moins de 3600 s (🐞 7cc955d, c459b58) ;
5. `waitingPower` : sur batterie, et mode économie d'énergie ou batterie sous `on_battery_min_percent` (20 par défaut) ;
6. `waitingDestination` ;
7. `run`.

Autres règles de planification :
- Hebdomadaire : `weekday` parmi monday…sunday, à l'heure `time`.
- Une configuration invalide bloque toute sauvegarde planifiée.
- Les règles d'alimentation ne s'appliquent qu'aux sauvegardes planifiées : un lancement manuel ne vérifie pas la batterie.
- Prochaine échéance (`Health.nextBackup`) : la dernière occurrence si elle est due, sinon +1 jour (quotidien) ou +7 jours (hebdomadaire).

**Retard.**
- `shouldNotifyOverdue` : le retard se compte depuis la plus ancienne échéance manquée après la dernière réussite. Notification si le retard dépasse 24 h et qu'aucune notification n'a été envoyée depuis 24 h (`lastOverdueNotice`).
- Seulement pour une destination en attente.
- 🐞 46a9475 : relire `runs.json` juste avant d'écrire `lastOverdueNotice`.

**Veille et alimentation.**
- Assertion `PreventUserIdleSystemSleep` pendant la sauvegarde.
- `willSleep` → SIGSTOP sur les rsync ; `didWake` → SIGCONT, puis tick.
- Quitter l'app annule la sauvegarde et attend 5 s : la version reste incomplète et sera reprise.

**Intégrité.** Voir §3.3.
- Vérification mensuelle (`verificationInterval` = 30 jours depuis `lastVerification`) : un échantillon de la nouvelle version, puis `hdiutil verify` de l'image une fois détachée.
- Fichiers abîmés → `damaged.tsv`, puis `damagedVersions` dans `runs.json`, puis une notification.
- La sauvegarde suivante recopie ces fichiers depuis la source (`forceRecopy`), sans lien vers la copie abîmée.
- `stillDamaged` retire les versions disparues ou entièrement recopiées.

**Simulation** (`--dry-run`). Elle n'écrit rien sur la destination : pas d'image, pas de dossier, pas de `versions/`.
- Destination encore vide : `notCreated` → simulation contre un dossier vide temporaire, tout serait copié.
- Après une sauvegarde : comparaison directe à la version de base (rsync `-n` vers la base, sans `--link-dest`), car openrsync échoue avec `-n` et un `--link-dest` absent (🐞 e229e52).
- Une simulation n'écrit ni `runs.json` ni l'activité.

**Journal et état.**
- Journal : `logs/backup-<yyyyMMdd-HHmmss>.log` (ou `backup-dry-run-…`), lignes `<ISO8601> <texte>`.
- Le manifest nomme son journal (`log`). Les journaux des versions encore présentes (`keptLogs`) échappent à la purge.
- Les avertissements rsync 23/24 et les bases IA illisibles sont des avertissements dans le journal et le résultat, pas des échecs.

**Notifications de l'app.**
- Échec : sauf simulation, sauf arrêt demandé, sauf verrou tenu par une autre opération (simple message).
- Fichiers abîmés, échec de `hdiutil verify`, retard.
- Une notification avec journal ouvre ce journal.
- `Notifier` : jamais de UNUserNotificationCenter hors d'un bundle `.app` (le process planterait).

**Mot de passe d'une nouvelle image chiffrée.** Généré au format `XXXXXX-XXXXXX-XXXXXX-XXXXXX` (alphabet sans 0/O/1/l/I), rangé au Trousseau. Il est affiché **une seule fois** : `newImagePassword` dans le résultat, et la ligne CLI `cli.backup.image_password`.

**Ajout d'une destination vérifiée** (`DestinationProbe`, `ProbeSession`).
- Contrôles :
  - volume présent (`/Volumes/X`) ;
  - le dossier existe ;
  - fichier témoin `.cairn-write-test-<UUID>` (contenu `cairn`) créé puis supprimé ;
  - espace libre (`volumeAvailableCapacityForImportantUsage`, à défaut `statfs`) ;
  - images `cairn-*.sparsebundle` existantes, celle de ce Mac repérée.
- Nettoyage des anciens témoins : seulement un fichier ordinaire au nom `préfixe+UUID valide`, de 5 octets, au contenu `cairn` (🐞 156f978).
- SMB : connexion au partage, mot de passe saisi sinon celui du Trousseau. Le partage monté pour la vérification reste monté pour parcourir les dossiers, puis `close()` démonte seulement ce que la session a monté.
- **Le Trousseau n'est écrit qu'après l'enregistrement réussi de `config.toml`** (🐞 156f978).
- Codes de montage :
  - 80, 13, -5045, -5046, -5999 → `authenticationFailed` ;
  - 2, -5998, -6003 → `notFound` ;
  - sinon `mountFailed(code)`.
- 🐞 0547a02 (leçon) : `smb://hôte` sans partage n'est pas une erreur. On liste les partages avec `smbutil view -f [-N] //user@host`, mot de passe sur stdin (jamais en argument), et on ne garde que les partages de type `Disk` sans `$` final, triés naturellement. Le partage choisi reçoit un dossier `cairn`.
- Navigateur de dossiers :
  - racines = volumes de `/Volumes` (sauf le lien vers `/`), triés, puis le home ;
  - sous-dossiers visibles, sans paquets, en tri naturel ;
  - `accessDenied` ou `notFound` selon le cas.
- Création de dossier : nom rogné ; refus si vide, `.`, `..`, s'il contient `/` ou `:`, ou s'il existe déjà.
- Adresse finale : `smb://host/share/sous/dossier`, chaque segment encodé en pourcents.
- Identifiants de destination : `main` pour la première, puis `nas` / `disk`, puis `nas-2`, `disk-3`…
- Revenir à la liste des emplacements, ou débrancher le disque, invalide la vérification. « Terminer » renvoie à l'étape devenue invalide.
- « Restaurer cette sauvegarde » ouvre l'image choisie (`preferredImage`), pas celle de ce Mac ni la première trouvée (🐞 156f978).

**Delta edit-and-delete-destination.**
- Modifier une destination ne change que `path`, `url` et `username` (`updatingConnection`). `id`, `provider`, `encrypted`, `retention` et `keychain` restent.
- Mot de passe laissé vide → celui du Trousseau ; le Trousseau n'est pas modifié.
- Une image recréée reprend le mot de passe déjà rangé sous `fr.lenzotti.cairn.image.<id>` / machine, et ne le remplace jamais (🐞 76e40ec).
- Suppression d'une destination :
  - plan (simulation) = entrée de configuration + état, avec en option les sauvegardes **de ce Mac seulement** (`cairn-<machine>.sparsebundle`, ou `cairn/<machine>` en clair) et leur taille `uniqueBytes` ;
  - destination injoignable → `backupsUnavailable`, l'exécution est refusée si les sauvegardes sont demandées ;
  - exécution sous `OperationLock` : la destination sort d'abord de `config.toml` (rien n'est supprimé si l'écriture échoue), puis les sauvegardes sont supprimées (chemin recalculé sous la racine montée à ce moment), puis l'état. En cas d'échec, l'entrée est remise dans la configuration ;
  - **les mots de passe (image et partage) ne sont jamais supprimés du Trousseau** (🐞 76e40ec).
- Historique de la page : chargé à l'ouverture si la destination est joignable, puis démonté. Rechargé après une sauvegarde. Un échec de lecture ne bloque pas le rechargement automatique, sans boucle de nouvelles tentatives.
- Actions indisponibles (`BackupActions.unavailableReason`), par priorité :
  1. sauvegarde en cours → `running` ;
  2. vérification en cours → `verifying` ;
  3. `reachable == false` → `unreachable` (`nil` = pas encore sondée, ne bloque pas) ;
  4. aucune sauvegarde → `nothing_to_verify` (pour verify et verifyFull).

### 1.2 restore

**Sources.**
- Version Cairn : `manifest.json`.
- Sauvegarde héritée de `backup.sh` : `manifest/system.txt` (`date=yyyy-MM-dd HH:mm:ss`, `host`, `arch`, `home`, `workspace`) + `home/`, `workspaces/`, `ai/`.
- Versions de toutes les machines : `cairn/<machine>/versions/*` (dossiers commençant par `.` ignorés).

**Version par défaut** : la plus récente version **complète de ce Mac**, sinon la plus récente complète toutes machines, sinon la plus récente.
- 🐞 46a9475 : trier par nom de version (horodatage), pas par ordre de liste.
- `--version X` préfère ce Mac. Une version absente → erreur d'usage (code 2), jamais de repli.

**Mac neuf.**
- Mot de passe du partage et de l'image demandés : `readpassphrase` sans écho en CLI, saisie dans l'app.
- Si l'image de ce Mac n'existe pas, on prend celle d'une autre machine (`SparseImage(existing:)`, chiffrement lu par `hdiutil isencrypted`).
- `createIfMissing:false` : ne jamais créer d'image ni de dossier en restauration.

**Plan.**
- Parties : `tools`, `home`, `ai` (outils), `folders` (nom → cible).
- Récapitulatif des tailles (`Scanner.measure`) avant confirmation.
- Simulation par défaut ; `--apply` pour écrire.
- Avertissement si l'architecture diffère.

**Copie.**
- `/usr/bin/rsync -a --backup --suffix=.pre-restore [-n] [--exclude=/<dossiers IA> si héritée] src/ dst/`. Les codes 0, 23 et 24 comptent comme réussis.
- La simulation ne crée pas la cible (🐞 e229e52).
- 🐞 3692993 / RestoreTests : pour une sauvegarde héritée, le home exclut les dossiers IA, laissés à la fusion IA.

**Après une copie appliquée** (`fixSecretPermissions`) :
- `~/.ssh` en 700 ;
- dans `~/.ssh`, les fichiers en 600, sauf `*.pub`, `known_hosts` et `config` en 644 ;
- `.netrc`, `.codex/auth.json`, `.codex/.credentials.json` et `.aws/credentials` en 600.

**Cible absente** (`targetIsMissing`).
- Sous `/Volumes/<nom>`, c'est le volume lui-même qui doit exister (🐞 RestoreWarningTests).
- Ailleurs, c'est le dossier parent.
- L'app propose de créer un volume APFS `workspaces` : `diskutil info /` → « Part of Whole », puis `diskutil apfs addVolume <container> APFS workspaces`.

**Réinstallation des outils.**
- Ordre : Command Line Tools (`xcode-select -p`, sinon `xcode-select --install` ouvert dans Terminal puis attente) → Homebrew (script officiel dans Terminal si `brew` est absent et qu'au moins une formule est demandée, attente de `/opt/homebrew/bin/brew` ou `/usr/local/bin/brew`) → `brew tap` → brew, mise, npm, uv, pipx, cargo, go, local-bin.
- Un outil déjà présent (`command -v -- "$1"` en argument positionnel) est ignoré.
- 🐞 46a9475 : ne jamais faire interpréter un nom d'outil par le shell.
- Chaque échec est noté et la suite continue. Une étape `check` finale liste les outils manquants.
- Commandes d'installation :
  - `brew install <n>` ;
  - `mise use -g <n>@<requested|latest>` ;
  - `mise exec -- npm install -g <n>` ;
  - `uv tool install --force [--python X] <n>[extras]` ;
  - `pipx install <n>` ;
  - `cargo install <n>`.
- ⚠ La spec dit « puis cargo et go » : **go et local-bin ne sont pas réinstallés** (`installCommand` = nil, détail « manuel »).
- Le PATH élargi de `SystemRunner` : `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/share/mise/shims`, `~/.cargo/bin`, `~/go/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, avec `HOMEBREW_NO_AUTO_UPDATE=1`.

**Outil IA ouvert** pendant la restauration : on attend qu'il soit quitté (vérification toutes les 2 s, 10 min au plus). Sinon l'étape `ai/<id>` est en échec et rien n'est écrit (🐞 3692993).

**Lecture des listes héritées.**
- `Brewfile` : lignes `tap "x"` et `brew "x"`.
- `npm-globals.txt`.
- `uv-tools.txt` : `nom[extras]|python`.
- `mise-config.toml` : `[tools]`, valeur chaîne, tableau (1re valeur) ou table inline `version`.
- `pipx.json` : `venvs`.
- Les noms hérités sont convertis en commandes par `rules.json` : ripgrep → rg, `php@8.4` → php, `@scope/cli` → scope, python → python3.

### 1.3 git-maintenance

**Découverte.**
- Dossiers contenant `.git` (dossier). On ne descend ni dans un dépôt, ni dans un dossier non-`source` au sens de `Scanner.classify`, ni dans `.Spotlight-V100`, `.fseventsd`, `.DocumentRevisions-V100` ou `.TemporaryItems`.
- Liens symboliques ignorés. Résultat dédoublonné et trié.

**Branche principale** : `symbolic-ref refs/remotes/origin/HEAD`, sinon `refs/remotes/origin/{main,master,develop}`, sinon `refs/heads/{main,master,develop}`.
- Protection par **nom court** : `isMainBranch` retire `refs/heads/` ou `refs/remotes/<remote>/`. La branche reste protégée même extraite dans un worktree lié (🐞 01538a8). `main-old` n'est pas `main`.

**Branches « gone ».**
- `for-each-ref refs/heads`, format `%(refname:short)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:short)%1f%(subject)`, avec `track` contenant `gone`.
- Jamais la branche courante ni la principale.

**Statut** (`mergeStatus`) :
1. `merge-base --is-ancestor` → `merged` ;
2. sinon `merge-base`, puis `diff --quiet base ref` : code 0 → `merged`, code 1 → suite, **autre code → `unmerged`** (🐞 46a9475) ;
3. `diff base ref | patch-id --stable` comparé aux patch-ids de `log -p --no-merges base..main` : identique → `squash`, sinon ou illisible → `unmerged`.

**Worktrees.**
- `worktree list --porcelain`. Le premier est le dépôt lui-même ; les `bare` sont ignorés.
- Mesures : taille et part régénérable (`Scanner.measure`), `status --porcelain` (`??` = non suivi), `rev-list --count HEAD --not --remotes` (0 si la branche est intégrée), dernière modification (200 000 entrées au plus, hors `.git` et régénérable).
- Raison d'obsolescence : `orphan` (dossier absent ou `prunable`) > `merged` (branche merged ou squash) > `stale` (inactif depuis plus de `staleDays`, 30 par défaut).
- Statut : `risk` si le dossier existe et qu'il y a du travail (modifié, non suivi ou non poussé) ; sinon la raison d'obsolescence ; sinon `active`. Un worktree `risk` garde sa `staleReason`.
- 🆕 Une branche merged ou squash d'un worktree est ajoutée à la liste même si son amont existe encore. Elle est rattachée au worktree (`checkedOutInWorktree`) et n'est jamais présélectionnée seule (🐞 StorageWarningTests).

**Présélection** (CLI et hub ; dans l'app, rien n'est présélectionné, delta git-row-actions).
- Branche : non extraite et non `unmerged` (sauf `--include-unmerged`).
- Worktree : obsolète et pas à risque (sauf `--include-at-risk`).
- Plus les branches intégrées des worktrees retirés (`branchesFollowing`).

**Lecture seule.**
- Aucun appel réseau, sauf `fetch_before` ou `--fetch` (`fetch --all --prune --quiet`, seulement s'il y a un remote).
- 🐞 85501aa : « Tout vérifier » ne fait jamais de fetch (`--prune` supprime des refs) et ignore le filtre `only`.
- Environnement git : `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"`, stderr ignoré.

**Application** (`apply`).
- Worktrees d'abord : une ligne de journal, puis `worktree remove [--force --force si à risque] <path>`. Un orphelin est seulement retiré de l'index. Puis `worktree prune`.
- Branches ensuite : `rev-parse`. Si le SHA ne commence plus par celui vu à l'analyse, échec et la branche est gardée (🐞 46a9475). Sinon, ligne de journal puis `branch -D`.
- Compactage :
  - `pruneNow` → `reflog expire --expire-unreachable=now --all` puis `gc --quiet --prune=now`, ou `prune --expire=now` si gc est désactivé (🐞 StorageWarningTests) ;
  - sinon, si gc est activé, `gc --quiet`.
- Sous `OperationLock("git-clean")`, partagé avec la sauvegarde (🐞 46a9475).

**Journal** `<git-dir absolu>/cleanup-deleted-branches.log`, en ajout, colonnes séparées par des tabulations :
- branche : `yyyy-MM-dd HH:mm:ss<TAB><branche><TAB><sha complet>` ;
- worktree : `yyyy-MM-dd HH:mm:ss<TAB>worktree<TAB><path><TAB><branche|-><TAB><head>`.

**Espace récupérable** : `rev-list --stdin --objects --disk-usage`, avec en entrée les refs supprimées et `^` devant toutes les autres refs.

**Taille** : `count-objects -v` (`size` et `size-pack` × 1024).

**Rapport par dépôt** (delta git-row-actions) :
- `lastModified` = max(commit le plus récent de toutes les refs, fichier le plus récent) ;
- `modifiedFiles` = lignes de `status --porcelain` ;
- `unpushedCommits` = `rev-list --count --branches --not --remotes` ;
- `isAtRisk` → une confirmation dédiée avant de mettre le dépôt dans la corbeille.

**App** (delta git-row-actions).
- Menu « … » par ligne : Finder, copier, analyser seul, compacter (confirmé, option `pruneNow`), corbeille (dépôt), supprimer (branche ou worktree).
- Une suppression se fait avec `gc=false` et `pruneNow=false`. Ensuite, mise à jour ciblée : `removing()` puis `refreshSizes()`, sans nouvelle analyse.
- Une branche extraite dans un worktree ne se supprime pas seule : on supprime le worktree, qui propose sa branche (non cochée).
- Suppressions indisponibles pendant l'analyse ou pendant une autre opération sur le même dépôt.
- 🐞 8171ca8 : chaque rapport s'affiche dès qu'il est prêt. L'arrêt garde les résultats précédents.

**CLI.**
- Options : `--root` (répétable ; par défaut les dossiers suivis, sinon `/Volumes/workspaces`), `--only`, `--worktrees-only`, `--stale-days`, `--include-unmerged`, `--include-at-risk`, `--prune-now`, `--no-gc`, `--fetch`, `--report <tsv>`, `--apply`, `--yes`, `--json`.
- Progression sur stderr seulement si c'est un terminal (🐞 ef55c5b).
- ⚠ Avec `--apply` et gc activé, `apply` (donc `git gc`) tourne sur **tous** les dépôts analysés dès qu'au moins un élément est à supprimer, pas seulement sur les dépôts nettoyés (`where … || o.gc`). La spec dit « dépôts choisis ». À trancher, puis à reproduire ou corriger.

**TSV** : `repo\tbranche\tstatut\tsha\tdernier_commit\tsujet`. Une ligne par branche du rapport, `repo` relatif à la racine s'il n'y en a qu'une.

### 1.4 storage-analysis

**Parcours.**
- Les deux premiers niveaux sont listés, puis chaque sous-arbre est parcouru en parallèle par `fts` (`FTS_PHYSICAL|FTS_NOCHDIR|FTS_XDEV`).
- Les points de montage ne sont jamais franchis : `st_dev` ≠ celui de la racine.
- Taille = `st_blocks*512` (taille sur disque).
- Un fichier régulier avec `nlink>1` n'est compté qu'une fois par `(dev, ino)`, y compris **entre dossiers suivis** (le contexte est partagé).
- Un dossier classé non-source est compté en bloc : on n'y descend pas dans l'arbre, mais les octets sont comptés.
- Fichiers ≥ 10 Mio listés comme nœuds. Gros fichiers ≥ `big_file_threshold_mb`×1 000 000.
- Annulation contrôlée tous les 2000 à 5000 fichiers et aux niveaux ≤ 2 : arrêt en moins de 2 s, le résultat précédent reste.
- Progression : fichiers, octets, chemin courant, erreurs (`FTS_DNR`, `FTS_ERR`, `FTS_NS`).

**Classement** : voir §3.1. Catégories `source`, `git`, `deps`, `build`, `ios`, `python`, `cache`, `trash`. Régénérable = deps, build, ios, python, cache (ni git ni trash).

**Gros dossiers** (`BigObjects.find`) : taille hors gros fichiers ≥ `big_folder_threshold_gb`×1e9, au niveau le plus précis. La racine n'est jamais listée.

**Projets** (`Projects.find`, profondeur ≤ 5).
- Un dépôt git ou un dossier avec un marqueur : `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `composer.json`, `Package.swift`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `Gemfile`, `pubspec.yaml`, `requirements.txt`.
- Pas de descente dans un projet.
- Worktrees rattachés au dépôt d'origine grâce au fichier `.git` (`gitdir: …/.git/worktrees/x`, chemin relatif résolu).
- `totalSize` = taille + worktrees situés hors du dépôt.

**Nettoyage.**
- Corbeille (`trashItem`) par défaut, ou suppression définitive, toujours après confirmation (chemins et taille).
- Totaux mis à jour sans nouvelle analyse (`Node.detach`).
- Présélection depuis une alerte (`CleanupSuggestion.preselect`) : dossiers régénérables ≥ 100 Mo, les 10 plus gros.

**Résumé persistant** `state/analysis-summary.json` : régénérable par type + worktrees obsolètes + corbeille. Lu par la barre des menus et les alertes. « Analyse ancienne » au-delà de 7 jours.

**CLI `analyze [dossiers…]`.**
- Par défaut : les dossiers suivis, sinon `/Volumes/workspaces`. Lecture sans migration ni écriture de la configuration.
- Un dossier explicite absent → code 1. Code 1 aussi si aucun dossier n'est disponible.
- JSON : `folders[{path, available, size, files, regenerable, breakdown{<cat.key>}, errors, duration_seconds, big_objects[≤50]{kind,path,size,category}, projects[≤50]{path,size,git,regenerable,worktrees,worktree_bytes}}], total`.

### 1.5 storage-alerts

- Relevé toutes les 15 min (`MenuBarPanel`), et après une analyse, une suppression ou une opération git (`storage.check()`).
- ❌ Après une sauvegarde : pas trouvé d'appel explicite à `storage.check()`. Vérifier.
- Le relevé ne lit que la capacité du volume (`volumeAvailableCapacityForImportantUsage`).
- Historique `state/volumes.json` par nom de volume, 30 jours.
- Niveaux :
  - `critical` : moins de `critical_percent` (5) ou moins de `critical_gb` (5) ;
  - `low` : moins de `low_percent` (10) ou moins de `low_gb` (20) ;
  - les Go sont décimaux (1e9).
- Prévision : régression linéaire sur les 7 derniers jours. Il faut au moins 3 relevés et au moins 3 jours d'historique, et une pente négative. Plein dans moins de 7 jours → niveau `low` même au-dessus des seuils.
- Anti-harcèlement (`state/alerts.json` : `lastNotified`, `lastLevel`, `snoozedUntil`) :
  - une notification par volume et par 24 h ;
  - exception : passage au niveau critique (escalade) ;
  - remise à zéro quand le volume repasse au-dessus de `low_percent + 2` points **et** de `low_gb` ;
  - sourdine de 7 jours, levée par un passage au critique.
- Notification « Nettoyer » : ouvre l'écran Nettoyable avec la présélection, sans rien supprimer. L'identifiant de notification est `disk-<volume>`.
- Notifications refusées → l'alerte reste visible dans le panneau et sur l'accueil.

### 1.6 ai-tools

**Profils JSON** (`Resources/ai-tools/*.json`) : `id`, `name?`, `version`, `root`, `detect[]`, `processes[]?`, `credentials_in_keychain`, `conversations_glob?`, `categories{conversations,config,memories,credentials}`, `sqlite[]` (glob sur le chemin relatif ou le nom), `exclude[]`, `reinstall[]`.
- Ajouter un outil = ajouter un profil.
- Nom affiché : `name`, sinon `ai.<id>`.
- Profils fournis : `claude-code` (root `~`), `claude-desktop` (`~/Library/Application Support/Claude`), `codex` (`~/.codex`). Contenu exact à reprendre tel quel (fichiers de `Cairn/Sources/CairnCore/Resources/ai-tools/`).
- Détecté si l'un des chemins `detect` (relatifs au home) existe.

**Entrées de catégorie.** `x/` = dossier, sinon un fichier, ou un glob `*` dans le dernier segment (`fnmatch`). Seules les entrées existantes sont gardées.

**Partie par catégorie** : `ai/<id>/<cat>`, source = racine de l'outil, `--files-from` = fichiers hors bases. Exclusions = `exclude` + `reinstall` (sauf un dossier de `reinstall` qui contient un fichier demandé, cas de `.claude/plugins/*.json` 🐞 RestoreWarningTests) + `*-wal`, `*-shm` + les motifs `sqlite`.

**Bases** : voir §3.5. Snapshot dans `staging/ai-<id>/sqlite/<cat>/<chemin relatif>`. Une base impossible à copier → avertissement, la sauvegarde continue (🐞 65c88bb).

**`meta/profile.json`** : `profile`, `profile_version`, `home`, `root`, `categories`, `reinstall{<dir>: [noms non cachés]}`, `running[]`, `plugins{plugins[{name,version?,scope?|enabled?}], marketplaces[{name,source?}]}`.
- Source des plugins Claude : `.claude/plugins/installed_plugins.json` et `known_marketplaces.json`.
- Source des plugins Codex : `config.toml` `[plugins."x"] enabled` et `[marketplaces.x] source`.

**Identifiants.** `effectiveCategories` retire `credentials` dès qu'une destination n'est pas chiffrée (ou qu'il n'y a aucune destination).
- ⚠ La spec dit « avertir et demander confirmation si l'utilisateur coche avec une destination non chiffrée ». Le moteur, lui, **retire toujours** les identifiants : plus strict que la spec. À aligner.
- Assistant : `credentials` n'est présélectionné que si la catégorie du profil n'est pas vide (pas pour Claude Code, qui range son jeton au Trousseau).

**Pas de double copie** : les racines `~/…` et les chemins `detect` des profils sont retirés de la sélection du home (`BackupExclusions.aiManaged`).

**Outils ouverts** : `pgrep -lx <noms|…>`. Le journal note `ai: open during backup (SQLite copied by snapshot): …`.

**Vue et `cairn ai`.**
- Taille par catégorie (`Scanner.measure`), taille non copiée (reinstall), taille totale.
- Conversations : nombre de correspondances de `conversations_glob` et date de la plus récente.
- `lastBackup` : version la plus récente contenant `ai/<id>/` sur une destination locale **en clair** déjà accessible (rien n'est monté), sinon le `lastSuccess` maximal si l'outil est configuré.

**Restauration par fusion** (`AIRestore.merge`).
- Absent localement → copié.
- Même taille et mtime à moins de 1 s → rien.
- Source plus récente → locale déplacée en `.pre-restore`, puis copie.
- Sinon → la copie sauvegardée est écrite en `<f>.pre-restore`.
- `meta/` n'est jamais fusionné.

**Bases.**
- Absente localement → toujours restaurée.
- Présente → remplacée seulement avec `--replace-databases`. L'ancienne part en `.pre-restore` et son `-wal`/`-shm` en `.pre-restore-wal`/`.pre-restore-shm` (🐞 01538a8).

**Claude Code : réécriture des projets.**
- `claudeProjectName` : tout caractère non `[A-Za-z0-9]` devient `-`.
- Préfixes (home d'origine → home, dossier d'origine → cible), le plus long d'abord.
- Si la cible existe, fusion puis suppression de l'ancien dossier **seulement si la fusion a réussi**. Sinon `notRewritten` (🐞 01538a8, RestoreWarningTests).

**Données non réécrites signalées** : sessions de Claude Code, `.claude.json` s'il contient l'ancien chemin, Codex, Claude Desktop.

**Sauvegarde héritée** : `home/.claude`, `home/.claude.json`, `home/.codex`, `ai/sqlite/.codex|.claude/…`, `ai/claude-desktop/Claude`.

### 1.7 tool-inventory

**Sources** (via `/usr/bin/env` et le PATH élargi) :
- `brew leaves --installed-on-request` (🆕 seulement les formules demandées) puis `brew list --versions <…>` ; `brew tap` ;
- `mise ls --current --json` ;
- `mise exec -- npm ls -g --depth=0 --json` (sans npm ni corepack) ;
- `~/.local/share/uv/tools/*/uv-receipt.toml` (extras, python, entrypoints ; version lue dans `lib/python*/site-packages/<nom normalisé>-<v>.dist-info`) ;
- `pipx list --short` ;
- `~/.cargo/.crates2.json` ;
- `~/go/bin/*` (`go version -m`, ligne `mod`, `(devel)` → pas de version) ;
- `~/.local/bin` : exécutables. Les liens vers `/uv/tools/`, `/pipx/venvs/` ou un autre fichier de `.local/bin` sont ignorés. Version tirée du chemin cible, **jamais en lançant `--version`**.

**Jamais** de cask, de mas ni de `/Applications`.

**Statuts.**
- `used` : marqueur du home (`rules.home`), marqueur de projet dans les dossiers suivis (`rules.projects`, profondeur ≤ 5, dossiers régénérables et cachés ignorés), ou historique ≥ `history_min_uses` (3).
- Historique : `.zsh_history` et `.bash_history`, préfixe `: ts:0;` retiré, `sudo`/`rtk`/`time`/`exec`/`nohup` retirés, la commande doit correspondre à `^[A-Za-z][A-Za-z0-9._-]*$`.
- `unused` sinon.
- `missing` : commande requise par une règle, non fournie et absente du PATH.
- Tri : missing, puis used, puis unused, puis par source et par nom.

**Exclusions** : `[tools].excluded` (noms), réappliquées à chaque inventaire.

**Export** : `tools.toml` + `Brewfile` (voir §3.10). `cairn tools [--json] [--export DIR]`. Le JSON est indépendant de la langue : `reasons[{code:"home",file}|{code:"project",file}|{code:"history",uses}]`.

### 1.8 app-configuration

- `~/.cairn` (ou `CAIRN_HOME`) créé en 700 avec `logs/` et `state/`, par le premier qui écrit (RunLog, watcher, store).
- Avec `--config <f>`, l'état, les journaux et le verrou vivent dans le dossier de ce fichier, dont les droits ne sont pas modifiés.
- Pas de `config.toml` → assistant. Rien n'est écrit avant « Terminer ». Un abandon n'écrit rien, pas même le Trousseau.
- Rechargement à chaud : surveillance du dossier parent, plus un sondage toutes les secondes sur la date de modification. Une configuration invalide garde **la dernière configuration valide**, affiche la clé et la ligne, et bloque la planification.
- 🐞 ConfigWarningTests : l'app **refuse d'écraser** un `config.toml` invalide sur disque (`SaveError.invalidFile`), pour ne pas perdre ce que l'utilisateur corrige à la main.
- Écriture : atomique, en conservant commentaires, ordre et clés inconnues (TOML sans perte, §3.8). Désélectionner un outil IA retire sa table `[ai.<id>]`, forme pointée comprise.
- Migration v0 (`root_path`, pas de `version`) → `[[folders]] path=…, backup=true`. Copie `config.toml.bak` avant. Une `version` supérieure à 1 → erreur.
- Validation (erreur = bloquante, avertissement = non bloquant) :
  - clés inconnues → avertissement avec ligne ;
  - mauvais type → erreur « type attendu / trouvé » ;
  - dossier suivi absent → avertissement, dossier ignoré ;
  - `id` de destination en double, provider hors `local`/`smb`, `path` absent pour local, `url` sans `smb://` pour smb → erreurs ;
  - `time` doit correspondre à `^([01]\d|2[0-3]):[0-5]\d$` ;
  - `weekday` : monday…sunday ;
  - `on_battery_min_percent` : 0 à 100 ;
  - seuils critiques ≤ seuils bas ;
  - `retention_days` ≥ 1, `worktree_stale_days` ≥ 1 ;
  - tiered : days 0 à 3650, weeks 0 à 520, days + weeks > 0 ;
  - count : 1 à 520.
- Secrets :
  - NAS : mot de passe **Internet** du Trousseau (server = hôte de l'URL, account = username ou `NSUserName()`, protocole SMB). L'entrée du Finder est réutilisée.
  - Image : mot de passe **générique**, service `fr.lenzotti.cairn.image.<destId>`, account = machine, libellé `Cairn — <service>`.
  - L'ancienne clé `keychain` est lue et conservée, mais plus écrite.
- Purge des journaux : au lancement et toutes les 24 h. Supprime `*.log` dont la date de modification dépasse `retention_days` (90), sauf `keptLogs`.
- Tâche de fond : `SMAppService.mainApp`, avec un élément d'ouverture System Events en secours. Seulement si `schedule.background=true`. Mode accessoire quand la fenêtre est fermée.
- 🆕 Réglages : la liste des éléments du home (`homeChoices`) réunit `include`, les fichiers connus présents, et **tous** les dossiers cachés et visibles de la racine du home (hors `Library`, liens, `.cairn`, noms de `alwaysRegenerable`, noms de `homeExcludes`, dossiers IA). Dédoublonnée, triée par `localizedStandard` **sans le point initial**, une bascule par élément (3b0ff2f, 85b18ec).
- Assistant (`OnboardingDraft.detect`) :
  - dossiers candidats : `/Volumes/workspaces`, l'ancien `root_path`, `~/Projects`, `~/Projets`, `~/Developer`, `~/workspace`, `~/code` ;
  - présélection **par chemin** de `/Volumes/workspaces` et de l'ancien dossier, sinon du premier (🐞 ConfigWarningTests) ;
  - éléments du home connus cochés (liste `homeCandidates`), autres dossiers cachés non cochés ;
  - destination par défaut `main`, chiffrée ;
  - planification par défaut : quotidienne, 12:30, lundi, sans tâche de fond.

### 1.9 localization

- en-US et fr-FR. `auto` → fr-FR si la **première** langue des préférences commençant par une langue prise en charge est `fr*`, sinon en-US (allemand puis anglais → en).
- `language` dans `config.toml`, `--lang` en CLI (prioritaire pour l'exécution). Une valeur invalide en CLI → code 2.
- Changement à chaud dans l'app.
- Clé absente en fr → texte en, puis la clé brute.
- Pluriels via `.stringsdict`, avec un texte de repli dans `.strings`.
- Mêmes clés et mêmes spécificateurs de format dans les deux catalogues (tests).
- Aucun texte visible en dur (test sur les sources).
- Formats :
  - tailles **décimales** : fr « 1,23 Go », unités o/ko/Mo/Go/To/Po ; en « 1.23 GB », bytes/KB/… ;
  - durées localisées : « 12,3 s » / « 12.3 s ».
- Indépendant de la langue : clés et valeurs de `config.toml`, noms de fichiers des sauvegardes, manifests, TSV, valeurs de `--json` (octets, ISO 8601, statuts en identifiants). Les messages des issues dans le JSON sont traduits, les autres champs sont des identifiants.

### 1.10 menu-bar

- Icône visible quand la tâche de fond est acceptée. 🆕 Le commit bfa7ccc la rend toujours affichée.
- États : normal, sauvegarde en cours (animation à 0,6 s par image), attention, erreur. Le niveau global est le même que celui du hub (`HubState.overall`).
- `Health.destination` : `error` si `lastError` ; `attention` si `damagedVersions` n'est pas vide, si la destination est en attente depuis plus de 24 h, ou si une échéance est manquée depuis plus de 24 h ; sinon `ok`.
- Le panneau utilise les données persistées (résumé, `runs.json`, volumes) et ne lance aucune analyse. Il propose une nouvelle analyse si la dernière date de plus de 7 jours.
- Actions : Nettoyer (ouvre l'écran Nettoyable avec la présélection, jamais de suppression directe), Sauvegarder maintenant, Analyser, Ouvrir, Réglages, Quitter.

### 1.11 command-line

- Même binaire. Mode CLI si le 1er argument (hors `-psn_*`, `-NS*`, `-Apple*`) est une commande, ou `-h`, `--help`, `--version`, `--lang`, `--config`.
- Commandes : `analyze`, `config path|show|validate`, `tools`, `ai`, `git`, `backup`, `verify`, `restore`, `help`, `version`. Plus la commande interne `git-worker <repo> <optionsJSON>`. Les options d'app `--gallery`, `--gallery-export <dir>` et `--snapshot <dir>` ne passent pas par la CLI.
- Codes de sortie : 0 succès, 1 échec, 2 usage ou configuration.
- `--json` : JSON trié et indenté sur stdout ; la progression va sur stderr.
- `--yes`/`-y` accepté partout. Confirmation interactive `[o/N]` qui accepte o, oui, y, yes.
- `git` et `restore` sont en simulation sans `--apply`. `backup --dry-run`.
- `backup` et `restore --apply` prennent `OperationLock` → « already running », code 1.
- `backup` : configuration absente ou invalide, aucune destination ou destination inconnue → code 2. `--tool` inconnu → code 2, avant toute écriture.
- `verify [--destination] [--version] [--full]` : code 1 si un fichier est abîmé ou en cas d'erreur, code 2 pour une version inconnue. Écrit `lastVerification` et `damagedVersions`.
- `restore` : `--from <dir>` | `--destination ID`, `--version`, `--parts tools,home,ai,folders`, `--target nom=chemin`, `--tool ID` (répétable ; absent de la sauvegarde → code 2), `--replace-databases`, `--check`, `--apply`.
- ❌ La spec demande un lien `~/.local/bin/cairn` : il est créé par `build-app.sh`, hors du binaire. À prévoir dans l'installeur Electron.
- La CLI ne fait aucun appel réseau pour les mises à jour.

### 1.12 Domaines présents dans le code ou les deltas, absents des specs principales

- **app-updates** (delta) :
  - lecture de `api.github.com/repos/Romakita/cairn/releases/latest` (surchargée par `CAIRN_UPDATE_URL`) au lancement + 5 s, puis toutes les 6 h, si `[updates] check=true` ;
  - comparaison semver : `v` ignoré, préversion inférieure à la version finale, comparaison numérique des préversions ;
  - assets requis : `Cairn-<v>-<arch>.zip` et `.zip.sha256` ; brouillons et préversions refusés ;
  - installation : SHA-256 (premier champ du fichier `shasum`), `ditto -x -k` dans `<parent>/.cairn-update`, contrôle de l'identifiant `fr.lenzotti.cairn` et de la version, `xattr -dr com.apple.quarantine`, puis script de remplacement après la fin du PID (remise en place de l'ancienne app en cas d'échec, relance) ;
  - refusée pendant une sauvegarde ; hors d'un `.app` à dossier parent modifiable, seule la page de la release est ouverte ;
  - 🐞 0f7a1ce : le bouton s'active dès la fin de la sauvegarde.
  - L'équivalent Electron (autoUpdater, ou une logique maison qui garde les mêmes contrôles) est à concevoir.
- **home-hub** (delta) :
  - `HubState` : priorité des problèmes configInvalid > backupFailed > diskCritical > destinationOverdue > diskLow > folderUnavailable > versionsDamaged (🆕 ce dernier n'est pas dans la delta spec) ;
  - niveau : error pour configInvalid et backupFailed, attention pour le reste ;
  - cartes de module (ton, chiffre, détail, action, jamais destructive) ;
  - « Tout vérifier » en lecture seule : analyse des dossiers, git (`fullCheck`), joignabilité, état. Annulable ; les modules finis gardent leur nouvel état ;
  - `state/hub.json` (`lastCheck`) ;
  - `state/activity.jsonl` : 200 lignes au plus, sous `flock` bloquant sur `state/activity.lock` (🐞 85501aa). Seulement des noms et des compteurs, jamais de chemin ni de message d'erreur ;
  - ❌ `backupDays` sur 7 jours pour le mini-graphique.
- **component-gallery** (delta) : UI pure (stories, `--gallery`, `--gallery-export` : 4 PNG par story + `index.html`, écriture limitée au dossier). Équivalent Storybook ou Ladle côté Electron, hors parité fonctionnelle.
- 🆕 **OperationLock** (`state/operation.lock`, `flock` exclusif non bloquant, contenu `"<pid> <operation>\n"`, droits 600). Opérations : `backup`, `backup-dry-run`, `verify`, `restore`, `git-clean`, `remove-destination`.
  - Libéré par le système même en cas de fin brutale.
  - L'app sonde le verrou (`isHeld`) toutes les 10 s pour réactiver ses boutons.
  - **Doit rester compatible entre l'app et la CLI** (même fichier, même `flock`). En Node, il faut un `flock(2)` natif : `fs-ext` ou un module N-API.
- 🆕 **PathCompletion** (complétion `~/` dans l'assistant) :
  - un préfixe `.` propose les entrées cachées, dossiers d'abord avec `/` final ;
  - insensible à la casse ;
  - refuse `../` et les chemins absolus hors home.
- 🆕 **Machine** : `machineName()` = nom de l'ordinateur (`Host.localizedName`), où chaque caractère hors `[A-Za-z0-9._-]` devient `-`. Il détermine les chemins de sauvegarde : **à reproduire exactement**, en Node via `scutil --get ComputerName` et la même expression régulière.

---

## 2. Régressions à verrouiller (un test par ligne)

| Commit | Symptôme | Règle à tester |
|---|---|---|
| bfbbb61 | « Arrêter » arrêtait toutes les destinations ; un arrêt pendant la préparation était compté comme un échec | Arrêter A ne touche pas B ; un arrêt pendant la préparation ne pose pas `lastFailure`, n'envoie pas de notification et n'écrit rien dans `dest/cairn` |
| a7d22bf | Gel quand une sauvegarde et une analyse git tournaient ensemble (pool de threads épuisé) | Chaque travail attendu (écriture sur un pipe, comptage, worker, minuterie de kill) a son propre fil ou sa propre file ; une sauvegarde et une analyse git simultanées se terminent. En Node : aucune attente synchrone dans le process principal, `child_process` asynchrone |
| 0fa14ea | Reprise par morceaux : des exclus ou des fichiers disparus restaient ; liens physiques perdus entre dossiers du premier niveau ; total sous-estimé à la reprise | Passe `--existing --ignore-existing --delete-excluded` seulement si tous les morceaux ont réussi et que la source est lisible ; GNU rsync (`-H`) copie la partie en un seul rsync ; total reçu d'un comptage complet, sinon ancien total gardé |
| eb1fc60 / 75bde76 | Progression vide, destinations bloquées pendant la finalisation | La copie vers B démarre pendant la finalisation de A ; chaque destination émet `finished` ; phases empreintes → échantillon → image → compactage |
| 8171ca8 | Écran Git bloqué jusqu'à la fin des 79 dépôts | Les rapports arrivent au fil de l'eau (`onReport`) ; le 1er progrès est `done=0,total=N` ; l'arrêt garde les résultats précédents |
| b23d23f | Analyse git hors pool (sans délai ni limite mémoire) | Toute analyse git passe par le pool de workers (délai 300 s, 1,5 Go) |
| 593f593 | 16 Go de mémoire puis panic du noyau pendant le hachage | Hachage en flux par blocs de 1 Mio ; mémoire stable (< 64 Mo de croissance) sur un fichier de 512 Mo, hors du fil principal ; lecture de la sortie rsync sans accumulation |
| c459b58 | Disque rebranché → sauvegarde bloquée jusqu'à 1 h | Une destination injoignable pose `lastAttempt` et `waitingSince`, pas `lastFailure` ; à son retour, décision `run` immédiate |
| 7cc955d | Échec avant les destinations (base IA) non noté → relance en boucle, mise à jour bloquée | L'erreur de préparation pose `lastFailure` sur chaque destination ; `retryLater` pendant 3600 s ; un échec antérieur à la dernière réussite n'ajoute pas de délai |
| 0f7a1ce | Bouton « Installer » resté désactivé après la sauvegarde | La disponibilité de l'installation suit l'état de la sauvegarde en direct |
| 85b18ec / 3b0ff2f | Éléments du home incomplets ou mal triés | Tous les dossiers cachés et visibles, sans `.cairn`, caches, corbeille ni dossiers IA ; tri sans le point initial ; connus cochés, autres non |
| 76e40ec | Mot de passe d'image écrasé au déplacement ; mot de passe supprimé avec la destination ; échec d'écriture de la configuration ignoré | Une image recréée reprend le mot de passe du Trousseau ; la suppression ne touche jamais au Trousseau ; configuration d'abord, rien n'est supprimé si l'écriture échoue, l'entrée est remise si la suppression des sauvegardes échoue ; un échec de lecture de l'historique ne bloque pas le rechargement |
| 8d202b6 | Un snapshot raté laissait un fichier vide, installé à la restauration ; base à journal chaud lue en `immutable` | Échec après 5 essais → `dest`, `-journal`, `-wal` et `-shm` supprimés ; `immutable` seulement si `isCleanWAL` (en-tête octets 18-19 = 2, aucun `-wal`, `-shm` ni `-journal`) |
| 65c88bb | Codex `state_5.sqlite` (WAL fermé sans `-shm`) : SQLITE_CANTOPEN, sauvegarde stoppée | Repli sur `?mode=ro&immutable=1`, taille et mtime inchangés pendant la copie, `quick_check` ok ; sinon un avertissement, sans échec |
| 85501aa | « Tout vérifier » lançait `fetch --prune` ; événements d'activité perdus entre l'app et la CLI | `fullCheck` ⇒ `fetch=false`, `only=nil` ; 8 processus × 20 ajouts ⇒ 160 événements |
| 156f978 | Nettoyage des témoins trop large ; chemin local vide accepté ; mauvaise image restaurée ; Trousseau écrit avant la configuration | Témoin : fichier ordinaire, nom avec UUID, contenu `cairn` ; retour arrière ⇒ nouvelle vérification ; `preferredImage` respectée ; Trousseau écrit seulement après l'écriture de `config.toml` ; « Terminer » renvoie à l'étape invalide |
| 46a9475 | diff ou patch-id en échec ⇒ « merged » ; branche modifiée depuis l'analyse supprimée ; nettoyage sans verrou ; nom d'outil passé au shell ; version de restauration mal choisie ; `cancel()` sur un rsync pas encore lancé ; CRLF ; notice de retard écrasant `runs.json` ; résolution des liens dans le parcours des empreintes | Code git autre que 0 ou 1 ⇒ `unmerged` ; SHA attendu (préfixe court accepté) sinon échec ; `git-clean` sous le verrou ; `command -v -- "$1"` ; version par défaut la plus récente, ce Mac d'abord ; kill seulement d'un process lancé ; TOML CRLF ; relire l'état avant d'écrire ; pas de `realpath` par fichier |
| 8f83b03 / 02f3e84 | 0.1.0 plantait au lancement (bundle de ressources introuvable) | Ressources absentes ⇒ repli sans plantage (textes non traduits) ; test de fumée de l'app empaquetée lancée hors du repo |
| 01538a8 | `main` proposée dans un worktree lié ; base existante écrasée ; dossier de projet supprimé avant la fin de la fusion | Protection par nom court ; base présente seulement avec `--replace-databases` (WAL en `.pre-restore-wal`) ; suppression après fusion réussie ; préfixe le plus long d'abord ; `--tool` répétable |
| e229e52 | openrsync `-n` + `--link-dest` absent ⇒ échec ; simulation de restauration qui créait la cible ; outils ouverts non journalisés ; SQLite fermé pendant la copie | Simulation contre la version de base ; aucune création en simulation ; ligne « open during backup » ; nouvelles tentatives du snapshot |
| 3692993 | La simulation écrivait sur la destination ; versions partielles « latest » ; journaux de versions gardées purgés ; mots de passe absents sur un Mac neuf | Simulation : aucune image, aucun dossier ; version partielle hors `latest`, hors rétention et hors version par défaut ; `keptLogs` épargnés ; mots de passe demandés ; outil IA attendu ou passé |
| bfa7ccc | Lot d'avertissements de l'`/opsx:verify` | `hdiutil verify` mensuel ; notifications d'échec avec journal ; `--json` et `--yes` partout ; vraie version dans le manifest (ni vide ni « 1 ») ; rsync arrêté à la fermeture ; état de vérification partagé entre l'app et la CLI |
| ef55c5b | Progression git écrite hors terminal | Progression seulement si stderr est un TTY |
| 0547a02 / leçon SMB | `smb://syno` refusé | Adresse avec l'hôte seul ⇒ liste des partages (`smbutil view`, mot de passe sur stdin) ; le partage choisi reçoit `cairn/` ; lignes d'erreur rsync gardées (20 dernières) dans l'erreur et le journal ; image verrouillée (EAGAIN, en et fr) ⇒ message `imageBusy` ; pas de compactage après un arrêt ou un échec |
| 1e10810 | Notifications hors bundle `.app` ⇒ plantage | Notifications gardées derrière un test de contexte ; en Electron, `Notification.isSupported()` |
| leçon « boutons » | Vérifications actives sans rien à vérifier | Toute action indisponible est désactivée avec sa raison (règle pure, testée : `unavailableReason`) |
| ConfigWarningTests | Écrasement d'un fichier corrigé à la main | `save` refusé si le fichier sur disque est invalide |
| RestoreWarningTests | `/Volumes` existe toujours | `targetIsMissing` teste `/Volumes/<nom>` |
| StorageWarningTests | Dépôts trouvés dans `node_modules` ou `build` | La découverte utilise la même classification que le scanner |
| TOMLTests | Fichier CRLF illisible (le commentaire avalait tout) | Parser par scalaire Unicode, garder les `\r\n` en réécriture |

Les autres fichiers de tests à porter tels quels sont résumés en §1 (scénarios). Liste complète, test par test, disponible dans le rapport du sous-agent si besoin.

---

## 3. Algorithmes et détails délicats

### 3.1 Régénérable : analyse (`Scanner`) et sauvegarde (`BackupExclusions`)

**`alwaysRegenerable`** (nom de dossier → catégorie) :

| Catégorie | Noms |
|---|---|
| git | `.git` |
| deps | `node_modules`, `.pnpm-store`, `bower_components`, `jspm_packages` |
| ios | `Pods`, `DerivedData`, `Carthage` |
| build | `dist`, `coverage`, `.next`, `.nuxt`, `.angular`, `.turbo`, `.nx`, `.vite`, `.parcel-cache`, `.svelte-kit`, `.output`, `storybook-static`, `.docusaurus`, `.expo` |
| python | `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox` |
| cache | `.cache`, `.eslintcache`, `.sass-cache` |
| trash | `.Trashes`, `.Trash` |

**`Scanner.conditional`** : le dossier n'est régénérable que si l'un des marqueurs est présent **dans le dossier parent**.

| Dossier | Catégorie | Marqueurs |
|---|---|---|
| `build` | build | `package.json`, `build.gradle`, `build.gradle.kts`, `settings.gradle`, `CMakeLists.txt`, `pubspec.yaml` |
| `out` | build | `package.json`, `tsconfig.json` |
| `target` | build | `Cargo.toml`, `pom.xml` |
| `.gradle` | build | `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts`, `gradlew` |
| `vendor` | deps | `composer.json`, `Gemfile`, `go.mod` |
| `.build` | build | `Package.swift` |

**`BackupExclusions.staticPatterns`** (motifs rsync), dans cet ordre :
1. `volumeMetadata` : `/.Spotlight-V100/`, `/.fseventsd/`, `/.Trashes/`, `/.TemporaryItems/`, `/.DocumentRevisions-V100/` (ancrés à la racine) ;
2. les noms `alwaysRegenerable` des catégories **régénérables** (deps, build, ios, python, cache), triés, avec un `/` final. **Ni `.git/` (l'historique est sauvegardé) ni `.Trash/`** ;
3. extras : `.nyc_output/`, `.stylelintcache`, `.eslintcache`, `*.tsbuildinfo`, `.terraform/`, `.DS_Store`.

**Dossiers génériques détectés** (`detectGenerated`) :
- Noms concernés : `lib`, `build`, `out`, `target`, `tmp`, `temp`, `.tmp`, `vendor`, `.build`, `.gradle`.
- Parcours trié. On ne suit pas les liens et on ne descend ni dans `alwaysRegenerable`, ni dans `.git`, ni dans les métadonnées de volume.
- Un dossier détecté n'est pas parcouru.
- Résultat sous forme de chemins ancrés `/a/b/build/`.
- **Dans un dépôt** (un `.git` dans ce dossier ou un parent du parcours) : exclu seulement si `git -C <parent> check-ignore -q <nom>/` renvoie 0.
- **Hors dépôt** : règles propres. ⚠ Elles **diffèrent** de `Scanner.conditional` :
  - `lib` exige `package.json` **et** `src` ;
  - `build` et `out` acceptent `package.json`, `build.gradle`, `build.gradle.kts` ou `CMakeLists.txt` : pas de `pubspec.yaml`, `settings.gradle` ni `tsconfig.json` ;
  - `vendor` accepte aussi `composer.lock` ;
  - `tmp`, `temp` et `.tmp` sont toujours exclus.
  - AGENTS.md demande des règles communes : décider si on unifie (en gardant les tests verts) ou si on reproduit ces différences.

**`forFolder`** = statiques + générés + `[[folders]].exclude` + toute destination locale située **sous** le dossier, ancrée (`/backups/`).

**`homeExcludes`** (appliqués même dans un élément sélectionné) : `.cache/`, `cache/`, `Cache/`, `Caches/`, `logs/`, `*.log`, `node_modules/`, `.DS_Store`, `.npm/`, `.bun/install/cache/`, `.yarn/berry/cache/`, `.pnpm-store/`, `.local/share/pnpm/store/`, `.local/share/mise/installs/`, `.local/share/mise/downloads/`, `.local/share/uv/tools/`, `.local/share/uv/python/`, `.local/pipx/venvs/`, `.local/pipx/shared/`, `.local/pipx/.cache/`, `.ollama/models/`, `.gradle/caches/`, `.m2/repository/`, `.cargo/registry/`, `.rustup/toolchains/`, `.composer/cache/`, `.node-gyp/`, `.zcompdump*`. Plus `[home].exclude`.

**Utilisateurs de `Scanner.classify`** : la découverte git, `GitMaintenance.lastModified`, `Scanner.measure` (régénérable, sans `.git` ni corbeille) et le filtre des dossiers du home.
- `InventoryCollector.projectMarkers` a sa **propre** liste d'exclusion : `node_modules`, `.git`, `.pnpm-store`, `vendor`, `Pods`, `DerivedData`, `.venv`, `dist`, `build`, `.Trashes`, `.Spotlight-V100`, `.fseventsd`, plus tout nom commençant par `.`.

### 3.2 Rétention (`RetentionPolicy.keep`, `BackupEngine.excessVersions`)

**`count(n)`** : les max(n, 1) versions les plus récentes.

**`tiered(days, weeks)`** :
- limite quotidienne = maintenant − days×86 400 s ;
- limite hebdomadaire = limite quotidienne − weeks×7×86 400 s ;
- versions triées de la plus récente à la plus ancienne ;
- version ≥ limite quotidienne → gardée ;
- sinon, version ≥ limite hebdomadaire → gardée si c'est la première vue de sa **semaine ISO-8601 en UTC** (clé `yearForWeekOfYear-weekOfYear`), donc la plus récente de la semaine ;
- la version la plus récente est **toujours** gardée.

**`excessVersions`** : la politique porte sur les versions complètes. Une version partielle est supprimée seulement si une version complète plus récente existe.

**`mayDeleteMore(new, old)`** : vrai si count diminue, si tiered a moins de jours ou une couverture `d + 7w` plus courte, ou s'il y a changement de type.

**`coverage`** :
- tiered → (versions max = (quotidien : days ; sinon ⌈days/7⌉) + weeks, jours = days + 7×weeks) ;
- count → (n, n × (7 si hebdomadaire, sinon 1)) ;
- recommandé quotidien = 78 versions.

**Espace libéré** (`uniqueBytes`) : par inode, les fichiers dont toutes les occurrences de liens se trouvent dans les versions à supprimer, `st_blocks*512`.

Les versions ne sont supprimées qu'après une version réussie ; en cas d'échec, aucune n'est supprimée.

### 3.3 Intégrité et hachage (`Integrity`)

**`checksums.tsv`** à la racine d'une version :
- une ligne `chemin_relatif\ttaille\tmtime_epoch_secondes_entières\tsha256hex`, triée par chemin, avec un `\n` final ;
- liste : fichiers ordinaires de la version, hors `checksums.tsv`, `damaged.tsv`, `manifest.json` et tout chemin contenant `/.cairn-partial/` ;
- racine résolue une seule fois (`/var` → `/private/var`), puis pas de résolution de lien par fichier.

**Réutilisation** : pour chaque partie, on reprend les entrées de la version de base de **cette partie** (`linkSources`), préfixées `target/`. Une empreinte est réutilisée si taille et mtime sont identiques et que le fichier n'est pas dans `damaged.tsv` de cette base. Sinon on hache.

**Hachage** : SHA-256 en flux, blocs de 1 Mio, mémoire constante. Annulable entre deux fichiers. Progression au plus 10 fois par seconde.

**Vérification.**
- `full` : tous les fichiers listés.
- Échantillon : mélange aléatoire, n = min(total, max(500, 2 %)), cumul ≤ 5 Go (un fichier qui dépasse est sauté, sauf si rien n'a encore été choisi).
- Fichier illisible ou empreinte différente → abîmé.
- Les fichiers abîmés sont ajoutés, triés et dédoublonnés, dans `damaged.tsv` (un chemin par ligne).
- Pas de `checksums.tsv` → `missingChecksums` (« en attente »), non compté comme vérification.

**Recopie** : `recopyPlan` → partie → chemins relatifs abîmés. Avant le rsync principal : `rsync -a --files-from=recopy.txt src/ dest/`, sans `--link-dest`. Puis le rsync principal avec `--link-dest`.

### 3.4 rsync (`BackupEngine.rsync`)

**Binaire** : `/opt/homebrew/bin/rsync` s'il est exécutable (GNU : ajouter `-H`), sinon `/usr/bin/rsync` (openrsync sur les macOS récents).

**Arguments, dans l'ordre** :
1. `-a` ;
2. `-H` (seulement avec GNU rsync) ;
3. `--out-format=%i|%n` ;
4. `--partial-dir=.cairn-partial` ;
5. `--delete` ;
6. `--delete-excluded` (seulement pour un morceau **sans** filtre) ;
7. `-n` (simulation) ;
8. `--exclude-from=<tmp>/exclude.txt` ;
9. les filtres du morceau et les arguments supplémentaires ;
10. `-r --files-from=<tmp>/files.txt` (home et IA) ;
11. `--link-dest=<base>/<target>` si la base existe ;
12. `src/` puis `dest/`.

**Lecture de la sortie.**
- Le 2e caractère de `%i` doit être `f` pour compter un fichier « examiné ».
- `>f` ou `<f` = transféré. `hf` = lien vers la base.
- Taille transférée = somme des tailles **à la source** des fichiers ordinaires transférés.

**Erreurs et codes.**
- stderr lu en continu, les 20 dernières lignes sont gardées et jointes au message.
- Codes 23 et 24 = avertissement « transfert partiel » ; tout autre code non nul = échec de la partie.
- Entre morceaux, c'est le code le plus grave qui l'emporte.

**Morceaux** (`copyChunks`, sans GNU rsync) :
- un rsync par dossier du premier niveau, avec `--include=/<d> --include=/<d>/** --exclude=*` ;
- puis un morceau pour les fichiers du premier niveau (`--include=/<f>`… `--exclude=*`) ;
- un seul morceau sans filtre si `filesFrom`, s'il y a ≤ 1 entrée, si un nom contient `*?[]\`, ou s'il n'y a pas de sous-dossier ;
- les exclusions de la partie s'appliquent **avant** le filtre du morceau.

**Nettoyage après reprise** : si la copie reprend un `.incomplete-`, qu'il y a plus d'un morceau, que tout a réussi et que la source est lisible : passe sans copie avec `--existing --ignore-existing` (et `--delete-excluded`).

**Comptage** (`countFiles`) :
- 4 workers. Une **pile partagée** de morceaux : chaque worker prend le suivant.
- Chaque morceau : `rsync -n` vers un dossier vide temporaire `cairn-count-<UUID>`.
- Le total est identique à celui d'un seul rsync.
- Il tourne **pendant** la copie. Si `runs.json.fileCounts[target]` est connu, pas de comptage.
- Arrêté dès la fin de la copie (`ProcessGroup.abort`).
- Total retenu pour la prochaine fois : le comptage complet, sinon les fichiers vus (sauf en reprise : l'ancien total est gardé).

**Phases de progression** (`BackupProgress`, battement toutes les secondes, plus au plus 10 rapports par seconde de rsync) :
1. `preparing` : `backup.prepare.parts`, puis `generated <dossier>` (au plus 10 fois par seconde), `tools`, `ai`, `open` (montage et image) ;
2. copie : `part`, `chunk`/`chunks`, `listing` et `listingSince` (aucun fichier encore vu), `files`, `processed`, `expected`, `counting`, `found`, `workers[]` ;
   - `fraction` = processed/expected, plafonnée à 0,99, nulle pendant le comptage, la préparation ou la finalisation ;
3. `finishing` : `listing`, puis `checksums done/total`, `version`, `verify` (échantillon), `image`, puis `compact` (après une réussite) ou `close` ;
4. `finished`.

**Annulation** : SIGTERM, puis SIGKILL au bout de 5 s (rsync bloqué sur un SMB mort). Un process pas encore lancé n'est pas tué (🐞 46a9475).

**CLI** : une ligne sur stderr par point de pourcentage, une seule pendant le comptage.

### 3.5 Bases SQLite des outils IA (WAL)

1. Ouverture `SQLITE_OPEN_READONLY|URI` de la source, `busy_timeout` à 2000 ms.
2. API de sauvegarde en ligne `sqlite3_backup_step(256)`. En cas de BUSY ou LOCKED, pause de 50 ms. La destination passe ensuite en `PRAGMA journal_mode=DELETE` (base autonome, sans `-wal`).
3. En cas d'échec, si `isCleanWAL(source)` : nouvel essai avec `file:<url>?mode=ro&immutable=1`. Taille et mtime (ns) relevés avant et après, qui doivent être identiques, puis `PRAGMA quick_check` = `ok`. Sinon la copie est supprimée et l'opération échoue.
4. 5 essais en tout, avec une pause de 100 ms × numéro d'essai. Après l'échec final : suppression de `dest`, `dest-journal`, `dest-wal` et `dest-shm`, puis avertissement `backup.warning.ai_database`.

**En Node** : `better-sqlite3` (`db.backup()` et `?immutable=1` par URI) ou le binaire `sqlite3 .backup`. Garder `-wal` et `-shm` hors des parties fichiers, et ne jamais rien créer dans le dossier de l'outil.

### 3.6 GitWorkerPool

- Un sous-processus par dépôt : `<binaire Cairn> git-worker <repo> <GitOptions JSON>`. Le JSON du rapport (`RepoReport`, dates ISO 8601) sort sur stdout, stderr est ignoré.
- Au plus `parallel = 4` à la fois (sémaphore). Arrêt de l'attente si annulé.
- Surveillance toutes les secondes :
  - mémoire résidente (`proc_pid_rusage`) > 1,5 Go → tué, échec `git.worker.memory` ;
  - durée > 300 s → tué, `git.worker.timeout` ;
  - annulation → tous tués.
- Code de sortie ≠ 0 ou JSON illisible → échec `git.worker.failed <code>`.
- `onReport` est appelé dans l'ordre d'arrivée. Résultat final dans l'ordre des dépôts.
- `rapports + échecs == total`, même si un worker est tué.
- Clés JSON de `GitOptions` : `fetch`, `includeUnmerged`, `pruneNow`, `gc`, `staleDays`, `only`, `worktreesOnly`, `includeAtRisk`.
- `Git.pipe` : `git A | git B` de process à process, jamais de diff en mémoire. Fermer le côté écriture du tuyau dans le parent.
- **En Node** : `child_process.spawn(process.execPath, [script, 'git-worker', …])` ou `utilityProcess`. Mémoire du process via `pidusage` ou `ps -o rss`. Brancher `git diff | git patch-id` avec `stdout.pipe(stdin)`.

### 3.7 Dossier `~/.cairn` (ou `CAIRN_HOME`) : fichiers à garder compatibles

| Fichier | Format |
|---|---|
| `config.toml` (+ `config.toml.bak`) | §3.8 |
| `logs/<type>-yyyyMMdd-HHmmss.log` | types `backup`, `backup-dry-run`, `analyze`, `app`… ; lignes `<ISO8601> <texte>` |
| `state/runs.json` | JSON indenté, clés triées, dates ISO 8601. `{"destinations":{"<id>":{lastSuccess?, lastAttempt?, lastError?, lastFailure?, waitingSince?, lastOverdueNotice?, lastVerification?, damagedVersions:[], lastImageCheck?, lastImageCheckOK?, lastBytesTransferred:0, lastDuration:0, fileCounts?{target:n}, keptLogs?[]}}}`. Les clés sont en **camelCase** |
| `state/operation.lock` | `flock`, contenu `"<pid> <op>\n"` |
| `state/activity.jsonl` (+ `activity.lock`) | une ligne JSON par événement, clés triées : `{date, kind: backupSucceeded\|backupFailed\|cleanup\|gitCleanup\|diskAlert\|check, subject?, count?, bytes?, level?}`, 200 au plus |
| `state/analysis-summary.json` | `{date, totalBytes, reclaimableByType{deps,build,ios,python,cache}, obsoleteWorktreeBytes, trashBytes}` |
| `state/volumes.json` | `{"readings":{"<nom du volume>":[{date, available, total}]}}` |
| `state/alerts.json` | `{"<volume>":{lastNotified?, lastLevel:0\|1\|2, snoozedUntil?}}` (niveau **entier**) |
| `state/hub.json` | `{lastCheck?}` |

**Dates** : ISO 8601 **sans fractions de seconde** (`JSONEncoder .iso8601`), par exemple `2026-11-09T10:00:00Z`. Le décodeur Swift refuse les millisecondes. Si la nouvelle version écrit `toISOString()`, l'ancienne app ne relira plus l'état : formater sans millisecondes.

### 3.8 `config.toml` (schéma v1)

```toml
version = 1
language = "auto"                       # auto | en-US | fr-FR
[analysis]   big_file_threshold_mb = 50 ; big_folder_threshold_gb = 1.0
[[folders]]  path = "…" ; backup = true ; exclude = []
[home]       include = [] ; exclude = []
[ai.<id>]    categories = ["conversations","config","memories","credentials"]
[[destinations]] id ; provider = "local"|"smb" ; path | url ; username ; keychain (ancienne clé, conservée)
                 encrypted = true ; retention = { mode = "tiered", days = 30, weeks = 48 } | { mode = "count", count = N }
[schedule]   frequency = "daily"|"weekly"|"manual" ; time = "12:30" ; weekday = "monday" ; background = false ; on_battery_min_percent = 20
[alerts]     low_percent = 10.0 ; low_gb = 20.0 ; critical_percent = 5.0 ; critical_gb = 5.0
[logs]       retention_days = 90
[updates]    check = true
[git]        fetch_before = false ; gc = true ; worktree_stale_days = 30
[tools]      excluded = []
```

**Écrivain** : il réécrit toujours toutes ces clés, avec les doubles en `x.0`, en préservant le reste. Un nouveau fichier commence par l'en-tête de 3 lignes de commentaires de `ConfigWriter.newDocument`.

**Lecteur et écrivain TOML maison, sans perte** (à reproduire ; aucune bibliothèque npm courante ne préserve les commentaires à l'écriture) :
- rendu octet pour octet d'un document non modifié ;
- `set` garde le commentaire de fin de ligne ;
- ajout et suppression de `[[tables]]` ;
- suppression d'une table et de ses sous-tables, forme pointée comprise ;
- erreurs avec numéro de ligne ; **refus** des dates et des chaînes multilignes `"""` ;
- clé en double = erreur ;
- CRLF préservé ;
- chaînes `'littérales'` et inline tables ordonnées ;
- échappement de `"`, `\` et `\n`.

### 3.9 Format des sauvegardes sur la destination (à relire tel quel)

```
<racine>/                               # dossier local, ou point de montage du partage + sous-chemin de l'URL
  cairn-<machine>.sparsebundle          # si SMB ou chiffrée : hdiutil create -size 4t -type SPARSEBUNDLE -fs APFS -volname Cairn
                                        #   [-encryption AES-256 -stdinpass] ; attach -nobrowse -noautoopen -plist [-stdinpass]
                                        #   (mot de passe + "\0" sur stdin, LC_ALL=C)
    └ (dans l'image) cairn/<machine>/versions/…
  cairn/<machine>/versions/             # en clair (local non chiffré)
     <yyyy-MM-ddTHHmmss>/               # version terminée
        manifest.json  checksums.tsv  [damaged.tsv]
        folders/<nom>/…   home/…   tools/{tools.toml,Brewfile}
        ai/<outil>/<catégorie>/…        # chemins relatifs à la racine de l'outil
        ai/<outil>/meta/{profile.json, sqlite/<catégorie>/<chemin relatif de la base>}
     .incomplete-<horodatage>/          # en cours ou à reprendre (< 7 jours)
     latest -> <horodatage>             # lien symbolique relatif, jamais vers une version partielle
     .cairn-partial/ (dans chaque dossier, transitoire)
```

**`manifest.json`** (JSON indenté, clés triées) :
- `format: 1` ;
- `date` : ISO 8601 ;
- `machine`, `arch` (`uname -m`), `macos` (`operatingSystemVersionString`) ;
- `parts: [{kind: folder|home|ai|tools, target, source}]` ;
- `bytes_transferred`, `partial: bool` ;
- `cairn` : version de l'app ;
- `destination` : id ;
- `config_version` ;
- `log` : nom du fichier journal.

**Reconnaissance d'une version** : la restauration lit `parts[].kind/target/source`. Les outils IA sont déduits de `ai/<outil>/…`. Le home d'origine est la `source` de la partie `home`.

**Héritage `backup.sh`** : `manifest/{system.txt, Brewfile, npm-globals.txt, uv-tools.txt, mise-config.toml, pipx.json}`, `home/`, `workspaces/`, `ai/sqlite/…`, `ai/claude-desktop/Claude/`.

**Fichiers posés en restauration** : `<f>.pre-restore`, `<db>.pre-restore-wal` et `<db>.pre-restore-shm`.

**Commandes `hdiutil`** :
- `hdiutil verify [-stdinpass] <img>` : réussite si code 0 ou si la sortie contient « has no checksum » ;
- `hdiutil compact -batteryallowed [-stdinpass]` ;
- `hdiutil detach <mp>`, sinon `detach -force` ;
- `hdiutil isencrypted` → la sortie contient « encrypted: YES ».

**Machine** : voir §1.12. Le nom de machine est dans les chemins : une divergence ferait perdre les liens avec les versions existantes et créerait une nouvelle image.

### 3.10 `tools.toml` et `Brewfile`

`tools.toml` :
- en-tête de commentaire, puis `version = 1` et `taps = [...]` ;
- une table `[[<source>]]` par outil retenu, triée par (source, nom). Sources : `brew`, `mise`, `npm`, `uv`, `pipx`, `cargo`, `go`, `local-bin` ;
- champs : `name`, `version?`, les détails triés (`extras`, `python`, `requested`, `link`…) en chaînes, puis `commands = [...]`.

`Brewfile` : des lignes `tap "x"`, puis `brew "x"` pour les formules retenues, avec un `\n` final, jamais de `cask` ni de `mas`.

### 3.11 Autres détails

- **`Scanner.measure`** : mêmes options `fts`, sans arbre en mémoire.
- **Planification en heure locale**, calendrier courant. La rétention, elle, utilise des semaines ISO en UTC.
- **Prochaine échéance hebdomadaire** : correspondance des jours de semaine du calendrier (dimanche = 1).

---

## 4. Invariants de sécurité

1. **L'analyse n'écrit jamais.**
   - Le scanner, `measure`, la découverte git, l'inventaire, `cairn ai` et le hub ne font que lire.
   - Analyse git : pas de `fetch` par défaut, jamais pendant « Tout vérifier », pas de `gc`.
   - `cairn analyze` et `cairn git` (sans `--apply`) lisent la configuration sans migration ni écriture (`readConfig`).
   - Exception assumée : `ConfigStore.load()` migre et écrit `.bak` (`config validate`, `backup`, l'app).
2. **Destructif = explicite, confirmé, simulable.**
   - Nettoyage du stockage : corbeille par défaut ; suppression définitive marquée irréversible ; confirmation avec chemins et taille ; rien ne se passe en cas d'annulation.
   - Git :
     - simulation par défaut en CLI ; `--apply` + confirmation ou `--yes` ;
     - dans l'app, rien de présélectionné ; confirmation par élément ; case dédiée pour une branche non fusionnée, un worktree à risque ou un dépôt à risque mis à la corbeille ;
     - SHA journalisé **avant** chaque suppression ;
     - branche modifiée depuis l'analyse ⇒ non supprimée ;
     - jamais la branche courante, la principale ni une branche extraite ;
     - `--include-at-risk` obligatoire en CLI ;
     - l'option `pruneNow` prévient que la récupération ne sera plus possible.
   - Restauration : simulation par défaut ; récapitulatif et confirmation ; tout fichier écrasé est gardé en `.pre-restore` ; bases existantes seulement sur demande ; outil IA quitté avant d'écrire ; aucune création en simulation.
   - Rétention : versions supprimées seulement après une version réussie ; une réduction dans les réglages exige une confirmation (nombre de versions et espace libéré).
   - Suppression d'une destination : simulation, puis confirmation ; seules les sauvegardes de **ce Mac** ; jamais le Trousseau ; configuration retirée d'abord, puis remise en cas d'échec.
   - Panneau de la barre des menus et notifications : jamais d'action destructive directe.
   - Mise à jour : SHA-256, identifiant du bundle et version vérifiés, ancienne app remise en place en cas d'échec, refus pendant une sauvegarde.
3. **Exclusion mutuelle** : `OperationLock` (`flock`) commun à l'app et à la CLI pour sauvegarde, vérification, restauration, nettoyage git et suppression de destination. ⚠ L'ajouter à la suppression des versions en trop (§1.1).
4. **Secrets.**
   - Jamais dans `config.toml`, les journaux, l'activité ou les arguments de processus.
   - Mots de passe passés sur stdin : `hdiutil -stdinpass` (terminé par `\0`), `smbutil view` (terminé par `\n`).
   - Trousseau : mot de passe Internet SMB et mot de passe générique de l'image. En Electron, `safeStorage` ne suffit pas : il faut un accès au Trousseau macOS (keytar, ou `security add-internet-password` / `add-generic-password` avec les **mêmes** service, compte, serveur et protocole) pour relire les entrées existantes.
   - Écrit seulement après l'enregistrement réussi de la configuration. Un abandon de l'assistant n'écrit rien.
   - Identifiants IA : copiés seulement si **toutes** les destinations sont chiffrées.
   - Destination non chiffrée avec `~/.ssh` : avertissement et confirmation explicite.
   - Droits rétablis après restauration (700 / 600 / 644).
   - `~/.cairn` en 700 ; fichiers de verrou en 600.
   - Git sans invite interactive (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode`).
   - Aucune exécution de binaire inconnu pour lire une version (`~/.local/bin`).
   - Noms venus d'une sauvegarde jamais interprétés par le shell.
5. **Vérification de destination sans trace** : un seul fichier témoin, supprimé aussitôt ; démontage de ce que Cairn a monté, jamais d'un montage de l'utilisateur ; nettoyage limité aux témoins reconnus.
6. **Compatibilité ascendante** : une version Swift doit être restaurable par la version Electron, et inversement. Mêmes chemins, mêmes noms de version et de machine, mêmes `manifest.json`, `checksums.tsv` et `damaged.tsv`, mêmes services Trousseau, même verrou, mêmes formats d'état (dates ISO sans millisecondes).
