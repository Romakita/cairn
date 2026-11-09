# Cairn (Electron)

Réécriture de Cairn en Electron + TypeScript (changement OpenSpec `migrate-to-electron`). Bun sert à l'outillage
(paquets, build, tests). L'app tourne sur le Node d'Electron.

```bash
bun install            # dépendances + binaire Electron
bun run start          # app en développement
bun run cli -- --help  # même exécutable en ligne de commande
bun test               # core et CLI
bun run test:e2e       # vraie app Electron (Playwright)
bun run lint           # Biome + règles du design system
bun run typecheck
```

Depuis la racine du dépôt, les mêmes commandes passent par `just desktop-*`.

## Organisation

| Dossier | Rôle |
|---|---|
| `src/core/` | Logique métier, portée depuis `Cairn/Sources/CairnCore`. API `node:*` seulement |
| `src/cli/` | Commandes `cairn`, au-dessus du core |
| `src/main/` | Process principal Electron : fenêtres, Tray, IPC, planificateur, notifications, mises à jour |
| `src/preload/` | API typée exposée à l'interface |
| `src/renderer/` | Interface React : `ui/` (composants), `screens/`, `gallery/`, `styles/tokens.css` |
| `native/` | Module N-API (Objective-C) : Trousseau, montage SMB, `flock`, espace libre APFS |
| `resources/` | Profils IA et règles d'inventaire, importés statiquement (inclus dans le bundle) |
| `locales/` | Traductions `en.json` et `fr.json`, importées statiquement |
| `test/core/`, `test/regressions/` | `bun test` : une suite par domaine ; un test par bug corrigé, nommé par son commit |
| `test/e2e/` | Playwright sur la vraie app (`*.e2e.ts`) |

## Règles du core (`src/core`, `src/cli`)

- **Node seulement** : `node:fs`, `node:child_process`… Jamais `Bun.*` ni `bun:*` (le lint l'interdit) : les tests
  tournent sous Bun, mais l'app sous Node.
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
  `test/setup.ts` donne à chaque process de test un `CAIRN_HOME` temporaire. Les tests Swift de
  `Cairn/Tests/CairnTests/<Domaine>Tests.swift` sont portés un à un (mêmes cas, mêmes attentes).

## Références de parité

`openspec/changes/migrate-to-electron/parity/` : `behavior.md` (règles et régressions), `ui.md` (design system et
écrans), `platform.md` (CLI, processus, API macOS, build). Le code Swift de référence est dans `Cairn/Sources/`.
