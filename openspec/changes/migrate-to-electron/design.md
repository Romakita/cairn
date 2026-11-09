# Design

## Context

Voir `proposal.md` pour le pourquoi. Trois inventaires de la 0.8.0 servent de référence de parité et sont cités par les tâches :

- `parity/behavior.md` :
  - les règles métier par domaine (§1) ;
  - une trentaine de bugs corrigés, à verrouiller par un test (§2) ;
  - les algorithmes et formats à reproduire à l'identique (§3) ;
  - les invariants de sécurité (§4).
- `parity/ui.md` :
  - les jetons exacts du design system, en clair et en sombre (§1) ;
  - les 43 composants de la galerie (§2) ;
  - chaque écran et ses états (§3) ;
  - 25 problèmes d'interface à corriger (§4) ;
  - 934 clés de traduction (§5).
- `parity/platform.md` :
  - la surface CLI (§1) ;
  - les processus externes et les API macOS, avec leurs équivalents (§2) ;
  - la planification, les notifications, la barre des menus et les mises à jour (§3) ;
  - la chaîne de build et de release (§4) ;
  - la sécurité Electron (§5).

Contraintes :
- Electron exécute le code sur Node ; Bun ne sert qu'à l'outillage.
- Il n'y a pas de compte Apple Developer : signature ad hoc, sans notarisation.
- L'app Swift 0.8.x doit pouvoir installer la première version Electron.
- `~/.cairn` et le Trousseau doivent rester relisibles dans les deux sens.

## Goals / Non-Goals

**Goals :**
- Parité fonctionnelle avec la 0.8.0. Chaque ligne de `parity/behavior.md` §2 a son test.
- Une interface entièrement construite sur une bibliothèque de composants à jetons, que l'agent peut vérifier seul : données d'exemple, Playwright, captures en clair et en sombre.
- Un seul exécutable pour l'app et la CLI.

**Non-Goals :**
- Pas de nouvelle fonctionnalité métier. Les sauvegardes app fermée (LaunchAgent), Windows et Linux, et la notarisation restent hors périmètre.
- Pas de changement de format des données (`config.toml`, état, sauvegardes, Trousseau).
- Pas de build Intel publié, comme aujourd'hui. La configuration le permet, mais il n'est pas publié.

## Decisions

### 1. Structure : `desktop/`, avec un core sans Electron

Le dossier `desktop/` contient :
- `package.json`, `bunfig.toml` (`linker = "hoisted"`) et `electron-builder.yml` ;
- `src/core/` : la logique métier, portée depuis `CairnCore`. Uniquement des API `node:*`, aucun import d'`electron`, de React ou de `Bun`/`bun:*`. Une règle de lint l'impose ;
- `src/cli/` : les commandes, au-dessus du core ;
- `src/main/` : le process principal Electron (fenêtres, Tray, IPC, planificateur, notifications, mises à jour) ;
- `src/preload/` : l'API typée exposée à l'interface ;
- `src/renderer/` : React, avec `ui/` pour la bibliothèque de composants, `screens/` pour les écrans et `gallery/` ;
- `native/` : le module N-API ;
- `test/` : les tests unitaires, d'intégration et de bout en bout.

Le nom `desktop/`, plutôt que `cairn/`, évite un conflit avec `Cairn/` sur APFS, qui ne distingue pas les majuscules.

*Alternative écartée :* un monorepo à plusieurs paquets. Ce serait plus de configuration pour un seul produit.

### 2. Bun pour l'outillage, Node pour l'exécution

- `bun install`, `bun build` (main et preload en CJS avec `electron` en `--external`, renderer pour le navigateur) et `bun test` pour le core et la CLI.
- Les tests de bout en bout lancent la vraie app avec Playwright (`_electron.launch`). Ils exercent donc le core sous le Node d'Electron, ce qui couvre l'écart entre Bun et Node.

*Alternative écartée :* Electrobun. Il est trop jeune pour une app qui touche au home et aux secrets.

### 3. Un seul exécutable : le main aiguille vers la CLI

Avant `app.whenReady`, `main.ts` reprend la règle `isCommandLine(argv)` de `main.swift`. En mode CLI :
- `app.dock.hide()`, pas de verrou d'instance unique, logs Chromium coupés ;
- exécution de `src/cli`, puis `app.exit(code)` après la vidange de stdout.

Les liens `~/.local/bin/cairn` existants continuent ainsi de fonctionner.

*Alternatives écartées :*
- `ELECTRON_RUN_AS_NODE` : exige la fuse RunAsNode ouverte, ce qui fait du binaire un interpréteur Node avec les droits de l'app.
- Un binaire `bun --compile` séparé : un deuxième runtime, et le module natif plus difficile à charger. C'est à revoir seulement si le démarrage (environ 0,5 s) gêne.

### 4. Un module natif N-API pour ce que Node ne sait pas faire

