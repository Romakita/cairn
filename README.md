# Sauvegarde et redéploiement du Mac

Les scripts sont dans `scripts/` et se lancent depuis la racine avec [just](https://github.com/casey/just) :

```bash
just            # liste les commandes
```

| Commande | Rôle |
|---|---|
| `just backup <dest>` | sauvegarde home + workspace |
| `just backup-dry <dest>` | simulation de la sauvegarde |
| `just restore <dossier-de-sauvegarde>` | redéploie la sauvegarde sur ce Mac |
| `just check <dossier-de-sauvegarde>` | vérifie seulement les outils requis |
| `just git-clean` | simulation du nettoyage des repos git |
| `just git-clean-apply` | nettoyage réel des repos git |
| `just test` | lance les tests de Cairn |
| `just storage-install` | construit et installe l'app Cairn |
| `just storage` | ouvre l'app Cairn |
| `just storage-report [dossier]` | résumé de l'occupation disque dans le terminal |

Les options des scripts passent à la suite : `just backup /Volumes/MonDisque/mac-backup --mirror`.

## Sauvegarder

Branche un disque **chiffré** (le home contient des tokens : `.zshrc`, `.ssh`, `.aws`, auth Claude/Codex).
Ferme Claude, Codex et ChatGPT, puis :

```bash
just backup /Volumes/MonDisque/mac-backup
```

Options : `--dry-run` (simulation), `--mirror` (supprime dans la sauvegarde ce qui a disparu),
`--no-home`, `--no-workspace`. Relancer la commande fait une mise à jour incrémentale.

> Lance-le depuis Terminal/Warp avec l'accès complet au disque (Réglages > Confidentialité > Accès complet au disque).
> Installer `brew install rsync` le rend plus rapide (barre de progression).

### Ce qui est sauvegardé

| Dossier       | Contenu |
|---------------|---------|
| `home/`       | `~` sauf Desktop, Documents, Downloads, Library, Movies, Music, Pictures, Public, Applications, la corbeille, les caches (`.cache`, `.npm`, bun, pnpm), les installations reconstructibles (mise, uv, pipx, modèles Ollama) et tous les `node_modules` |
| `workspaces/` | `/Volumes/workspaces` sans `node_modules`, `Pods` (CocoaPods), `DerivedData`, `.pnpm-store`, `dist`, `coverage`, `.turbo`, `.nx`, `.next`, `.nuxt`, `.angular`, `.vite`, `.cache`, `.venv`, `__pycache__`, `*.tsbuildinfo`… Les dossiers `lib/`, `build/`, `out/`, `target/`, `tmp/`, `vendor/` ne sont exclus que s'ils sont générés (ignorés par le `.gitignore` du repo, ou à côté d'un `package.json`/`Cargo.toml`/`composer.lock` hors git) |
| `ai/`         | Copies cohérentes des bases SQLite de `~/.claude` et `~/.codex` + sessions et config de Claude Desktop (seule chose prise dans Library) |
| `manifest/`   | `Brewfile`, `Brewfile.apps`, outils mise, paquets npm globaux, outils uv/pipx, modèles Ollama, `required-tools.txt` (outils requis repérés dans les projets et l'historique zsh), listes d'exclusion |

Les conversations Claude Code (`~/.claude/projects`, `~/.claude.json`) et Codex (`~/.codex/sessions`, `archived_sessions`, bases SQLite) sont dans `home/` et `ai/`.

La sauvegarde contient aussi une copie de `backup.sh`, `restore.sh` et de ce README à sa racine.

## Redéployer sur l'autre Mac

Depuis ce repo (`just restore /Volumes/MonDisque/mac-backup`) ou directement depuis le disque :

```bash
/Volumes/MonDisque/mac-backup/restore.sh
```

Le script installe ce qui manque (Xcode CLT, Homebrew, zsh, oh-my-zsh, contenu du Brewfile, mise et ses outils,
paquets npm globaux, uv/pipx, modèles Ollama), restaure le home puis le workspace (il propose de créer le volume APFS
`workspaces`), et termine par une vérification des outils requis.

Options : `--yes`, `--apps` (installe aussi les apps du `Brewfile.apps`), `--skip-home`, `--skip-workspace`,
`--skip-tools`, `--workspace-target <dossier>`, `--check` (vérification seule).

Les fichiers écrasés dans le home sont gardés avec le suffixe `.pre-restore`.

## Nettoyer les repos git (avant la sauvegarde)

```bash
just git-clean                 # simulation : gain estimé par repo + rapport TSV des branches
just git-clean --fetch         # idem après git fetch --prune (réseau)
just git-clean-apply           # supprime les branches "gone" fusionnées + git gc
```

Une branche « gone » est une branche locale dont la branche distante a été supprimée. Elle n'est supprimée que si
elle est fusionnée dans la branche principale (merge classique ou squash merge). Les autres sont gardées, sauf avec
`--include-unmerged`.

- `--only <motif>` : limite aux repos dont le chemin contient le motif (ex. `--only clubmed/digital-oidc`)
- `--prune-now` : libère tout de suite l'espace des branches supprimées (sinon git garde leurs objets 2 semaines)
- `--no-gc` : pas de `git gc`

Les SHA des branches supprimées sont notés dans `.git/cleanup-deleted-branches.log` de chaque repo :
`git branch <nom> <sha>` les recrée tant que l'espace n'a pas été libéré.

## Analyser l'occupation du disque (app Cairn)

`Cairn/` contient une app macOS (SwiftUI, construite avec SwiftPM : les Command Line Tools suffisent,
pas besoin de Xcode) qui montre ce qui occupe `/Volumes/workspaces`. Utile pour choisir quoi nettoyer avant une
sauvegarde ou quand le volume est plein.

```bash
just storage-install           # construit « Cairn.app » et l'installe dans ~/Applications
just storage                   # ouvre l'app (l'analyse démarre toute seule)
just storage-report            # même analyse dans le terminal, sans interface
just storage-report ~/Projets  # sur un autre dossier
```

L'espace est réparti par type : sources, historique `.git`, et dossiers régénérables — dépendances (`node_modules`,
`.pnpm-store`, `vendor`…), builds (`dist`, `coverage`, `.next`, `.build` de SwiftPM…), iOS (`Pods`, `DerivedData`), Python (`.venv`,
`__pycache__`…) et caches. Comme pour la sauvegarde, `build/`, `out/`, `target/` et `vendor/` ne sont comptés comme
régénérables qu'à côté d'un fichier de projet (`package.json`, `Cargo.toml`, `composer.json`…). Les fichiers à
liens physiques multiples (pnpm) ne sont comptés qu'une fois.

| Onglet | Contenu |
|---|---|
| Explorateur | navigation dossier par dossier, barre de répartition par type, graphique du dossier sélectionné |
| Nettoyable | tous les dossiers régénérables, filtrables par type ; mise à la corbeille ou suppression définitive après confirmation |
| Dépôts git | taille de chaque repo : sources, `.git`, régénérable |
| Gros fichiers | fichiers de plus de 50 Mo |

L'app est disponible en anglais et en français (elle suit la langue de macOS) ; en ligne de commande, `--lang en-US|fr-FR`.
Cairn intègre progressivement les scripts de sauvegarde, de restauration et de nettoyage git (changement OpenSpec `cairn-integration-scripts`).

Raccourcis : `⌘R` relance l'analyse, `⌘O` choisit un autre dossier, `⌘↑` remonte d'un niveau.

> La corbeille d'un volume externe ne libère l'espace qu'une fois vidée.
> Pour supprimer des branches git inutiles plutôt que des fichiers, voir `just git-clean`.
