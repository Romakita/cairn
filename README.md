# Sauvegarde et redéploiement du Mac

## Sauvegarder

Branche un disque **chiffré** (le home contient des tokens : `.zshrc`, `.ssh`, `.aws`, auth Claude/Codex).
Ferme Claude, Codex et ChatGPT, puis :

```bash
./backup.sh /Volumes/MonDisque/mac-backup
```

Options : `--dry-run` (simulation), `--mirror` (supprime dans la sauvegarde ce qui a disparu),
`--no-home`, `--no-workspace`. Relancer la commande fait une mise à jour incrémentale.

> Lance-le depuis Terminal/Warp avec l'accès complet au disque (Réglages > Confidentialité > Accès complet au disque).
> Installer `brew install rsync` le rend plus rapide (barre de progression).

### Ce qui est sauvegardé

| Dossier       | Contenu |
|---------------|---------|
| `home/`       | `~` sauf Desktop, Documents, Downloads, Library, Movies, Music, Pictures, Public, Applications, la corbeille, les caches (`.cache`, `.npm`, bun, pnpm), les installations reconstructibles (mise, uv, pipx, modèles Ollama) et tous les `node_modules` |
| `workspaces/` | `/Volumes/workspaces` sans `node_modules`, `.pnpm-store`, `dist`, `coverage`, `.turbo`, `.nx`, `.next`, `.nuxt`, `.angular`, `.vite`, `.cache`, `.venv`, `__pycache__`, `*.tsbuildinfo`… Les dossiers `lib/`, `build/`, `out/`, `target/`, `tmp/`, `vendor/` ne sont exclus que s'ils sont générés (ignorés par le `.gitignore` du repo, ou à côté d'un `package.json`/`Cargo.toml`/`composer.lock` hors git) |
| `ai/`         | Copies cohérentes des bases SQLite de `~/.claude` et `~/.codex` + sessions et config de Claude Desktop (seule chose prise dans Library) |
| `manifest/`   | `Brewfile`, `Brewfile.apps`, outils mise, paquets npm globaux, outils uv/pipx, modèles Ollama, `required-tools.txt` (outils requis repérés dans les projets et l'historique zsh), listes d'exclusion |

Les conversations Claude Code (`~/.claude/projects`, `~/.claude.json`) et Codex (`~/.codex/sessions`, `archived_sessions`, bases SQLite) sont dans `home/` et `ai/`.

## Redéployer sur l'autre Mac

```bash
cd /Volumes/MonDisque/mac-backup
./restore.sh
```

Le script installe ce qui manque (Xcode CLT, Homebrew, zsh, oh-my-zsh, contenu du Brewfile, mise et ses outils,
paquets npm globaux, uv/pipx, modèles Ollama), restaure le home puis le workspace (il propose de créer le volume APFS
`workspaces`), et termine par une vérification des outils requis.

Options : `--yes`, `--apps` (installe aussi les apps du `Brewfile.apps`), `--skip-home`, `--skip-workspace`,
`--skip-tools`, `--workspace-target <dossier>`, `--check` (vérification seule).

Les fichiers écrasés dans le home sont gardés avec le suffixe `.pre-restore`.