`native/` est écrit en Objective-C et compilé par `node-gyp` avec les Command Line Tools, sans Xcode. Il est chargé par le main et la CLI, jamais par l'interface, et déballé hors de l'asar (`asarUnpack`). Il expose :
- le Trousseau : mot de passe générique `fr.lenzotti.cairn.image.<id>` avec la machine comme compte, et mot de passe Internet SMB partagé avec le Finder (lecture, écriture, mise à jour, sans suppression) ;
- `NetFSMountURLSync`, en montage souple et sans interface ;
- `flock` exclusif non bloquant et bloquant, compatible avec la version Swift sur `state/operation.lock` et `state/activity.lock` ;
- la capacité « importante » du volume, qui inclut l'espace purgeable d'APFS.

*Alternative écartée :* passer par `security`, `osascript mount volume` et un fichier pid. Le mot de passe passerait par d'autres processus, l'ACL du Trousseau changerait, et le verrou ne serait plus atomique.

### 5. Le parallélisme passe par des worker_threads

- Le pool git (4 workers, délai de 300 s, 1,5 Go) devient un pool de `worker_threads`. Chaque worker a `resourceLimits.maxOldGenerationSizeMb = 1536` et est arrêté par `terminate()` au délai dépassé.
- L'analyse du disque et les 4 compteurs de fichiers de la sauvegarde utilisent aussi des workers ou des processus enfants asynchrones.
- Aucune attente synchrone dans le process principal, pour éviter le gel corrigé en a7d22bf.
- La commande interne `git-worker` disparaît : elle n'est pas documentée pour l'utilisateur.

*Alternative écartée :* relancer l'exécutable Electron par dépôt. Avec environ 0,4 s de démarrage par dépôt, l'analyse de 79 dépôts prendrait nettement plus de temps.

### 6. Les opérations vivent dans le main, l'interface reçoit l'état

- Le main possède un état unique : configuration, destinations, progression, analyses, etc.
- Il pousse des instantanés typés à l'interface (`ipc-contract.ts`).
- L'interface n'appelle que des fonctions métier (`startBackup`, `trash(nodeIds)`…). Chaque argument est validé par un schéma dans le main.
- Les suppressions désignent des éléments du dernier état connu du main, pas des chemins libres.
- Les confirmations destructives sont revérifiées dans le main.
- Sécurité de la fenêtre :
  - `sandbox` et `contextIsolation` activés ;
  - CSP stricte, protocole `app://`, navigation bloquée ;
  - `openExternal` limité à une liste blanche.
- Les mots de passe vont de l'interface au main une seule fois et ne reviennent jamais.

### 7. L'interface : React et les jetons CSS de la palette actuelle

- React 19, des CSS modules, et des jetons en variables CSS générés depuis `parity/ui.md` §1 (thème par `prefers-color-scheme`).
- Les icônes viennent de Lucide (même jeu, trait de 1,6) ; la police est la police système.
- La bibliothèque `ui/` couvre les 43 composants. Il n'y a ni `<select>`, ni `<input type=checkbox>` visible, ni `title` natif : l'infobulle est un composant.
- Un lint refuse les couleurs littérales hors `tokens.css` et les éléments HTML natifs interdits hors `ui/`.
- Les références visuelles sont la palette et les règles actuelles (`DESIGN.md`, `tasks/lessons.md`), mises à jour dans `desktop/DESIGN.md`.

### 8. Vérification visuelle : l'interface tourne aussi dans un navigateur

- `src/renderer` reçoit son API par injection. Le preload fournit la vraie ; `fixtures/` fournit une API d'exemple avec des états scénarisés (vide, chargement, sauvegarde en 4 phases, erreur, deux destinations).
- `bun run dev:web` sert l'interface avec ces données. L'agent l'ouvre dans le navigateur intégré ou avec Playwright.
- `bun run shots` produit une capture par écran, par état et par thème. La galerie (`--gallery`, `--gallery-export <dir>`) suit le même principe.

### 9. Le core est porté à l'identique, test par test

- Le TOML est porté depuis `TOML.swift` : réécriture sans perte (commentaires, ordre, clés inconnues, CRLF). Aucune bibliothèque existante ne le fait de façon fiable.
- Rsync, hdiutil, smbutil et git gardent leurs arguments exacts (`parity/platform.md` §2.1).
- SQLite passe par `/usr/bin/sqlite3 .backup` et `quick_check`, avec le repli `immutable` (§3 de behavior), identique sous Bun et sous Node.
- Les dates d'état sont en ISO 8601 sans millisecondes, et le JSON de la CLI est indenté avec des clés triées.
- `machineName()` = `scutil --get ComputerName`, avec la même expression régulière.
- Chaque fichier de `Cairn/Tests/CairnTests` a son équivalent sous `test/core/`. Le tableau de `parity/behavior.md` §2 devient `test/regressions/*.test.ts`, un test nommé par commit.

### 10. Les traductions sont converties une fois

