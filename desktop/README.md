# Cairn (Electron)

App de bureau et commande `cairn` en Electron + TypeScript (changement OpenSpec `migrate-to-electron`). Bun 1.4.4
sert à l'outillage (paquets, build, tests) ; l'app tourne sur le Node d'Electron. Les Command Line Tools suffisent
(compilation du module natif `native/`) : Xcode n'est pas nécessaire. Jusqu'à la 0.8.0, Cairn était une app Swift
(tag `v0.8.0`, dossier `Cairn/`).

```bash
bun install            # dépendances + binaire Electron
bun run build:native   # module natif (Trousseau, montage SMB, flock) ; sans lui, ses tests sont sautés
bun run start          # app en développement
bun run cli --help     # même exécutable en ligne de commande : bun run cli <commande> [options]
bun test               # core et CLI
bun run test:e2e       # vraie app Electron (Playwright)
bun run lint           # Biome + règles du design system
bun run typecheck
bun run dist           # release/Cairn-<version>-arm64.zip (+ .sha256)
```

Depuis la racine du dépôt, les mêmes commandes passent par `just` : `just test [filtre]`, `just e2e`, `just lint`,
`just dev`, `just dev-web`, `just storage-install`, `just release-build`.

Référence utilisateur (commande `cairn`, clés de configuration, règles d'inventaire, profils IA, alertes) :
[docs/reference.md](../docs/reference.md). Design system de l'interface : [DESIGN.md](DESIGN.md).

## Organisation

| Dossier | Rôle |
|---|---|
| `src/core/` | Logique métier, portée depuis la 0.8.0 (Swift). API `node:*` seulement |
| `src/cli/` | Commandes `cairn`, au-dessus du core |
| `src/main/` | Process principal Electron : fenêtres, Tray, IPC, planificateur, notifications, mises à jour |
| `src/preload/` | API typée exposée à l'interface |
| `src/renderer/` | Interface React : `ui/` (composants), `screens/`, `gallery/`, `styles/tokens.css` |
| `src/shared/` | Contrat entre le main et l'interface (`contract.ts`) |
| `native/` | Module N-API (Objective-C) : Trousseau, montage SMB, `flock`, espace libre APFS |
| `resources/` | Profils IA, règles d'inventaire, icônes de la barre des menus, `config.example.toml` |
| `locales/` | Traductions `en.json` et `fr.json` (catalogues de la 0.8.0) et `areas/<zone>.json` (textes des écrans) |
| `test/core/`, `test/regressions/` | `bun test` : une suite par domaine ; un test par bug corrigé, nommé par son commit |
| `test/e2e/` | Playwright sur la vraie app (`*.e2e.ts`) |
| `scripts/` | Build, empaquetage, installation, captures, `semantic-release/` (notes, version, archive) |

## Règles du core (`src/core`, `src/cli`)

- **Node seulement** : `node:fs`, `node:child_process`… Jamais `Bun.*` ni `bun:*` (le lint l'interdit) : les tests
  tournent sous Bun, mais l'app sous Node.
- **`fs` via `src/core/fs.ts` / `src/core/fs-promises.ts`**, jamais `node:fs` directement (le lint l'interdit dans
  `src/core`, `src/cli` et `src/main`) : sous Electron, `node:fs` est patché pour l'asar et voit un fichier `*.asar`
  de l'utilisateur comme un dossier (EISDIR, taille 0) ; ces modules donnent `original-fs` sous Electron, `node:fs`
  ailleurs. Le worker de l'analyse (code en chaîne) fait le même choix. Test : `test/regressions/electron-fs.test.ts`.
- **Pas de `__dirname` ni de `import.meta.dir`** : le bundler les fige au chemin des sources. Les ressources sont des
  imports JSON statiques ; les chemins d'exécution viennent de `CairnPaths` ou sont passés en paramètre.
- **Aucun appel synchrone bloquant** (`execSync`, `spawnSync`, `readFileSync` sur un gros fichier) dans du code que le
  main appelle : tout passe par `child_process.spawn` en flux et `fs/promises`. Exception : lecture d'un petit fichier
  de configuration au démarrage.
- **Processus externes** : chemin absolu (`/usr/bin/git`, `/usr/bin/hdiutil`…), tableau d'arguments, jamais de shell.
  Les mots de passe passent sur stdin, jamais en argument.
- **Formats compatibles avec la 0.8.0** : dates d'état en ISO 8601 **sans millisecondes** (`isoDate()`), JSON de CLI
  indenté à 2 espaces avec les clés triées (`stableJSON()`), noms et chemins de sauvegarde identiques.
- **Lecture seule** pour l'analyse ; toute suppression passe par une confirmation, la corbeille par défaut, un mode
  simulation.
- **Textes visibles** : `t("clé", …)` uniquement, avec la clé dans `locales/en.json` ET `locales/fr.json`.
- **Tests** : `bun:test`, une suite par fichier (`describe` au nom du domaine), dans `test/core/<domaine>.test.ts`.
  `test/setup.ts` donne à chaque process de test un `CAIRN_HOME` temporaire. Les cas viennent des tests Swift de la
  0.8.0 (mêmes noms, mêmes attentes).

## Catalogue des composants

Chaque composant de `src/renderer/ui/` a ses « stories » (variantes nommées, données factices) dans
`src/renderer/gallery/stories/`.

```bash
just dev-web                    # interface dans le navigateur avec l'API d'exemple ; galerie : /#/gallery
just gallery                    # fenêtre Electron du catalogue (cairn --gallery)
just gallery-export [dossier]   # PNG par story et par thème + index.html (défaut : build/gallery)
just shots                      # captures de la galerie, en clair et en sombre (desktop/shots)
```

Le catalogue ne lit ni n'écrit rien dans le home ; l'export n'écrit que dans le dossier demandé
(`test/e2e/gallery.e2e.ts`).

## Références de parité

`openspec/changes/migrate-to-electron/parity/` : `behavior.md` (règles et régressions), `ui.md` (design system et
écrans), `platform.md` (CLI, processus, API macOS, build). Le code Swift de référence est au tag `v0.8.0`
(`git show v0.8.0:Cairn/Sources/CairnCore/<Fichier>.swift`).
