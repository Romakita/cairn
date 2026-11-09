# Cairn → Electron + TypeScript (Bun) : inventaire des intégrations système et de la chaîne de build

Lecture seule de `/Volumes/workspaces/exports/.claude/worktrees/electron-app` (version 0.8.0). Chemins relatifs à `Cairn/Sources/`.

Contrainte transversale : **le code core tourne sous Node (Electron) en production, mais sous Bun en test et peut-être en CLI**.
Il ne doit utiliser que des API `node:*` (pas de `Bun.spawn`, `Bun.file`, `bun:sqlite`), sinon l'app casse au runtime
alors que `bun test` passe. Prévoir une règle de lint (`no-restricted-imports` sur `bun:*`, `no-restricted-globals` sur `Bun`).

---

## 1. Surface CLI (à garder identique)

Aiguillage : `Cairn/main.swift` → `CLI.isCommandLine(args)` (`CairnCore/CLI.swift:isCommandLine`) : CLI si le 1er argument
(hors `-psn_*`, `-NS*`, `-Apple*`) est une commande de `CLI.commands` ou `-h|--help|--version|--lang|--config`. Sinon interface.
Arguments dev hors CLI (avant l'aiguillage) : `--snapshot DIR [SAMPLE]`, `--gallery`, `--gallery-export DIR`.

**Codes de retour** (`CLI.Exit`) : `0` ok, `1` échec, `2` usage/configuration. Sorties : résultat sur stdout, messages,
progression et confirmations sur stderr. JSON : `JSONSerialization [.prettyPrinted, .sortedKeys]` (indentation 2, clés
triées — à reproduire avec un `stringify` à clés triées, sinon diff de sortie). Textes via `L10n.tr` (clés `cli.*`).

Options globales (`CLI.run`) : `--config FILE` (état/journaux/verrou à côté du fichier ; sinon `~/.cairn` créé en 700,
ou `$CAIRN_HOME`), `--lang en-US|fr-FR|auto` (invalide → 2), langue sinon lue dans `config.toml` (`configuredLanguage`).
Sans commande → aide, 0. Commande inconnue → stderr + aide, 2. `--yes/-y` accepté partout (no-op là où rien n'est confirmé).

| Commande | Options | Sortie / codes |
|---|---|---|
| `help`, `-h`, `--help` | — | `cli.help`, 0 |
| `version`, `--version` | — | `cairn X.Y.Z` (smoke test le vérifie), 0 |
| `analyze [dossier…]` (`CLI.analyze`) | `--json` | Défaut : dossiers de config, sinon `/Volumes/workspaces`. Dossier explicite absent → 1. JSON `{folders:[{path,available,size,files,regenerable,breakdown,errors,duration_seconds,big_objects[≤50],projects[≤50]}],total}`. 1 si aucun dossier disponible |
| `config path\|show\|validate` (`CLI.config`) | `--json` | `path` → chemin ; `show` → TOML rendu (issues sur stderr) ou JSON `{path,exists,config,issues}` ; `validate` → 2 si absent/erreurs, `migrated` + `.bak` |
| `tools` (`CLI.tools`) | `--json`, `--export DIR` | Liste groupée missing/used/unused ; export (Brewfile…) ; JSON à codes stables |
| `ai` (`CLI.ai`) | `--json` | `{tools:[{id,detected,bytes_by_category,…,credentials_in_keychain}]}` |
| `git` (`CLI.gitCommand`) | `--apply`, `--yes`, `--json`, `--fetch`, `--include-unmerged`, `--prune-now`, `--no-gc`, `--worktrees-only`, `--include-at-risk`, `--only V`, `--root DIR` (répétable), `--report FILE.tsv`, `--stale-days N` | Simulation par défaut ; progression `\r` sur stderr si TTY (`isatty`) ; confirmation `[o/N]` ; verrou d'opération `git-clean` ; 1 si échecs/annulation/occupé |
| `git-worker REPO OPTIONS_JSON` | interne | Rapport JSON (dates ISO 8601) sur stdout ; 2 si options illisibles |
| `backup` (`CLI.backup`/`runBackup`) | `--dry-run`, `--json`, `--destination ID` (rép.), `--only folders\|home\|tools\|ai` (rép.), `--tool ID` (rép.) | Progression ligne par % sur stderr ; JSON `{results:[…]}` ; 2 config absente/invalide/sans destination ; 1 si une destination échoue ou verrou tenu (`cli.busy`) ; mot de passe d'image neuve affiché une fois |
| `verify` (`CLI.verify`) | `--full`, `--json`, `--destination ID`, `--version V` | 2 version inconnue ; 1 si fichiers abîmés/erreur/verrou |
| `restore` (`CLI.restore`) | `--from DIR` \| `--destination ID`, `--version V`, `--parts a,b`, `--target NOM=CHEMIN`, `--tool ID` (rép.), `--replace-databases`, `--apply`, `--yes`, `--check`, `--json` | Simulation par défaut ; mots de passe SMB/image demandés sans écho (`readpassphrase`) ; confirmation ; verrou `restore` ; ouvre Terminal pour CLT/Homebrew ; attend la fermeture des outils IA |

Variables d'environnement : `CAIRN_HOME` (`Support.swift:CairnPaths.init`), `CAIRN_UPDATE_URL` (`Updater.latestURL`).

Équivalents Node : `readpassphrase` → `process.stdin.setRawMode(true)` + lecture sans écho (sur `/dev/tty` si stdin redirigé) ;
`readLine` → `readline` ; `isatty(STDERR)` → `process.stderr.isTTY` ; `expandingTildeInPath` → helper `~` ; exit → `process.exitCode`
(ne pas appeler `process.exit()` avant le drain de stdout quand la sortie est un pipe, sinon JSON tronqué).

### Lien `~/.local/bin/cairn`
Aujourd'hui : `build-app.sh` fait `ln -sf ~/Applications/Cairn.app/Contents/MacOS/Cairn ~/.local/bin/cairn` ; les notes
de release (`release-notes.sh --footer`) donnent la même commande ; `cairn.sh` (justfile) exécute ce binaire ou compile.
**Les liens existants chez les utilisateurs pointent sur `Contents/MacOS/Cairn`**, qui sera l'exécutable Electron après
migration. Il faut donc que l'exécutable Electron sache répondre aux sous-commandes, ou rediriger vers le binaire CLI.

### Options pour une CLI sans interface

| | A. `bun build --compile` (binaire CLI séparé, même code core) | B. `ELECTRON_RUN_AS_NODE=1` sur le binaire de l'app | C. Main Electron qui aiguille (comme `main.swift`) |
|---|---|---|---|
| Principe | `bun build src/cli.ts --compile --target=bun-darwin-arm64 --outfile cairn`, placé dans `Contents/Resources/bin/cairn` | Lien → script shell qui exporte la variable et lance `Contents/MacOS/Cairn resources/app.asar/cli.js` | `main.ts` teste `isCommandLine(argv)` avant `app.whenReady`, lance la CLI, `app.exit(code)` sans fenêtre |
| Démarrage | ~20-50 ms | ~150-300 ms | ~300-600 ms (charge le framework Electron), icône Dock possible si mal géré |
| Runtime | **Bun** (≠ Node de l'app : comportements de `child_process`, `fs`, streams à tester deux fois) | Node d'Electron (identique à l'app) | Node d'Electron (identique) |
| Taille | +55-65 Mo par arch | 0 | 0 |
| Sécurité | Indépendant des fuses | Exige la fuse `RunAsNode` **activée** : c'est exactement ce que la checklist Electron recommande de désactiver (n'importe qui peut exécuter du code avec l'identité/les droits TCC de l'app) | Fuses verrouillées possibles |
| Liens existants | Casse-tête : `Contents/MacOS/Cairn` est Electron → il faut quand même C pour rediriger | Idem | Fonctionne tel quel |
| Workers git (`git-worker`) | `process.execPath` = binaire Bun → OK | OK | Relancer le binaire Electron coûte cher → `utilityProcess`/`worker_threads` dans l'app, `child_process` du même binaire en CLI |

**Recommandation** : C comme point d'entrée unique (compatibilité des liens, un seul runtime, fuses fermées), en
gardant la CLI dans un module `cli/` sans import `electron` (testable sous `bun test`, exécutable avec `bun run` en dev).
A en option plus tard si le temps de démarrage gêne : alors le main Electron fait `execFileSync` du binaire Bun avec
`stdio: 'inherit'` et renvoie son code. Attention, APFS insensible à la casse : `Contents/MacOS/Cairn` et `…/cairn`
sont le même fichier, donc mettre un binaire séparé dans `Contents/Resources/bin/`. Dans C : `app.dock?.hide()` et
`app.setActivationPolicy('accessory')` immédiatement en mode CLI, pas de `requestSingleInstanceLock` (la CLI doit tourner
pendant que l'app est ouverte), écrire sur `process.stdout` (marche depuis un terminal, même via le lien), et vérifier
que Chromium n'ajoute rien sur stderr (`--disable-logging`, `app.commandLine.appendSwitch('log-level','3')`).

---

## 2. Processus externes et API macOS

### 2.1 Processus externes (Swift `Process`, arguments en tableau, jamais de shell sauf mention)

| Commande exacte | Où | Notes pour Node |
|---|---|---|
| `rsync -a [-H] --out-format=%i\|%n --partial-dir=.cairn-partial --delete [--delete-excluded] [-n] [--exclude-from=F] [filtres --include=/X --include=/X/** --exclude=*] [-r --files-from=F] [--link-dest=PREV] SRC/ DEST/` ; binaire `/opt/homebrew/bin/rsync` (GNU, ajoute `-H`) sinon `/usr/bin/rsync` (openrsync) | `CairnCore/BackupEngine.swift:rsync`, `rsyncPath` | `child_process.spawn`, lecture ligne à ligne de stdout (`readline`), 20 dernières lignes de stderr gardées. Pré-copie sans lien des fichiers abîmés `rsync -a --files-from=F SRC/ DEST/` ; `--existing --ignore-existing` (l.385) ; comptage en dry-run sur 4 workers (`countFiles`) |
| `kill(pid, SIGSTOP/SIGCONT/SIGTERM)` + SIGKILL après 5 s | `BackupEngine.suspend/resume/signalAll` | `process.kill(pid, 'SIGSTOP')` |
| `rsync -a --backup --suffix=.pre-restore [-n] [--exclude=/X] FROM/ TO/` (codes 0/23/24 = ok) | `CairnCore/Restore.swift:copy` | idem |
| `git -C REPO …` env `LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"`, stderr ignoré, stdin écrit sur un autre fil. Sous-commandes : `symbolic-ref`, `show-ref -q --verify`, `merge-base [--is-ancestor]`, `diff --quiet`, `worktree list --porcelain`, `status --porcelain`, `rev-list --count …`, `count-objects -v`, `fetch --all --prune --quiet`, `for-each-ref`, `rev-list --stdin --objects --disk-usage`, `rev-parse`, `worktree prune`, `branch -D`, `reflog expire --expire-unreachable=now --all`, `gc --quiet [--prune=now]`, `prune --expire=now` | `CairnCore/GitMaintenance.swift:Git.run` | `spawn('/usr/bin/git', …)` ; écrire stdin et lire stdout en parallèle (streams) pour éviter le blocage déjà évité en Swift |
| `git diff B R \| git patch-id --stable`, `git log -p --no-merges --format="commit %H" B..M \| git patch-id --stable` | `Git.pipe` | `a.stdout.pipe(b.stdin)` : rien en mémoire (règle AGENTS.md) |
| Self `Cairn git-worker REPO JSON` (pool) | `CairnCore/GitWorkerPool.swift:run`, `GitMaintenance.workerExecutable` (`main.swift`) | App : `utilityProcess.fork` ; CLI : `child_process.fork`/`spawn(process.execPath)` ; garder l'isolement mémoire par dépôt |
| `hdiutil create -size 4t -type SPARSEBUNDLE -fs APFS -volname Cairn [-encryption AES-256 -stdinpass] PATH` ; `attach [-stdinpass] -nobrowse -noautoopen -plist PATH` ; `detach MP` puis `detach -force MP` ; `verify [-stdinpass] PATH` ; `compact -batteryallowed PATH [-stdinpass]` ; `isencrypted PATH` — env `LC_ALL=C LANG=C`, mot de passe sur stdin terminé par `\0` | `CairnCore/Providers.swift:hdiutil`, `create`, `attach`, `detach`, `verify`, `compact` | `spawn` + `stdin.end(pw+'\0')` ; plist de sortie → `plutil -convert json -o - -` ou paquet `plist` |
| `smbutil view -f [-N] //user@host` (mot de passe sur stdin) | `CairnCore/DestinationProbe.swift:listShares` | idem |
| `pgrep -lx nom1\|nom2` | `CairnCore/AITools.swift:runningApps` | idem (ou `ps -axo comm`) |
| `/usr/bin/env` + PATH élargi (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, mise shims, `~/.cargo/bin`, `~/go/bin`, système), `HOMEBREW_NO_AUTO_UPDATE=1` : `brew leaves --installed-on-request`, `brew list --versions …`, `brew tap`, `mise ls --current --json`, `mise exec -- npm ls -g --depth=0 --json`, `pipx list --short`, `go version -m BIN` | `CairnCore/Inventory.swift:SystemRunner.run`, `InventoryCollector.installed` | Indispensable sous Electron : une app lancée du Finder a un PATH minimal |
| Réinstallation : `brew tap T`, `brew install N`, `mise use -g N@V`, `mise exec -- npm install -g N`, `uv tool install --force [--python P] SPEC`, `pipx install N`, `cargo install N` | `Restore.swift:ToolPlan.installCommand`, `reinstallTools` | idem |
| `xcode-select -p` (attente CLT), commande affichée `xcode-select --install` | `Restore.swift:commandLineToolsInstalled`, `waitForCommandLineTools` | idem |
| `osascript -e 'tell application "Terminal" to do script "…"' -e 'tell application "Terminal" to activate'` (CLT, installeur Homebrew via `curl … \| bash`) | `Restore.swift:openInTerminal` | idem ; garder l'échappement `\` et `"` ; demande l'autorisation Automation (TCC « contrôler Terminal ») au 1er usage |
| `diskutil info /` puis `diskutil apfs addVolume CONTAINER APFS workspaces` | `Restore.swift:createWorkspacesVolume` | idem |
| `ditto -x -k ZIP DIR`, `xattr -dr com.apple.quarantine APP`, `/bin/sh -c swapScript cairn-update PID APP NEW STAGING RELAUNCH` (attend la fin du pid, `mv`, retour arrière, `open APP`) | `Updater.swift:prepare`, `scheduleSwap` | idem, `spawn(..., {detached:true, stdio:'ignore'}).unref()` |
| Build : `swift build`, `swift scripts/make-icon.swift`, `iconutil`, `codesign --force --deep --sign -`, `ditto -c -k --keepParent`, `shasum -a 256` | `Cairn/build-app.sh` | voir §4 |

**Non utilisés aujourd'hui** (malgré la liste de départ) : `mount_smbfs`, `du`, `tmutil`, `sqlite3` en CLI, `security`
en CLI, DiskArbitration, xattr en API. SQLite est lié en bibliothèque (voir ci-dessous).

### 2.2 API macOS et équivalents

| API actuelle | Où | Équivalent Electron/Node | Module natif ? |
|---|---|---|---|
| **Keychain** `SecItemAdd/Update/CopyMatching/Delete`, `kSecClassGenericPassword` service `fr.lenzotti.cairn.image.<dest>` compte = machine ; `kSecClassInternetPassword` server=host, account=user, `kSecAttrProtocolSMB` (partagé avec le Finder) | `CairnCore/ConfigStore.swift:Keychain.*`, `Providers.swift`, `DestinationForm.swift:762` | Rien d'intégré : `safeStorage` chiffre une valeur mais **ne lit pas les entrées existantes** et ne sait pas faire d'internet password SMB. Options : (1) `/usr/bin/security` : lecture `find-generic-password -s S -a A -w`, `find-internet-password -s HOST -a USER -r "smb " -w` ; écriture via `security -i` en passant la commande `add-generic-password -U …` **sur stdin** (jamais `-w PW` en argument : visible dans `ps`) ; (2) addon N-API (Swift/ObjC ou napi-rs + crate `security-framework`), propre et sans exposition. `@napi-rs/keyring` ne couvre que le générique. | Recommandé (ou `security` CLI) |
| ACL Trousseau | — | Les éléments créés par l'app Swift (signature ad hoc) ont une ACL liée à son code : l'app Electron (autre signature) déclenchera « Cairn veut utiliser… » ; avec une signature ad hoc, **chaque mise à jour change le cdhash → nouvelle invite**. Via `security` CLI, l'ACL vise `/usr/bin/security` (pas d'invite à la mise à jour, mais tout processus utilisateur peut lire via `security` : même niveau qu'aujourd'hui en pratique). À trancher. | — |
| **NetFS** `NetFSMountURLSync` (soft mount, sans UI) + `getmntinfo` (smbfs déjà monté) + `unmount()` | `Providers.swift:SMBProvider.prepare/existingMount/close` | Pas d'API Node. `mount_smbfs -o soft //user:pw@host/share MP` met le mot de passe dans argv (refusé). Options : addon natif NetFS ; ou `osascript` `mount volume "smb://…" as user name U with password P` avec le script sur stdin (montage dans `/Volumes`, fenêtre possible si échec). Montés : parser `mount` (`/sbin/mount` → lignes `on … (smbfs`). Démontage : `diskutil unmount MP` / `umount MP`. | Recommandé |
| Joignabilité TCP 445, 3 s (`socket/connect` + getaddrinfo) | `Providers.swift:Reachability.tcp` | `net.connect({host,port,timeout})` | Non |
| `NSUserName()` | Providers, DestinationProbe, forms | `os.userInfo().username` | Non |
| **IOKit power** `IOPSCopyPowerSourcesInfo` (sur batterie, %) + `isLowPowerModeEnabled` | `CairnCore/Scheduler.swift:PowerState.current` | `powerMonitor.isOnBatteryPower()` (main) ; % et mode économie : `pmset -g batt` (`NN%`) et `pmset -g` (`lowpowermode 1`) — utilisable aussi en CLI | Non |
| **IOPMAssertion** `PreventUserIdleSystemSleep` | `Scheduler.swift:IdleSleepAssertion` | `powerSaveBlocker.start('prevent-app-suspension')` (main) ; en CLI : `spawn('caffeinate', ['-i','-w', String(process.pid)])` | Non |
| `NSWorkspace.willSleep/didWake` → suspend/resume rsync | `Cairn/BackupController.swift:start` | `powerMonitor.on('suspend'/'resume')` | Non |
| `NSWorkspace.didMount/didUnmount` | `BackupController.swift`, `DestinationForm.swift:52` | `fs.watch('/Volumes')` + rafraîchissement | Non |
| `NWPathMonitor` (retour réseau → tick) | `BackupController.swift` | `net.isOnline()` en polling (le tick est déjà de 60 s) ou événements `online` du renderer | Non |
| **Notifications** `UNUserNotificationCenter`, catégories avec actions (« Voir le journal », « Nettoyer », « Rappeler plus tard »), `willPresent` banner+son pour le disque | `Cairn/Notifier.swift`, `Cairn/MenuBarPanel.swift:StorageMonitor` | `new Notification({title, body, actions:[{type:'button', text}]})`, événements `click`/`action`. Sur macOS, les actions exigent une app signée et un style « Alertes » ; à vérifier avec une signature ad hoc. | Non (à valider) |
| **Ouverture à la connexion** `SMAppService.mainApp.register()` + repli `NSAppleScript` System Events | `Cairn/Background.swift:apply` | `app.setLoginItemSettings({openAtLogin:true})` (SMAppService sur macOS 13+) ; `getLoginItemSettings().status` pour `requires-approval` | Non |
| `NSApp.setActivationPolicy(.accessory/.regular)` (sans Dock quand fenêtre fermée) | `Background.swift`, `App.swift`, `MenuBarPanel.swift` | `app.setActivationPolicy('accessory'\|'regular')`, `app.dock.hide()/show()` ; `window-all-closed` sans `app.quit()` si tâche de fond | Non |
| `applicationWillTerminate` → arrêt de rsync | `App.swift:AppDelegate` | `app.on('before-quit')` + `will-quit` (tuer les enfants, libérer le verrou) | Non |
| **Barre des menus** `MenuBarExtra(.window)` + symbole dynamique | `App.swift`, `MenuBarPanel.swift` | `Tray` + `BrowserWindow` sans cadre positionnée sous `tray.getBounds()`, masquée sur `blur` ; icône = `nativeImage` template (pas de SF Symbols : PNG @1x/@2x issus des SVG Lucide déjà dans `Resources/`) | Non |
| `NSOpenPanel` | AppModel, Onboarding, Restore, Tools, DestinationForm | `dialog.showOpenDialog` (main) | Non |
| `NSPasteboard` | AppModel, BackupView | `clipboard.writeText` (main, via IPC) | Non |
| `NSWorkspace.open(url)` / `activateFileViewerSelecting` | Notifier, UpdateController, AppModel | `shell.openPath` / `shell.openExternal` (liste blanche) / `shell.showItemInFolder` | Non |
| **Corbeille** `FileManager.trashItem` | `Cairn/AppModel.swift:362`, `Cairn/GitView.swift:584` | `shell.trashItem(path)` (main seulement ; la CLI ne met rien à la corbeille aujourd'hui) | Non |
| Suppression définitive `removeItem` | DestinationRemoval, Retention… | `fs.rm({recursive:true})` | Non |
| **flock** `LOCK_EX\|LOCK_NB` (verrou d'opération partagé app/CLI, libéré si crash) ; `flock` bloquant (`activity.lock`) | `CairnCore/Support.swift:OperationLock`, `ActivityLog.swift` | **Absent de Node et de Bun.** Options : addon natif (`fs-ext` ou maison) ; ou fichier pid créé en `O_EXCL` + test de vie `process.kill(pid,0)` + reprise si mort (perd l'atomicité du noyau). Pendant la migration, l'app Swift et la CLI TS peuvent coexister : même fichier `state/operation.lock`, même sémantique, sinon double écriture possible. | Recommandé |
| `statfs` (espace libre, repli réseau), `getmntinfo` | `DestinationProbe.swift:availableBytes`, `Providers.swift` | `fs.statfs` (`bavail*bsize`) | Non |
| `volumeAvailableCapacityForImportantUsage` (inclut le purgeable APFS), `volumeName`, `volumeTotalCapacity` | `CairnCore/Scanner.swift:volumeInfo` (alertes disque) | Pas d'équivalent : `fs.statfs` ignore le purgeable → alertes « disque plein » trop tôt. `diskutil info -plist /` (`APFSContainerFree`) en approchant ; exact : addon natif `URLResourceValues`. | Optionnel |
| `lstat` + `st_blocks*512` (taille allouée), `st_dev` (ne pas changer de volume), `DispatchQueue.concurrentPerform` | `Scanner.swift:scan` | `fs.lstat(p, {bigint:true})` → `blocks`, `dev` ; parallélisme par `worker_threads`. Garder l'analyse en lecture seule. | Non |
| `resourceValues` (isDirectory, isSymbolicLink, modif, taille) | Git, Integrity, Onboarding | `fs.lstat` | Non |
| `posixPermissions` 0o700/0o600 (`~/.cairn`, `.ssh` restauré) | `Support.swift:ensure`, `Restore.swift:277-285` | `fs.mkdir({mode})` + `fs.chmod` | Non |
| **SQLite** `sqlite3_backup_*` (snapshot cohérent, `busy_timeout 2000`), `PRAGMA quick_check`, `journal_mode=DELETE` | `CairnCore/AITools.swift:snapshot`, `quickCheck` | `node:sqlite` (`DatabaseSync`, `backup()` dans Node ≥ 22.16/23.8) marche sous Electron mais **pas sous Bun** (`bun:sqlite` a une autre API). Le plus simple, commun aux deux : `/usr/bin/sqlite3 SRC ".timeout 2000" ".backup DST"` et `sqlite3 -readonly F "PRAGMA quick_check;"`. Sinon une interface avec deux implémentations. | Non |
| **CryptoKit SHA256** | `Integrity.swift` (en flux), `Updater.swift:prepare` (zip chargé entier en mémoire) | `crypto.createHash('sha256')` en flux | Non |
| `Host.current().localizedName` (nom de version/machine), `uname().machine` | `BackupEngine.swift:machineName`, `arch()` | `scutil --get ComputerName` (≠ `os.hostname()` : garder le même nom, sinon les sauvegardes existantes ne sont plus reconnues comme « ce Mac »), `os.machine()` (`arm64`/`x86_64`) | Non |
| `Locale.preferredLanguages` | `L10n.swift:system` | `app.getPreferredSystemLanguages()` (app) ; CLI : `defaults read -g AppleLanguages` ou `Intl` / `LANG` | Non |
| `Bundle.module` `.strings`/`.stringsdict` (pluriels) | `L10n.swift`, `Resources/*.lproj` | Convertir une fois en JSON + `Intl.PluralRules` ; garder le test « pas de texte non traduit » | Non |
| `Bundle.main.infoDictionary` (version) | `BackupEngine.swift:CairnVersion` | `app.getVersion()` / version injectée au build (`bun build --define`, import `package.json`) | Non |
| **Full Disk Access** | aucun code | Aucune détection aujourd'hui. Avec Electron, l'accès TCC est accordé à l'app (et à l'exécutable qui spawn rsync) ; une signature ad hoc qui change à chaque version peut **faire perdre l'autorisation à chaque mise à jour** (TCC suit l'identité de signature). À tester. | — |

**Addon natif proposé** (un seul module Swift/ObjC → N-API, compilé pour arm64/x64, chargé seulement dans le main et la CLI) :
Keychain (générique + internet SMB), NetFS mount, flock, et éventuellement capacité « importante » du volume. Le reste
passe par les API Electron ou des binaires système. Un addon `.node` ne se charge pas dans un binaire `bun --compile`
sans précautions (il faut l'embarquer et l'extraire) : encore un argument pour l'option C.

---

## 3. Planification, notifications, barre de menus, mises à jour

### Planification (`CairnCore/Scheduler.swift` + `Cairn/BackupController.swift`)
- Pas de launchd ni de `SMAppService` daemon : **le planificateur ne tourne que pendant que l'app est ouverte**.
  Le « mode tâche de fond » (`schedule.background`) = ouverture à la connexion (`Background.swift`) + rester dans la
  barre des menus sans fenêtre.
- `BackupController.tick()` toutes les 60 s, plus sur retour réseau (+5 s), réveil, montage d'un volume. Pour chaque
  destination : joignabilité, puis `BackupSchedule.decide` (fonction pure : manual / notDue / alreadyRunning / retryLater
  1 h après un échec / waitingPower si batterie avec mode économie ou `%` < `on_battery_min_percent` / waitingDestination / run),
  `shouldNotifyOverdue` (retard > 1 jour, au plus 1 notification/jour). Assertion anti-veille pendant la sauvegarde ;
  suspension SIGSTOP sur veille, SIGCONT au réveil.
- Electron : porter `BackupSchedule` tel quel (pur, testable sous `bun test` avec horloge simulée) ; `setInterval(60 s)` dans
  le main ; `powerMonitor` (`suspend`, `resume`, `on-ac`, `on-battery`) ; `powerSaveBlocker` ; `fs.watch('/Volumes')`.
  Garder le même modèle (pas de launchd) pour limiter le changement ; si on veut des sauvegardes app fermée, un LaunchAgent
  qui lance `cairn backup` serait un changement OpenSpec à part.

### Notifications (`Cairn/Notifier.swift`, `StorageMonitor` dans `MenuBarPanel.swift`)
- Disponibles seulement dans un bundle `.app`. Catégorie `cairn.log` avec action « Voir le journal » (`userInfo.log` → ouvre
  le fichier avec l'app par défaut) ; catégorie `cairn.disk` (« Nettoyer » ouvre l'onglet Nettoyable avec présélection,
  « Rappeler plus tard ») ; vérification disque toutes les 15 min.
- Electron : `Notification` (main) + `click`/`action` → `shell.openPath(log)` ou focus fenêtre + navigation via IPC.
  Garder une référence aux notifications (sinon le GC peut perdre les gestionnaires). En CLI : pas de notification
  (comme aujourd'hui).

### Barre de menus (`App.swift` `MenuBarExtra(.window)`, `MenuBarPanel.swift`)
- Panneau SwiftUI : état, « Sauvegarder maintenant », menu (Analyser, Ouvrir, Réglages, Quitter), date de la dernière analyse ;
  symbole qui change selon l'état (`model.menuBarSymbol`).
- Electron : `Tray` (icône template par état) + petite `BrowserWindow` (`frame:false`, `transparent`, `skipTaskbar`,
  `alwaysOnTop`, `show:false`) qui partage le même preload/IPC typé que la fenêtre principale. Paquet `menubar` possible,
  mais ~50 lignes maison suffisent.

### Mises à jour (`CairnCore/Updater.swift`, `Cairn/UpdateController.swift`)
- Flux : `GET https://api.github.com/repos/Romakita/cairn/releases/latest` (`Accept: application/vnd.github+json`,
  `User-Agent: Cairn/<v>`, 20 s ; `CAIRN_UPDATE_URL` pour les tests). Rejet si `draft`/`prerelease`. Assets attendus :
  `Cairn-<version>-<arch>.zip` + `.zip.sha256` (`arch` = `arm64` | `x86_64`). Notes = `body` (affichées dans l'app).
  Comparaison semver maison (`isNewer`, préversion < finale).
- Contrôle 5 s après le lancement puis toutes les 6 h si `updates.check` ; manuel via menu « Rechercher les mises à jour ».
  Bloqué pendant une sauvegarde ou si le bundle n'est pas remplaçable (parent non modifiable, exécution de dev).
- Vérification : **uniquement SHA-256 du zip comparé au `.sha256` de la même release** (intégrité, pas authenticité :
  quelqu'un qui peut publier une release peut publier les deux), puis `ditto -x -k` dans `<parent>/.cairn-update`, contrôle
  `CFBundleIdentifier == fr.lenzotti.cairn` et `CFBundleShortVersionString == version`, `xattr -dr com.apple.quarantine`.
  Aucune vérification de signature de code. Remplacement : script `/bin/sh` détaché qui attend la fin du pid (60 s max),
  `mv` ancien → `.cairn-update/Cairn.previous.app`, `mv` nouveau, retour arrière si échec, `open` pour relancer.
- Electron : **electron-updater / Squirrel.Mac exige une app signée Developer ID** (il vérifie que la nouvelle version
  satisfait la designated requirement de l'ancienne) → inutilisable avec une signature ad hoc. Garder le mécanisme maison,
  porté en TS : `net.fetch` ou `fetch` Node, `crypto` en flux (ne pas charger 100-150 Mo en mémoire), même script de swap,
  `app.quit()`. Lire `Info.plist` avec `plutil -convert json`. Ajout conseillé : signer le `.sha256` (minisign/ed25519,
  clé publique embarquée) pour avoir l'authenticité sans compte Apple.
- **Migration** : l'app Swift 0.8.x installera la première version Electron si et seulement si le zip respecte son contrat :
  nom `Cairn-<v>-arm64.zip` (pas `x64`/`arm64` à la mode electron-builder pour Intel : utiliser `x86_64`), `Cairn.app`
  à la racine du zip, `CFBundleIdentifier` `fr.lenzotti.cairn` (`appId`), `CFBundleShortVersionString` = version
  (electron-builder le met depuis `package.json`). Le dossier `.cairn-update` et le script restent compatibles.
  Le zip passe de ~5 Mo à ~100-120 Mo par arch.

---

## 4. Build, CI, release

### Aujourd'hui
- `Cairn/build-app.sh` : `swift build -c release`, bundle `build/Cairn.app` fait à la main (binaire + `Cairn_CairnCore.bundle`
  + `AppIcon.icns` via `swift scripts/make-icon.swift` et `iconutil`), `Info.plist` écrit à la main (`fr.lenzotti.cairn`,
  version `Cairn/VERSION`, build = `git rev-list --count HEAD`, `LSMinimumSystemVersion 14.0`, en/fr),
  **`codesign --force --deep --sign -` (ad hoc), pas de Developer ID, pas de notarisation** (la note de release
  demande clic droit → Ouvrir ou `xattr -dr com.apple.quarantine`). `--zip` : `ditto -c -k --keepParent` →
  `build/Cairn-<v>-<uname -m>.zip` + `shasum -a 256`. Installation : copie dans `~/Applications`, lien `~/.local/bin/cairn`.
- `.github/workflows/ci.yml` (macos-15, Xcode 16) : `swift build`, `swift test`, `build-app.sh --no-install`,
  `scripts/smoke-test-app.sh` (copie hors du dépôt, `.build` caché, `cairn --version`, `help` fr/en, `ai --json`,
  `tools --json`, lancement de l'interface 8 s). Sur push `main` → `release.yml`.
- `.github/workflows/release.yml` : Node 22 + `npx semantic-release@25.0.9` avec `@semantic-release/exec@7.1.0`,
  `git@11.0.1`, `github@12.0.10`, `conventional-changelog-conventionalcommits@10.4.1`. `.releaserc.json` :
  `generateNotesCmd` = `scripts/release-notes.sh --footer`, `prepareCmd` = `scripts/release-prepare.sh` (notes →
  `bump-version.sh` met à jour `Cairn/VERSION`, la constante `CairnVersion.fallback` de `BackupEngine.swift` et
  `CHANGELOG.md` → `swift test` → build zip → smoke test). Commit `chore(release): X [skip ci]`, tag `vX`, release
  GitHub « Cairn X » avec `Cairn/build/Cairn-*.zip(.sha256)`. **Une seule architecture publiée : celle du runner (arm64)**.

### Cible Electron proposée
- **electron-builder** plutôt qu'electron-forge : configuration déclarative, zip/dmg, `afterPack`/`afterSign`, fuses
  (`electronFuses`), `asarUnpack` pour l'addon natif, et il marche avec Bun comme gestionnaire de paquets (lockfile
  `bun.lock`). Forge suppose npm/yarn pour plusieurs étapes et ses plugins de bundling (Vite/webpack) font doublon avec
  `bun build`. Points à vérifier : electron-builder collecte `node_modules` en le parcourant ; avec `bun install` en mode
  isolé (défaut des workspaces dans Bun 1.3), forcer `linker = "hoisted"` dans `bunfig.toml` ; le binaire Electron
  se télécharge par le postinstall d'`electron` (Bun ne lance pas les scripts des dépendances non approuvées :
  `trustedDependencies: ["electron"]`).
- Bundling : `bun build` en 3 cibles (`main.ts` et `preload.ts` en `--target=node --format=cjs` avec `electron` en
  `--external`, renderer en `--target=browser`), puis electron-builder emballe `dist/`. Tests : `bun test` sur core/CLI ;
  un test d'intégration sous `ELECTRON_RUN_AS_NODE` en CI seulement (fuse ouverte dans le build de test, pas en release)
  ou `node --test` pour couvrir la différence Bun/Node sur `child_process`/`fs`.
- Config clé : `appId: fr.lenzotti.cairn`, `productName: Cairn`, `mac.target: zip` (+ dmg en option),
  `artifactName: Cairn-${version}-${arch}.${ext}` avec renommage `x64` → `x86_64` dans un script, `mac.minimumSystemVersion: 14.0`,
  `extendInfo` (`CFBundleLocalizations`, `LSApplicationCategoryType`), `CFBundleVersion` = nombre de commits (`buildVersion`).
  **Signature ad hoc** : sur Apple Silicon une app non signée ne se lance pas ; `mac.identity: null` désactive la signature
  → ajouter un `afterPack` `codesign --force --deep --sign - Cairn.app` (ou `identity: "-"` si la version
  d'electron-builder le gère ; à vérifier), `hardenedRuntime: false`, `gatekeeperAssess: false`, pas de `notarize`.
  Fuses : `RunAsNode: false`, `EnableNodeOptionsEnvironmentVariable: false`, `EnableNodeCliInspectArguments: false`,
  `EnableEmbeddedAsarIntegrityValidation: true`, `OnlyLoadAppFromAsar: true`, `EnableCookieEncryption: true`.
  Re-signer après l'écriture des fuses (electron-builder le fait si c'est lui qui signe).
- Zip : vérifier que `Cairn.app` est à la racine (exigence de l'updater actuel) ; sinon `ditto -c -k --keepParent` comme
  aujourd'hui dans un script.
- Version : `package.json` devient la source ; `bump-version.sh` met à jour `package.json` (et `Cairn/VERSION` si gardé
  pour `just version`) ; `@semantic-release/git` assets = `package.json`, `Cairn/VERSION`, `CHANGELOG.md` (retirer
  `BackupEngine.swift`). La constante de repli disparaît (version injectée au build). Garder `release-notes.sh` (indépendant
  du langage) et mettre à jour son footer (lien `cairn`, quarantaine).
- CI : `macos-15`, `oven-sh/setup-bun@v2` (version figée), `bun install --frozen-lockfile`, `bun test`, `bun run build`,
  `electron-builder --mac zip --arm64 --x64` (Intel à décider : aujourd'hui non publié), `smoke-test-app.sh` adapté
  (mêmes contrôles, binaire `Contents/MacOS/Cairn`, sortie stdout propre). Cache `~/.bun/install/cache` et
  `~/Library/Caches/electron`. `release.yml` peut rester tel quel (Node 22 pour semantic-release ; ou `bunx`).
- `justfile` : `test` → `bun test`, `storage-install` → build + copie + lien, `gallery` → page Storybook-like ou route dev.

---

## 5. Sécurité Electron pour Cairn

Cairn manipule le home, des mots de passe (Trousseau, SMB, images chiffrées), lance rsync/git/hdiutil et supprime des fichiers :
le renderer doit être traité comme non fiable.

- `webPreferences` : `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`,
  `webSecurity: true`, `allowRunningInsecureContent: false`, `spellcheck: false` ; pas de `webviewTag`. `app.enableSandbox()`.
- **Preload minimal et typé** : `contextBridge.exposeInMainWorld('cairn', api)` avec des fonctions métier
  (`scan(folderId)`, `startBackup({destinations, dryRun})`, `trash(nodeIds)`, `onProgress(cb)`), jamais `ipcRenderer`
  brut, ni `exec`, `fs` ou `shell` génériques. Types partagés `ipc-contract.ts` (canal → args → résultat), `ipcMain.handle` seulement.
- **Validation dans le main** (zod/valibot) de chaque argument ; vérifier `event.senderFrame.url` (origine de l'app).
  Les suppressions passent par des identifiants issus du dernier scan connu du main, pas par des chemins libres ;
  la confirmation des actions destructives (corbeille, nettoyage git, restauration `--apply`, suppression de destination)
  est faite **par le main** (`dialog.showMessageBox`) ou revérifiée côté main ; simulation par défaut comme la CLI.
- Secrets : mots de passe saisis envoyés une fois au main puis écrits au Trousseau, jamais renvoyés au renderer ni
  journalisés ; seul le mot de passe d'une nouvelle image est affiché une fois. Passage à `hdiutil`/`smbutil` sur stdin
  uniquement. `spawn` avec tableaux d'arguments, sans `shell: true` (hors script de swap figé, arguments positionnels).
- Contenu : charger via un protocole maison (`protocol.handle('app', …)`) plutôt que `file://` ; CSP stricte
  (`default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self'`) ; aucune ressource distante.
- Navigation : `will-navigate` → `preventDefault`, `setWindowOpenHandler` → `deny` ; `shell.openExternal` seulement pour
  une liste blanche (`https://github.com/Romakita/cairn/…`) ; `session.setPermissionRequestHandler` → tout refuser.
- Fuses (§4) : surtout `RunAsNode: false` (sinon le binaire signé devient un interpréteur Node pour qui veut, et hérite
  des droits TCC/Accès complet au disque de Cairn) et l'intégrité ASAR. Pas de `--inspect` en production.
- `app.requestSingleInstanceLock()` pour l'interface (pas pour la CLI) ; verrou d'opération (`flock`) conservé entre app et CLI.
- Mises à jour : HTTPS uniquement, SHA-256 en flux + contrôle bundle id/version (déjà fait), idéalement signature
  ed25519 du `.sha256` ; ne jamais exécuter de code téléchargé avant ces contrôles.
- Le chemin de l'addon natif et des binaires appelés est absolu (`/usr/bin/git`, `/usr/bin/hdiutil`…) comme aujourd'hui,
  pour ne pas dépendre du PATH (sauf l'inventaire, qui élargit volontairement le PATH).

---

## Résumé

1. CLI : 10 commandes + `git-worker`, codes 0/1/2, JSON à clés triées, stdout/stderr séparés. Les liens `~/.local/bin/cairn` existants visent `Contents/MacOS/Cairn` : le main Electron doit aiguiller (option C, recommandée) ; binaire `bun --compile` en option, `ELECTRON_RUN_AS_NODE` à écarter (fuse RunAsNode).
2. Processus à porter tels quels avec `child_process` : rsync (GNU/openrsync), git (+ pipes patch-id), hdiutil (mot de passe sur stdin), smbutil, pgrep, brew/mise/npm/uv/pipx/cargo/go, xcode-select, osascript Terminal, diskutil, ditto/xattr/sh.
3. Pas d'équivalent Node : Keychain (générique et SMB), NetFS mount, flock, capacité « importante » du volume → un petit addon natif (ou `security -i`/`mount` + pid-file en repli).
4. API Electron directes : Tray, Notification (actions à valider en ad hoc), setLoginItemSettings, setActivationPolicy, powerMonitor, powerSaveBlocker, dialog, clipboard, shell.trashItem/openPath.
5. SQLite : `sqlite3 .backup` en CLI système (commun à Bun et Node) plutôt que `node:sqlite`/`bun:sqlite`.
6. Planification : en mémoire dans l'app (tick 60 s, pas de launchd) ; logique pure `BackupSchedule` à porter avec ses tests.
7. Mises à jour : mécanisme GitHub maison (SHA-256 + bundle id + script de swap) ; electron-updater impossible sans Developer ID. Le zip Electron doit garder le contrat de l'updater Swift pour migrer les utilisateurs.
8. Build : electron-builder (Bun, `linker=hoisted`, `trustedDependencies`), ad hoc via `afterPack`, pas de notarisation (comme aujourd'hui), fuses fermées ; semantic-release conservé, `package.json` source de version.
9. Risques : invites Trousseau et perte de l'Accès complet au disque à chaque mise à jour ad hoc ; zip ~20× plus gros ; double runtime Bun/Node à tester.
10. Sécurité : sandbox + contextIsolation, preload typé à API métier, validation et confirmations dans le main, CSP, navigation bloquée.

Fichier : `/private/tmp/claude-501/-Users-romainlenzotti--claude-spares-spare-fLVdGi/3ab24817-00e6-4eb1-9b80-03320e572738/scratchpad/inventory-platform.md`