- Un script convertit les `.strings` et `.stringsdict` en `locales/{en,fr}.json`, en gardant les clés et les spécificateurs (`%1$@` devient `{1}`, le pluriel passe par `Intl.PluralRules`).
- Les tests existants sont portés : mêmes clés dans les deux langues, mêmes paramètres, aucun texte JSX en dur.
- La CLI et l'app partagent `t()`.

### 11. Packaging et mises à jour

- electron-builder avec `appId fr.lenzotti.cairn`, la cible `zip` et `minimumSystemVersion 14.0`.
- Les fuses sont fermées : RunAsNode, NODE_OPTIONS et `--inspect` désactivés, intégrité de l'asar activée.
- La signature ad hoc se fait dans `afterPack` (`codesign --force --deep --sign -`), après l'écriture des fuses.
- Le zip final est produit par `ditto -c -k --keepParent`, pour garder `Cairn.app` à la racine, nommé `Cairn-<v>-arm64.zip`, avec son `.sha256`.
- L'updater maison est porté tel quel : API GitHub, semver, SHA-256 en flux, contrôle de l'identifiant et de la version, puis le même script de remplacement. electron-updater est impossible sans Developer ID.
- `package.json` devient la source de version ; `bump-version.sh` met à jour `package.json` et `Cairn/VERSION`.
- La CI tourne sur macos-15 avec `oven-sh/setup-bun` (version figée), `bun test`, le build, `smoke-test-app.sh` adapté et les tests de bout en bout Playwright.

### 12. Les écarts entre specs et code sont tranchés

| Écart (`parity/behavior.md`) | Décision |
|---|---|
| Identifiants IA vers une destination non chiffrée | Retirés de la sauvegarde et case désactivée avec la raison. La spec `ai-tools` est alignée sur le code. |
| go et `~/.local/bin` non réinstallés | Gardés comme réinstallations manuelles. La spec `restore` est alignée. |
| `git gc` sur tous les dépôts analysés | Corrigé : seulement sur les dépôts nettoyés, comme le dit la spec `git-maintenance`. |
| Suppression des versions en trop sans verrou | Corrigé : elle prend le verrou d'opération. |
| SMB toujours dans une image, même sans chiffrement | Gardé, car nécessaire pour les liens physiques et les droits. La spec `backup` n'est pas changée : l'image est un détail du fournisseur. |
| Alerte disque non relancée après une sauvegarde | Ajouté : le relevé se fait aussi à la fin d'une sauvegarde. |
| Mini-graphique `backupDays` absent | Ajouté : 7 jours sur la carte de l'accueil. |

## Risks / Trade-offs

- [La signature ad hoc change à chaque version, et macOS peut redemander l'accès au Trousseau ou retirer l'Accès complet au disque] → Pour les mots de passe Internet, réutiliser l'ACL du Finder. Expliquer la nouvelle autorisation dans la note de release et dans l'app, au premier refus d'accès. Plus tard, envisager un certificat auto-signé stable, dans un changement séparé.
- [Le code passe les tests sous Bun mais casse sous Node] → Lint interdisant `Bun`/`bun:*` dans `core/` ; tests de bout en bout Electron en CI sur les parcours sauvegarde, restauration et git.
- [Un module natif mal compilé empêche l'app de démarrer] → Test de fumée de l'app empaquetée hors du dépôt, et chargement du module vérifié au démarrage avec un message clair.
- [Le zip passe d'environ 5 Mo à environ 110 Mo] → Accepté. Le téléchargement est en flux, et le SHA-256 est calculé en flux.
- [La parité est incomplète au moment de supprimer `Cairn/`] → La suppression est la dernière tâche, conditionnée à la liste de parité entièrement cochée et au backup réel de bout en bout réussi.
- [Coexistence pendant le développement] → Le verrou `flock` est compatible, et les formats sont identiques. L'app Swift et la CLI TypeScript peuvent tourner sur la même machine sans risque d'écriture concurrente.

## Migration Plan

1. Développer dans `desktop/` sur `feat/electron-app`, à côté de `Cairn/`. La CI teste les deux tant que les deux existent.
2. Avant le passage, valider sur la vraie machine :
   - `cairn backup --dry-run`, puis un backup réel complet (local et SMB) ;
   - `cairn verify`, puis une restauration en simulation ;
   - un nettoyage git en simulation ;
   - une comparaison de `cairn analyze --json` avec la 0.8.0 et avec `du -sk`.
3. Retirer `Cairn/` et basculer le `justfile`, la CI et la release. La release sera un `feat` (0.9.0) : pas de rupture côté utilisateur.
4. Retour arrière : réinstaller la 0.8.0 depuis GitHub Releases. Les données restent compatibles (spec `app-packaging`, « Retour à la version précédente »).

## Open Questions

- Captures de Codex : il n'y en a aucune dans le repo. La palette actuelle sert de référence. Si l'utilisateur fournit des captures, on ajustera les jetons sans toucher aux composants.
- Build Intel : le publier ou non. C'est une simple ligne dans la configuration de la release.
