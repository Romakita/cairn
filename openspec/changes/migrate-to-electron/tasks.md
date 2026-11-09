# Tasks

Références : `parity/behavior.md` (B), `parity/ui.md` (U), `parity/platform.md` (P). Un « test de régression » est un test de `test/regressions/` nommé par le commit d'origine (B §2).

## 1. Socle du projet `desktop/`

- [x] 1.1 Créer `desktop/` (package.json, tsconfig strict, bunfig `linker = "hoisted"`, `trustedDependencies: ["electron"]`) avec Electron, React 19 et electron-builder ; vérifier que `bun install --frozen-lockfile` passe
- [x] 1.2 Écrire les scripts `bun build` (main et preload en CJS, renderer pour le navigateur) et `bun run start` ; vérifier qu'une fenêtre vide s'ouvre avec `sandbox` et `contextIsolation` activés
- [x] 1.3 Aiguiller la CLI dans `main.ts` (règle `isCommandLine` de P §1, Dock masqué, sortie vidangée avant `app.exit`) ; vérifier que `Cairn --version` affiche seulement `cairn <v>` avec le code 0, l'app étant aussi ouverte
- [x] 1.4 Ajouter le lint (interdire `Bun`/`bun:*` et `electron` dans `src/core`, couleurs littérales hors `tokens.css`, contrôles natifs hors `ui/`) ; vérifier qu'un fichier de test fautif fait échouer `bun run lint`
- [x] 1.5 Ajouter les recettes `just desktop-*` (start, test, lint, dev-web, shots, build), sans toucher aux recettes Swift ; vérifier `just --list`

## 2. Module natif

