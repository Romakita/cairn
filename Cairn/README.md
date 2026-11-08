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

## Inventaire des outils CLI

`cairn tools` (et la section « Outils CLI » de l'app) liste les outils installés par Homebrew (formules et taps),
mise, npm global, uv, pipx, cargo, go et `~/.local/bin`. Les applications (casks, `/Applications`, Mac App Store) ne
sont jamais inventoriées. Les liens de `~/.local/bin` vers un environnement uv ou pipx sont rattachés à leur source.

Chaque outil est marqué :

- **utilisé** s'il a une configuration dans le home, s'il est requis par un fichier de projet dans un dossier suivi,
  ou s'il apparaît au moins 3 fois dans l'historique zsh/bash ;
- **non utilisé** sinon (à décocher si besoin : le choix est gardé dans `[tools].excluded`) ;
- **requis manquant** quand une configuration ou un projet le demande mais qu'il n'est pas installé.

`cairn tools --export DOSSIER` écrit `tools.toml` (outils retenus, par source, avec version, extras et version de
Python) et un `Brewfile` compatible `brew bundle` (taps et formules, jamais de `cask` ni de `mas`).

### Ajouter une règle

Les règles sont dans `Sources/CairnCore/Resources/rules/rules.json` :

- `home` : chemin relatif à `~` → commandes (ex. `".kube": ["kubectl"]`) ;
- `projects` : nom de fichier dans un dossier suivi → commandes (ex. `"go.mod": ["go"]`) ;
- `aliases` : nom de paquet → commandes fournies (ex. `"ripgrep": ["rg"]`) ;
- `history_min_uses` : nombre d'utilisations dans l'historique pour compter comme « utilisé ».

Aucune recompilation de la logique n'est nécessaire ; `just test Inventory` vérifie que le fichier se charge.

## Sauvegarde : écarts voulus avec scripts/backup.sh

Comparaison des exclusions sur `/Volumes/workspaces` (8 nov. 2026) : 587 dossiers générés exclus en commun.

- Le script liste en plus 38 dossiers situés dans `bower_components/` ou `.next/`, déjà exclus en entier des deux côtés.
- Cairn exclut en plus les types régénérables de l'analyse : `.build` de SwiftPM, `Carthage`, `.expo`, `storybook-static`,
  `venv`, `.tox`, `.sass-cache`, `.eslintcache`.
- `.gradle` n'est exclu qu'à côté d'un projet Gradle (le script l'excluait partout).
- Le home n'est plus « tout sauf une liste » : seuls les éléments choisis (`[home].include`) sont copiés.
- Les applications (casks) ne sont plus inventoriées.

Maintenance git : sur 381 branches « gone », 374 ont le même statut que `git-cleanup.sh`. Les 7 autres sont des squash
merges que le script classait « non fusionnée » à cause de `set -o pipefail` combiné à `grep -q` (interruption du
pipeline dès la première correspondance) ; vérifié à la main sur `clubmed/digital-api`.

## Barre des menus et alertes de disque plein

Avec l'accord pour la tâche de fond, Cairn place une icône dans la barre des menus (état : normal, sauvegarde en
cours, attention). Son panneau montre la jauge de chaque volume suivi, l'espace récupérable (régénérable, worktrees
obsolètes, corbeille du volume), l'état des sauvegardes et les alertes, avec « Nettoyer » (ouvre l'écran Nettoyable,
rien n'est supprimé sans confirmation) et « Sauvegarder maintenant ». Les chiffres viennent de la dernière analyse
(`~/.cairn/state/analysis-summary.json`) : ouvrir le panneau ne relance aucune analyse.

L'espace libre est relevé toutes les 15 minutes et après chaque opération (`state/volumes.json`, 30 jours). Alertes :

| Niveau | Défaut (`[alerts]`) |
|---|---|
| presque plein | moins de 10 % ou de 20 Go libres (`low_percent`, `low_gb`) |
| critique | moins de 5 % ou de 5 Go (`critical_percent`, `critical_gb`) |
| anticipée | plein dans moins de 7 jours au rythme des 7 derniers jours (au moins 3 jours d'historique) |

Une notification par volume et par jour au plus, sauf passage au niveau critique ; un volume revenu 2 points au-dessus
du seuil remet le compteur à zéro ; « Ignorer 7 jours » met le volume en sourdine. Si les notifications sont refusées,
les alertes restent visibles dans le panneau et sur l'accueil.

## Outils IA

`cairn ai` (et la section « Outils IA ») liste Claude Code, Claude Desktop et Codex avec leur taille par catégorie.
Chaque outil est décrit par un profil JSON dans `Sources/CairnCore/Resources/ai-tools/<id>.json` :

| Clé | Rôle |
|---|---|
| `root` | racine des données (`~`, `~/.codex`…) ; les chemins des catégories sont relatifs à elle |
| `detect` | chemins relatifs au home qui signalent l'outil |
| `categories` | `conversations`, `config`, `memories`, `credentials` → dossiers (`x/`), fichiers ou motifs (`thread_*.sqlite`) |
| `sqlite` | bases copiées par snapshot cohérent (API de sauvegarde SQLite, jamais de `-wal`/`-shm`) |
| `exclude` | jamais copiés (caches, journaux, temporaires) |
| `reinstall` | jamais copiés, seulement listés pour être réinstallés (plugins, paquets) |
| `credentials_in_keychain` | jeton dans le Trousseau : reconnexion nécessaire après restauration |
| `conversations_glob` | motif pour compter les conversations |

Ajouter un outil = ajouter un profil (aucun changement du moteur). Dans une version : `ai/<outil>/<catégorie>/…` et
`ai/<outil>/meta/` (profil, liste à réinstaller, snapshots SQLite). Les dossiers des outils IA sont toujours exclus de la
sélection du home. Les identifiants ne sont cochés par défaut que si toutes les destinations sont chiffrées.

À la restauration, les conversations sont fusionnées fichier par fichier : la version la plus récente gagne, l'autre est
gardée avec le suffixe `.pre-restore`. Les bases SQLite ne sont remplacées qu'avec confirmation. Si un dossier suivi
change de place, les dossiers de projets de Claude Code (`~/.claude/projects/-Volumes-workspaces-…`) sont renommés ; les
chemins internes aux bases de Codex ne sont pas réécrits.

## Restauration

`cairn restore` (et la section « Restauration ») reconnaît une version Cairn (`manifest.json`) ou une sauvegarde faite par
`scripts/backup.sh` (`manifest/system.txt`, `home/`, `workspaces/`, `ai/`). Simulation par défaut ; `--apply` écrit.

```bash
cairn restore --check                                   # outils de l'inventaire présents / manquants, rien n'est modifié
cairn restore --destination nas                         # simulation de la dernière version de ce Mac
cairn restore --from /Volumes/Disque/mac-backup --parts home,ai --apply
cairn restore --target workspaces=~/workspaces --apply  # restaurer un dossier ailleurs (chemins Claude Code réécrits)
```

Les fichiers remplacés sont gardés avec le suffixe `.pre-restore` ; `~/.ssh` est remis en 700 et les clés privées et
fichiers d'authentification en 600. Les outils sont réinstallés dans l'ordre Homebrew, mise, npm, uv, pipx, cargo ; ceux
déjà présents sont ignorés et un échec n'arrête pas la suite. L'installation de Homebrew s'ouvre dans Terminal : Cairn ne
demande jamais le mot de passe administrateur.
