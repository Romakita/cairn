# Todo

Plan de la tâche en cours (voir la section « Gestion des tâches » d'AGENTS.md).
Les nouvelles fonctionnalités passent plutôt par un changement OpenSpec (`/opsx:propose`).

## Tâche en cours — passer les tests de Cairn à Swift Testing (branche `test/swift-testing`, faite)

Xcode 27.2 est installé : le framework `Testing` et ses macros (`@Test`, `#expect`), comme celle de `@State`, sont
enfin disponibles. Aujourd'hui : 241 tests dans l'exécutable `cairn-selftest`, mini framework maison
(`TestCase`, `expect`, `expectEqual`, `expectThrows`), 25 suites enregistrées à la main dans `main.swift`.

Pré-requis (à faire par l'utilisateur, sudo) : `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`,
`sudo xcodebuild -license accept`, `xcodebuild -runFirstLaunch`.

Points délicats repérés :

- Trois tests relancent le binaire de test comme processus auxiliaire (`--hold-lock` dans `SupportTests`,
  `--append-activity` dans `HubTests`) et `GitTests` cherche l'exécutable `Cairn` à côté de `CommandLine.arguments[0]`.
  Sous `swift test`, le binaire est le lanceur xctest : ces modes doivent passer dans un petit exécutable
  `cairn-test-helper`, retrouvé à côté du bundle de test. `--excludes` (comparaison avec l'ancien `backup.sh`, retiré)
  est supprimé s'il n'a plus d'usage.
- `main.swift` fixe `CAIRN_HOME` pour tout le processus : à reprendre dans un trait commun ou dans l'initialisation
  des suites, pour ne jamais toucher au vrai `~/.cairn`.
- Swift Testing lance les tests en parallèle ; le code actuel ne l'a jamais été (environnement global, `L10n`,
  verrous). Première étape en `.serialized` ; la parallélisation viendra suite par suite, une fois vérifiée.
- La CI utilise Xcode 16 (`macos-15`) et `swift-tools-version:5.10` : garder 5.10 (pas de passage au mode Swift 6
  dans ce changement) et vérifier que Swift Testing passe avec l'Xcode de la CI ; sinon passer la CI sur un runner
  plus récent.

Plan :

- [x] 1. Cible `.testTarget(name: "CairnTests")` + exécutable `CairnTestHelper` dans `Package.swift`.
- [x] 2. Conversion des 23 fichiers (5 sous-agents, chacun vérifié dans sa propre copie du paquet), puis suites
  renommées `XxxTests` comme leurs fichiers : un nom de suite comme `Scanner` masquait le type de CairnCore dans
  toute la cible.
- [x] 3. Processus auxiliaires dans `CairnTestHelper` (`builtExecutable`), `CAIRN_HOME` dans le trait
  `.temporaryCairnHome` de la suite racine (exécution en série). `--excludes` supprimé (plus utilisé).
- [x] 4. `CairnSelfTest` supprimé ; `withTempDir`, `writeFile`, `shell`, `packageRoot` dans `TestSupport.swift`.
- [x] 5. `just test [filtre]` → `swift test --filter` (message clair si Xcode n'est pas sélectionné) ; CI et
  `release-prepare.sh` → `swift test`.
- [x] 6. Docs : `AGENTS.md`, `README.md`, `README.fr.md`, `Cairn/README.md`, commentaire de `Package.swift`.
- [ ] 7. Reporté : `@ViewState` → `@State` obligerait à avoir Xcode pour construire l'app, sans aucun gain
  (simple alias).

## Revue — passage à Swift Testing (2026-11-09)

- [x] 238 tests : 237 réussis + le test lent `matches_du_on_workspaces_within_1_percent`, sauté sans
  `CAIRN_TESTS_SLOW=1`. Mêmes noms que les 239 de l'ancien harness, moins les 2 tests du mini framework
  (`Harness.*`), retirés avec lui.
- [x] `just test Backup` : 35 tests (suites `BackupTests` et `BackupWarningTests`).
- [x] Aucun fichier de `~/.cairn` modifié pendant les tests.
- [x] Un échec volontaire sort en code 1 avec le fichier, la ligne, le message et les valeurs comparées.
- [x] Sans Xcode sélectionné, `just test` explique la commande `xcode-select` à lancer.
- [x] L'app se construit toujours avec les seuls Command Line Tools (`build-app.sh --no-install` + smoke test).
- Correction faite en route : `CairnResources` cherche aussi le bundle de ressources à côté du code de CairnCore
  (sous `swift test`, `Bundle.main` est le lanceur xctest d'Xcode).
- [x] Optimisation : 94 s → 14-21 s (5 lancements de suite, tous verts).
  - Inventaire des outils remplacé par un inventaire vide dans les tests (`BackupService.collectInventory`) : il
    lançait brew, mise, npm… de la machine, 1,4 s par sauvegarde, et rendait les tests dépendants du Mac.
  - Tests en parallèle ; ceux qui touchent l'état global (`CLI.run`, `L10n.current`, texte traduit comparé) portent
    `.globalState` et passent un par un (verrou commun). `GitMaintenance.analyzeAll(executable:)` remplace la
    modification de `workerExecutable` dans le test du pool.
- [ ] CI : à vérifier sur la PR (Xcode 16 sur `macos-15` ; le trait `TestScoping` demande Swift 6.1).

Commits : `test: …`, `ci: …`, `refactor(app): use @State …`, `docs: …` (pas de release).

## Revue — vérification de bout en bout de Cairn (tâche 11.3 de `cairn-integration-scripts`, 2026-11-08)

Vérifié sur cette machine :

- [x] `just test` : 100 tests réussis, après chaque lot.
- [x] Les 8 recettes `just` (`backup-dry`, `restore`, `check`, `verify`, `git-clean`, `tools`, `storage-report`, `test`)
  passent en simulation (code 0).
- [x] Analyse : totaux identiques à `du -sk` (écart 0,000 % sur 172,85 Go).
- [x] Nettoyage git sur un dépôt de test : la simulation liste la branche `gone` et le worktree orphelin sans rien
  modifier ; `--apply` après confirmation les supprime et note les SHA dans `.git/cleanup-deleted-branches.log`.
- [x] `cairn git --json` en en-US et en fr-FR : sorties identiques octet par octet.
- [x] Sauvegarde chiffrée réelle vers une destination locale (même code d'image sparsebundle que le NAS) :
  la destination ne contient que l'image, la 2ᵉ version ne copie que 3 ko, `verify --full` donne 0 fichier abîmé,
  `restore` en simulation liste les outils, et l'image est démontée à la fin.
- [x] Reprise d'une sauvegarde interrompue, rétention, intégrité (fichier abîmé détecté puis recopié), mise en attente
  d'une destination injoignable, planificateur avec horloge, alimentation et réseau simulés : couverts par les tests.
- [x] Outils IA : 304 conversations Claude Code et 809 Codex détectées ; `backup --only ai --tool codex` ne crée que
  `ai/codex/`.
- [x] Panneau de la barre des menus et écrans dans les deux langues : rendus hors écran (`Cairn --snapshot`).
- Correction faite pendant la revue : la progression de `cairn git` n'est plus écrite quand la sortie d'erreur n'est
  pas un terminal (elle se collait au reste du texte dans les journaux).

Corrections après `/opsx:verify` (7 manques bloquants, chacun avec un test, 108 tests au total) :

- [x] Une simulation n'écrit plus rien sur la destination (ni image, ni dossier, ni `versions/`).
- [x] Une version partielle (`--only`, outils IA seuls) est marquée dans le manifest : elle ne devient pas
  « latest », ne sert pas de base aux suivantes (base cherchée partie par partie), n'entre pas dans la rétention et
  n'est pas la version proposée par défaut à la restauration.
- [x] Le journal de chaque version est cité dans son manifest ; la purge des journaux épargne ceux des versions gardées.
- [x] Restauration sur un Mac neuf : mot de passe du NAS et de l'image demandés (app et `cairn restore`), image d'une
  autre machine reprise, connexion ponctuelle à un NAS sans configuration.
- [x] Restauration IA : l'outil ouvert doit être quitté (attente), sinon il est passé ; les données qui gardent les
  anciens chemins sont signalées ; les droits des identifiants sont rétablis après la fusion.
- [x] Sauvegardes `backup.sh` : `mise-config.toml` est relu, et la copie du home ne recopie plus les dossiers IA
  (ils passent par la fusion).

Avertissements de `/opsx:verify` (environ 45 points, 4 lots en parallèle puis fusion, 160 tests au total) :

- [x] Sauvegarde et CLI : résultat de simulation affiché, `hdiutil verify` mensuel, notification d'un fichier abîmé,
  vérification complète depuis l'app, accès au journal depuis la notification d'échec, confirmation pour désactiver le
  chiffrement, rétention plus courte refusée si la destination est illisible, `--json` pour restore/verify/config,
  `--yes` partout, vraie version dans le manifest, rsync arrêté quand l'app quitte, icône de barre des menus toujours
  visible, état d'intégrité tenu à jour.
- [x] Git, analyse, alertes, barre des menus : confirmation dédiée des worktrees à risque, prune sans gc, export TSV,
  branche fusionnée d'un worktree proposée, présélection de Nettoyable, corbeille par défaut, lien Projets → Git, points
  de montage, relevé après sauvegarde/nettoyage, démarrage au lancement, icône animée et états, prochaine sauvegarde et
  analyse ancienne dans le panneau, alertes à l'accueil.
- [x] Outils IA et restauration : outils décrits par leurs seuls profils (nom, exclusions du home), outils ouverts
  notés au journal, plugins déclarés listés, taille sauvegardée et dernière sauvegarde, cible `/Volumes/<nom>` absente
  détectée, étape Command Line Tools, vérification finale et bouton Vérifier, identifiants ignorés si une destination
  n'est pas chiffrée.
- [x] Configuration, langues, inventaire : `~/.cairn` en 700, erreur de syntaxe bloquante, pas d'écrasement d'un fichier
  invalide, plus de clé `keychain` écrite (entrée déduite de `url` + `username`), outil IA retiré du fichier, `tools
  --json` stable, versions uv/go/local-bin, pluriels (`.stringsdict`), durées localisées.
- [x] Après fusion : `-H` avec rsync GNU, simulation comparée à la version de base (openrsync échouait avec `-n` et
  `--link-dest`), snapshot SQLite retenté si l'outil ferme sa base, simulation de restauration sans créer la cible,
  design et spec alignés.

Deuxième `/opsx:verify` (4 points bloquants corrigés, 166 tests) :

- [x] La branche principale locale n'est jamais proposée, même extraite dans un worktree lié (`origin/HEAD`).
- [x] Une base SQLite absente du Mac est toujours restaurée ; une base présente n'est remplacée que sur confirmation, et
  garde son WAL dans le `.pre-restore`.
- [x] Un dossier de projet Claude n'est supprimé qu'après une fusion réussie (sinon il reste et c'est signalé) ; le
  préfixe le plus long l'emporte.
- [x] `cairn restore --tool ID` (répétable) choisit les outils IA.
- Restent des avertissements (textes anglais des étapes de restauration, messages traduits dans certains `--json`,
  notifications de sauvegarde et d'alerte qui se partagent le délégué, `.pre-restore` écrasé à la 2e restauration,
  outil IA ouvert qu'on ne peut pas passer, choix de l'image avec plusieurs Mac sur le NAS).

Reste à faire à la main (impossible ici : NAS, veille réelle, compte vierge) :

- [ ] 7.4 : sauvegarde chiffrée sur le NAS Synology ; NAS éteint (sauvegarde en attente, autres destinations
  non touchées), puis rallumé (départ dans les 5 minutes).
- [ ] 7.5 : fermer le capot pendant une sauvegarde et la voir reprendre au réveil ; batterie sous 20 %.
- [ ] 10.5 et 11.3 : premier lancement sur un compte macOS vierge, puis restauration complète depuis le NAS sur ce
  compte, en en-US et en fr-FR.

<!--
## <Titre de la tâche>

- [ ] Étape 1
- [ ] Étape 2

### Revue
- Ce qui a changé :
- Comment c'est vérifié :
-->