- [x] 2.1 Écrire `native/` (Objective-C, N-API, `node-gyp`, Command Line Tools seules) : Trousseau générique et Internet SMB (lire, ajouter, mettre à jour) ; vérifier par un test qu'une entrée écrite par la version Swift est relue
- [x] 2.2 Ajouter `flock` exclusif non bloquant et bloquant ; vérifier par un test qu'un verrou tenu par le binaire Swift 0.8.0 est vu comme tenu, et inversement
- [ ] 2.3 Ajouter le montage `NetFSMountURLSync` (souple, sans interface, codes d'erreur de B §1.1) et la capacité « importante » du volume ; vérifier le montage d'un partage SMB de test et la valeur comparée à `diskutil info`
- [ ] 2.4 Charger le module hors de l'asar (`asarUnpack`) avec un message clair en cas d'échec ; vérifier dans l'app empaquetée

## 3. Fondations du core

- [x] 3.1 Porter `CairnPaths` (`~/.cairn` en 700, `CAIRN_HOME`, `--config`), `machineName()`, les formats de date (ISO 8601 sans millisecondes) et `Fmt` (tailles décimales et durées en fr et en en) ; porter leurs tests
- [x] 3.2 Porter le TOML sans perte (`TOML.swift` : commentaires, ordre, clés inconnues, CRLF) ; porter `TOMLTests` et vérifier qu'un aller-retour sur `~/.cairn/config.toml` donne un fichier identique octet pour octet
- [x] 3.3 Porter `Config`, la validation (B §1.8), la migration v0 et `ConfigStore` (refus d'écraser un fichier invalide) ; porter `ConfigTests`, `ConfigWarningTests` et les tests de régression liés
- [x] 3.4 Convertir les `.strings`/`.stringsdict` en `locales/{en,fr}.json` par script, écrire `t()` avec `Intl.PluralRules` et le choix de langue (B §1.9) ; porter les tests de complétude et de spécificateurs
- [x] 3.5 Porter `OperationLock` et `ActivityLog` sur le module natif ; vérifier le test de régression 85501aa (8 processus × 20 ajouts = 160 événements)
- [x] 3.6 Écrire le lanceur de processus (tableaux d'arguments, stdin et stdout en flux, 20 dernières lignes de stderr gardées, kill seulement d'un processus lancé, PATH élargi de B §1.2) ; tester les cas de 46a9475

## 4. Analyse du disque et alertes

- [ ] 4.1 Porter le classement régénérable (`Scanner.alwaysRegenerable` + `BackupExclusions`, une seule source pour les deux) ; porter les tests de classement
- [ ] 4.2 Porter le parcours en lecture seule (blocs alloués, un seul comptage par lien physique entre dossiers, points de montage non franchis, workers, annulation en moins de 2 s) ; vérifier que `cairn analyze` donne les mêmes totaux que la 0.8.0, à 1 % près de `du -sk`
- [ ] 4.3 Porter gros objets, projets, résumé persistant et suppression (corbeille par défaut) ; porter les tests
- [ ] 4.4 Porter les alertes disque (seuils, prévision, anti-harcèlement, relevé aussi après une sauvegarde) ; porter `StorageAlertsTests`

## 5. Maintenance git

- [ ] 5.1 Porter découverte, branche principale, branches « gone », `mergeStatus` (avec le pipe patch-id en flux) et worktrees ; porter les tests et les régressions 01538a8, 46a9475 et StorageWarningTests
- [ ] 5.2 Écrire le pool de `worker_threads` (4, 300 s, 1,5 Go, rapports au fil de l'eau) ; vérifier les régressions 8171ca8, b23d23f et a7d22bf (sauvegarde et analyse git simultanées qui se terminent toutes les deux)
- [ ] 5.3 Porter l'application (SHA revérifié, journal, compactage seulement sur les dépôts nettoyés, verrou `git-clean`) et le TSV ; tester `git gc` absent des dépôts non nettoyés

## 6. Inventaire des outils et outils IA

- [ ] 6.1 Porter l'inventaire (sources, statuts, exclusions, export `tools.toml` + `Brewfile`) ; porter les tests et comparer `cairn tools --json` avec la 0.8.0
- [ ] 6.2 Porter les profils IA (fichiers JSON copiés tels quels), catégories, `meta/profile.json` et outils ouverts ; porter les tests
- [ ] 6.3 Porter le snapshot SQLite (`sqlite3 .backup`, 5 essais, repli `immutable` si `isCleanWAL`, `quick_check`) ; vérifier les régressions 8d202b6 et 65c88bb
- [ ] 6.4 Retirer les identifiants hors destination chiffrée (spec `ai-tools`) ; tester les deux scénarios de la spec

## 7. Moteur de sauvegarde

- [ ] 7.1 Porter les fournisseurs local et SMB, l'image sparsebundle (hdiutil, mot de passe sur stdin) et la joignabilité ; vérifier sur une destination de test locale et SMB
- [ ] 7.2 Porter les parties, versions, reprise, `latest`, versions partielles et manifest ; vérifier qu'une version écrite est relue par la 0.8.0 (`cairn restore --from` de la 0.8.0, en simulation)
- [ ] 7.3 Porter rsync (options exactes de P §2.1, GNU ou openrsync, copie par dossier, passe finale) et les 4 compteurs ; tester la régression 0fa14ea
- [ ] 7.4 Écrire le modèle de progression de la spec `backup` (phases par destination, compteurs visibles pendant tout le comptage, dossier n sur N, pourcentage plafonné, étapes de finalisation) ; tester chaque scénario de la spec
- [ ] 7.5 Porter la finalisation en arrière-plan (empreintes en flux, échantillon, `hdiutil verify` mensuel, compactage) et l'arrêt par destination ; tester les régressions eb1fc60, 75bde76, bfbbb61 et 593f593 (mémoire stable sur 512 Mo)
- [ ] 7.6 Porter la rétention (paliers, semaines ISO en UTC ; suppression manuelle sous verrou), l'intégrité et `damagedVersions` ; porter les tests
- [ ] 7.7 Porter la planification (`BackupSchedule.decide`, retard, alimentation) ; tester les régressions c459b58, 7cc955d et 46a9475 avec une horloge simulée
- [ ] 7.8 Porter la vérification de destination (`DestinationProbe`, liste des partages SMB, navigateur de dossiers) et la suppression de destination ; tester les régressions 156f978, 76e40ec et 0547a02
- [ ] 7.9 Porter la simulation (aucune écriture, comparaison à la version de base) ; tester les régressions e229e52 et 3692993

## 8. Restauration

- [ ] 8.1 Porter les sources (Cairn et anciennes sauvegardes), le choix de version, le plan et la copie (`.pre-restore`, droits des secrets) ; porter `RestoreTests` et `RestoreWarningTests`
- [ ] 8.2 Porter la fusion IA, la réécriture des projets Claude Code et l'attente des outils ouverts ; tester la régression 01538a8
- [ ] 8.3 Porter la réinstallation des outils (ordre de la spec `restore`, go et `~/.local/bin` en manuel, Terminal pour CLT et Homebrew, `command -v -- "$1"`) ; tester les scénarios de la spec

## 9. Ligne de commande

- [ ] 9.1 Porter les commandes, options, codes de retour, `--json` à clés triées, confirmations `[o/N]`, saisie de mot de passe sans écho et progression sur TTY (P §1) ; vérifier par un test d'or qui compare la sortie `--json` et le code de retour de chaque commande à ceux de la 0.8.0 sur un `CAIRN_HOME` d'exemple
- [ ] 9.2 Vérifier les modes simulation sur la vraie machine : `just backup-dry`, `just git-clean`, `just restore`, `just check` lancés avec le nouvel exécutable

## 10. Process principal

- [ ] 10.1 Écrire le contrat IPC typé, la validation par schéma, le store d'état poussé à l'interface et la revérification des confirmations destructives ; tester qu'un appel aux arguments invalides est refusé
- [ ] 10.2 Brancher le planificateur (tick de 60 s, réveil, montage d'un volume, réseau), `powerMonitor`, `powerSaveBlocker`, SIGSTOP/SIGCONT et l'arrêt propre à la fermeture ; tester avec Playwright Electron
- [ ] 10.3 Brancher les notifications avec leurs actions (journal, Nettoyer, Rappeler plus tard), l'ouverture à la connexion et le mode accessoire ; vérifier à la main dans l'app empaquetée
- [ ] 10.4 Porter l'updater (API GitHub, semver, SHA-256 en flux, identifiant et version, script de remplacement, refus pendant une sauvegarde) ; tester avec `CAIRN_UPDATE_URL` sur un faux flux, et la régression 0f7a1ce

## 11. Design system et galerie

- [ ] 11.1 Générer `tokens.css` (clair et sombre) depuis U §1 ; vérifier que la galerie en clair et en sombre reprend les valeurs de la 0.8.0
- [ ] 11.2 Écrire la bibliothèque `ui/` (les 43 composants de U §2, dont l'infobulle, le menu, PillPicker, TabBar, la case et l'interrupteur, le tableau, la feuille) en appliquant les règles de U §2.7 ; vérifier chaque composant dans la galerie
- [ ] 11.3 Écrire l'API d'exemple (`fixtures/`, états scénarisés), `bun run dev:web` et `bun run shots` ; vérifier qu'une capture par écran, par état et par thème est produite sans accès au disque
- [ ] 11.4 Porter `--gallery` et `--gallery-export <dir>` (spec `interface-design`) ; vérifier que l'export n'écrit que dans le dossier demandé
- [ ] 11.5 Écrire `desktop/DESIGN.md` (jetons, composants, règles, vocabulaire) à jour avec le code

## 12. Écrans

Chaque tâche est vérifiée par ses captures en clair et en sombre (11.3), ses tests Playwright et la correction des problèmes de U §4 qui la concernent.

- [ ] 12.1 Cadre de l'app : barre du haut compacte, rail, sidebar, indicateur d'état, navigation (lien « Ajouter une destination » corrigé)
- [ ] 12.2 Accueil (hub) : cartes de module, problèmes par priorité, « Tout vérifier », activité, mini-graphique sur 7 jours
- [ ] 12.3 Analyse : 4 onglets, explorateur, nettoyable avec présélection, gros objets, projets, suppression confirmée
- [ ] 12.4 Sauvegardes : destinations, historique, rétention, actions désactivées avec leur raison ; progression conforme à la spec `backup`, sur l'API d'exemple à deux destinations
- [ ] 12.5 Formulaire et feuilles de destination : ajout vérifié, SMB avec l'hôte seul, navigateur de dossiers, modification, suppression
- [ ] 12.6 Git : rapports au fil de l'eau, menus de ligne, confirmations, dépôts à risque
- [ ] 12.7 Outils IA et outils CLI : catégories, identifiants désactivés avec leur raison, statuts, exclusions, export
- [ ] 12.8 Restauration : choix de la source et de la version, plan, simulation, application, réinstallation des outils
- [ ] 12.9 Réglages, assistant de premier lancement (rien n'est écrit avant « Terminer ») et mise à jour
- [ ] 12.10 Barre des menus : Tray avec icône par état, panneau, actions rapides sans suppression directe
- [ ] 12.11 Vérifier qu'aucun texte n'est en dur et qu'aucun jargon de la spec `interface-design` n'apparaît, par un test sur les catalogues et les sources

## 13. Packaging, CI et release

- [ ] 13.1 Configurer electron-builder (fuses fermées, `afterPack` ad hoc, `minimumSystemVersion 14.0`, Info.plist en/fr) et produire le zip avec `ditto` (`Cairn.app` à la racine) et son `.sha256` ; vérifier que la fuse RunAsNode est fermée (scénario « Exécutable détourné »)
- [ ] 13.2 Adapter `smoke-test-app.sh` (copie hors du dépôt, version, aide en fr et en en, `ai --json`, `tools --json`, lancement de l'interface) ; le faire passer sur le zip
- [ ] 13.3 Adapter `ci.yml` (setup-bun figé, lint, `bun test`, build, test de fumée, tests de bout en bout Playwright), en gardant le job Swift jusqu'à la tâche 15 ; vérifier une CI verte sur la PR
- [ ] 13.4 Adapter `bump-version.sh`, `release-prepare.sh`, `.releaserc.json` (`package.json` comme source de version) et le pied de la note de release (lien `cairn`, quarantaine, autorisations) ; vérifier avec `semantic-release --dry-run`
- [ ] 13.5 Vérifier que l'app 0.8.0 installe le zip construit par un faux flux `CAIRN_UPDATE_URL`, puis relance la nouvelle app avec la configuration existante (spec `app-packaging`)

## 14. Validation de bout en bout sur la vraie machine

- [ ] 14.1 Lancer une sauvegarde réelle complète vers la destination locale et la destination SMB ; vérifier chaque phase à l'écran, une nouvelle version `latest` et un journal sans erreur
- [ ] 14.2 Lancer `cairn verify --full` puis `cairn restore` en simulation sur cette version ; vérifier le code 0 et le plan attendu
- [ ] 14.3 Vérifier que la 0.8.0 relit `~/.cairn` et la nouvelle version (scénario « Retour à la version précédente »)
- [ ] 14.4 Lancer `/opsx:verify` sur ce changement et cocher toute la liste de parité (B §1 à §4, U §3 et §4)

## 15. Bascule

- [ ] 15.1 Retirer `Cairn/` (sources, tests, scripts Swift), le job Swift de la CI et les recettes `just` Swift, en faisant pointer `just test`, `just storage-install`, `just gallery` et les autres sur `desktop/` ; vérifier `just test` et `just storage-install`
- [ ] 15.2 Mettre à jour `README.md`, `README.fr.md`, `AGENTS.md` (section « App Cairn ») et les liens vers `Cairn/README.md` et `DESIGN.md` ; vérifier qu'aucun lien n'est mort

## Workflow follow-up

- Archiver les changements livrés mais non archivés (`app-updates`, `component-gallery`, `edit-and-delete-destination`, `git-row-actions`, `home-hub`) avant celui-ci, pour que leurs deltas soient dans `openspec/specs/`.
- Archiver ce changement après la revue et le merge.
