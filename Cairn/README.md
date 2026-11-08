# Cairn

App macOS (SwiftUI, SwiftPM, Command Line Tools suffisantes) et commande `cairn` : analyse du stockage,
sauvegardes, outils IA, inventaire des CLI, maintenance git et restauration.
Le plan complet est dans `openspec/changes/cairn-integration-scripts/`.

## Construire et tester

```bash
just test              # tests (exécutable cairn-selftest)
just storage-install   # construit Cairn.app et l'installe dans ~/Applications
```

Structure : `Sources/CairnCore` (logique, sans SwiftUI), `Sources/Cairn` (interface + aiguillage ligne de commande),
`Tests/CairnSelfTest` (tests). Textes : `Sources/CairnCore/Resources/{en,fr}.lproj/Localizable.strings`.

## Ligne de commande

```bash
cairn --help
cairn analyze [dossier…] --json   # par défaut : dossiers suivis de config.toml
cairn config path | show | validate
```

Options globales : `--config <fichier>` (autre fichier de configuration), `--lang en-US|fr-FR`.
Codes de sortie : 0 succès, 1 échec, 2 erreur d'usage ou de configuration.

## Configuration : `~/.cairn/config.toml`

Créée par l'assistant au premier lancement, modifiable à la main (l'app la recharge) ou depuis les réglages,
qui conservent les commentaires et les clés inconnues. Exemple complet et commenté : [`config.example.toml`](config.example.toml).

| Table | Clés | Défaut |
|---|---|---|
| (racine) | `version`, `language` (`auto`, `en-US`, `fr-FR`) | `1`, `auto` |
| `[analysis]` | `big_file_threshold_mb`, `big_folder_threshold_gb` | `50`, `1.0` |
| `[[folders]]` | `path`, `backup`, `exclude` | —, `true`, `[]` |
| `[home]` | `include`, `exclude` (chemins relatifs à `~`) | `[]` |
| `[ai.<outil>]` | `categories` : `conversations`, `config`, `memories`, `credentials` | — |
| `[[destinations]]` | `id`, `provider` (`local` : `path` ; `smb` : `url`, `username`), `keychain`, `encrypted`, `retention` | `encrypted = true`, `retention = { mode = "tiered", days = 30, weeks = 48 }` |
| `[schedule]` | `frequency` (`daily`, `weekly`, `manual`), `time`, `weekday`, `background`, `on_battery_min_percent` | `daily`, `12:30`, `monday`, `false`, `20` |
| `[alerts]` | `low_percent`, `low_gb`, `critical_percent`, `critical_gb` | `10`, `20`, `5`, `5` |
| `[logs]` | `retention_days` | `90` |
| `[git]` | `fetch_before`, `gc`, `worktree_stale_days` | `false`, `true`, `30` |
| `[tools]` | `excluded` | `[]` |

Règles :

- Les mots de passe sont dans le Trousseau macOS (services `fr.lenzotti.cairn.*`), jamais dans le fichier.
- Un fichier d'une version antérieure est migré automatiquement ; l'original est gardé en `config.toml.bak`.
- Erreur de syntaxe ou de valeur : l'app affiche la clé et la ligne, garde la dernière configuration valide et
  suspend les sauvegardes planifiées. Un dossier suivi absent (volume démonté) est seulement signalé.
- `cairn config validate` vérifie le fichier sans lancer l'app.

Les journaux sont dans `~/.cairn/logs/` ; ceux de plus de `logs.retention_days` jours sont supprimés, sauf ceux
des versions de sauvegarde encore gardées.
