#!/usr/bin/env bash
# Sauvegarde du home + workspaces vers un disque de backup.
#
# Usage : ./backup.sh <DESTINATION> [options]
#   --dry-run        simule (rsync -n), n'écrit que le manifest
#   --mirror         supprime dans la sauvegarde ce qui n'existe plus à la source
#   --no-home        ne sauvegarde pas le home
#   --no-workspace   ne sauvegarde pas le workspace
#
# Variables : WORKSPACE_SRC (défaut /Volumes/workspaces)
#
# Contenu produit dans <DESTINATION> :
#   home/        copie filtrée de ~ (sans Desktop, Documents, Downloads, Library, médias, caches)
#   workspaces/  copie filtrée du workspace (sans node_modules ni dossiers de build)
#   ai/          snapshots cohérents des bases SQLite Claude/Codex + sessions Claude Desktop
#   manifest/    Brewfile, outils mise/npm/uv/pipx, analyse des outils requis…
#   restore.sh   script de redéploiement

set -euo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/mise/shims:$PATH"
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS="${WORKSPACE_SRC:-/Volumes/workspaces}"

DEST=""
DRY_RUN=0
MIRROR=0
DO_HOME=1
DO_WS=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --mirror) MIRROR=1 ;;
    --no-home) DO_HOME=0 ;;
    --no-workspace) DO_WS=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "Option inconnue : $1" >&2; exit 1 ;;
    *) DEST="$1" ;;
  esac
  shift
done

[ -n "$DEST" ] || { echo "Usage : $0 <DESTINATION> [--dry-run] [--mirror] [--no-home] [--no-workspace]" >&2; exit 1; }
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

M="$DEST/manifest"
AI="$DEST/ai"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$M" "$AI" "$DEST/logs"
LOG="$DEST/logs/backup-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

c_info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

# --- rsync : GNU rsync (brew) si présent, sinon openrsync de macOS ---------
if [ -x /opt/homebrew/bin/rsync ]; then
  RSYNC=/opt/homebrew/bin/rsync
  RSYNC_OPTS=(-aH --human-readable --info=stats1,progress2)
else
  RSYNC=/usr/bin/rsync
  RSYNC_OPTS=(-a --stats)
fi
[ "$DRY_RUN" = 1 ] && RSYNC_OPTS+=(-n)
[ "$MIRROR" = 1 ] && RSYNC_OPTS+=(--delete)

# Exclut la destination si elle se trouve dans la source (évite la récursion)
dest_exclude() { # $1 = racine source
  case "$DEST/" in "$1"/*) echo "/${DEST#$1/}/" ;; esac
}

for app in Claude Codex ChatGPT; do
  pgrep -x "$app" >/dev/null 2>&1 && c_warn "$app est ouvert : ferme-le pour une copie parfaitement cohérente."
done

c_info "Destination : $DEST"
df -h "$DEST" | tail -1

# ===========================================================================
# 1. Manifest : inventaire des outils
# ===========================================================================
c_info "Inventaire des outils installés"

{
  echo "date=$(date '+%Y-%m-%d %H:%M:%S')"
  echo "host=$(scutil --get ComputerName 2>/dev/null || hostname)"
  echo "user=$USER"
  echo "home=$HOME"
  echo "workspace=$WS"
  echo "arch=$(uname -m)"
  sw_vers 2>/dev/null
} > "$M/system.txt"

ls -1 /Applications > "$M/apps.txt" 2>/dev/null || true
ls -la "$HOME/.local/bin" > "$M/local-bin.txt" 2>/dev/null || true

# Homebrew (formules, taps, casks)
if command -v brew >/dev/null; then
  brew bundle dump --force --file="$M/Brewfile" >/dev/null 2>&1 \
    || { brew leaves | sed 's/.*/brew "&"/' > "$M/Brewfile"; brew list --cask | sed 's/.*/cask "&"/' >> "$M/Brewfile"; }
  # npm/uv/vscode sont gérés par mise, uv et restore.sh : on ne garde que tap/brew/cask/mas
  [ -f "$M/Brewfile" ] && { grep -E '^(tap|brew|cask|mas) ' "$M/Brewfile" > "$TMP/Brewfile" || true; mv "$TMP/Brewfile" "$M/Brewfile"; }
  brew list --cask -1 > "$TMP/casks.txt" 2>/dev/null || true
fi

# Apps de /Applications installables via cask (hors outils gérés par l'IT)
: > "$M/Brewfile.apps"
while IFS='|' read -r app cask; do
  [ -d "/Applications/$app" ] || continue
  grep -qx "$cask" "$TMP/casks.txt" 2>/dev/null && continue
  echo "cask \"$cask\"  # $app" >> "$M/Brewfile.apps"
done <<'EOF'
Docker.app|docker-desktop
Visual Studio Code.app|visual-studio-code
Google Chrome.app|google-chrome
Firefox.app|firefox
Slack.app|slack
Spotify.app|spotify
Postman.app|postman
Bruno.app|bruno
Warp.app|warp
JetBrains Toolbox.app|jetbrains-toolbox
MongoDB Compass.app|mongodb-compass
Redis Insight.app|redis-insight
Ollama.app|ollama-app
Claude.app|claude
ChatGPT.app|chatgpt
WhatsApp.app|whatsapp
Maccy.app|maccy
Microsoft Teams.app|microsoft-teams
Microsoft Outlook.app|microsoft-outlook
Microsoft Word.app|microsoft-word
OneDrive.app|onedrive
Antigravity.app|antigravity
OpenCode.app|opencode-desktop
Sonos.app|sonos
Cursor.app|cursor
iTerm.app|iterm2
Raycast.app|raycast
Rectangle.app|rectangle
Notion.app|notion
Figma.app|figma
EOF

# mise
if command -v mise >/dev/null; then
  mise ls --current > "$M/mise-current.txt" 2>/dev/null || true
  cp "$HOME/.config/mise/config.toml" "$M/mise-config.toml" 2>/dev/null || true
fi

# Paquets npm globaux (dans le node par défaut de mise)
if command -v mise >/dev/null; then
  mise exec -- npm ls -g --depth=0 --parseable 2>/dev/null \
    | sed -n 's#.*/lib/node_modules/##p' \
    | grep -vxE 'npm|corepack' > "$M/npm-globals.txt" || true
fi

# uv tools : "spec|python" à partir des receipts
: > "$M/uv-tools.txt"
for r in "$HOME"/.local/share/uv/tools/*/uv-receipt.toml; do
  [ -f "$r" ] || continue
  name=$(sed -n 's/^requirements = \[{ name = "\([^"]*\)".*/\1/p' "$r")
  extras=$(sed -n 's/.*extras = \[\([^]]*\)\].*/\1/p' "$r" | tr -d '" ')
  py=$(sed -n 's/^python = "\(.*\)"/\1/p' "$r")
  [ -n "$name" ] || continue
  spec="$name"; [ -n "$extras" ] && spec="$name[$extras]"
  echo "$spec|$py" >> "$M/uv-tools.txt"
done

# pipx
command -v pipx >/dev/null && pipx list --json > "$M/pipx.json" 2>/dev/null || true

# Ollama (les modèles ne sont pas copiés, ils seront re-téléchargés)
command -v ollama >/dev/null && ollama list 2>/dev/null | awk 'NR>1{print $1}' > "$M/ollama-models.txt" || true

# VS Code
command -v code >/dev/null && code --list-extensions > "$M/vscode-extensions.txt" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Analyse des outils requis pour travailler : "outil|raison"
# ---------------------------------------------------------------------------
c_info "Analyse des outils requis (projets + historique zsh)"
REQ="$TMP/required.txt"
{
  # (les formules brew et les outils mise sont vérifiés via Brewfile / mise, pas ici)
  for t in brew git zsh mise node npm rsync; do echo "$t|socle"; done
  for b in claude codex coderabbit uv; do echo "$b|outil IA/CLI"; done
} > "$REQ"

# Marqueurs de projets dans le workspace
if [ "$DO_WS" = 1 ] && [ -d "$WS" ]; then
  command find "$WS" -maxdepth 5 \( -name node_modules -o -name .git -o -name .pnpm-store -o -name vendor \) -prune -o -type f \( \
      -name justfile -o -name Justfile -o -name 'docker-compose*.yml' -o -name 'compose.y*ml' -o -name Dockerfile \
      -o -name pnpm-lock.yaml -o -name yarn.lock -o -name 'bun.lock*' -o -name package-lock.json -o -name composer.json \
      -o -name Cargo.toml -o -name go.mod -o -name pyproject.toml -o -name '*.tf' -o -name Makefile \) -print 2>/dev/null \
    | sed 's#.*/##' | sort -u | while read -r f; do
      case "$f" in
        justfile|Justfile) echo "just|justfile dans le workspace" ;;
        docker-compose*|compose.y*ml|Dockerfile) echo "docker|Docker dans le workspace" ;;
        pnpm-lock.yaml) echo "pnpm|pnpm-lock.yaml" ;;
        yarn.lock) echo "yarn|yarn.lock" ;;
        bun.lock*) echo "bun|bun.lock" ;;
        package-lock.json) echo "npm|package-lock.json" ;;
        composer.json) echo "composer|composer.json"; echo "php|composer.json" ;;
        Cargo.toml) echo "cargo|Cargo.toml" ;;
        go.mod) echo "go|go.mod" ;;
        pyproject.toml) echo "python3|pyproject.toml" ;;
        *.tf) echo "terraform|fichiers .tf" ;;
        Makefile) echo "make|Makefile" ;;
      esac
    done >> "$REQ" || true
fi

# Commandes les plus utilisées (historique zsh) qui ne viennent pas du système
if [ -f "$HOME/.zsh_history" ]; then
  awk '{ sub(/^: [0-9]+:[0-9]+;/, ""); n=split($0, w, /[ \t]+/); c=w[1]; if (c=="sudo"||c=="rtk") c=w[2];
         if (c ~ /^[a-zA-Z][a-zA-Z0-9._-]*$/) cnt[c]++ }
       END { for (c in cnt) if (cnt[c] >= 3) print cnt[c], c }' "$HOME/.zsh_history" 2>/dev/null \
    | sort -rn | head -150 | while read -r n c; do
      p=$(type -P "$c" 2>/dev/null || true)
      case "$p" in ""|/usr/bin/*|/bin/*|/usr/sbin/*|/sbin/*|/usr/libexec/*) continue ;; esac
      echo "$c|historique zsh ($n utilisations)"
    done >> "$REQ" || true
fi

# Dédoublonnage (garde la première raison)
awk -F'|' 'NF && !seen[$1]++' "$REQ" > "$M/required-tools.txt"
echo "   $(wc -l < "$M/required-tools.txt" | tr -d ' ') outils requis recensés -> manifest/required-tools.txt"

# ===========================================================================
# 2. Conversations IA : snapshots SQLite cohérents + Claude Desktop
# ===========================================================================
c_info "Conversations IA (Claude, Codex)"
SNAP_EXCL="$TMP/sqlite-wal-excludes.txt"
: > "$SNAP_EXCL"
mkdir -p "$AI/sqlite"
for base in .codex .claude; do
  [ -d "$HOME/$base" ] || continue
  command find "$HOME/$base" \( -name node_modules -o -name plugins -o -name packages \) -prune -o \
      -type f \( -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db' \) -print 2>/dev/null \
    | while IFS= read -r db; do
      rel="${db#$HOME/}"
      out="$AI/sqlite/$rel"
      mkdir -p "$(dirname "$out")"
      if [ "$DRY_RUN" = 1 ] || sqlite3 "$db" ".backup '$out'" 2>/dev/null; then
        # la base snapshotée remplace le couple base+WAL dans home/
        printf '/%s-wal\n/%s-shm\n' "$rel" "$rel" >> "$SNAP_EXCL"
      else
        c_warn "snapshot impossible : $rel (copie brute via home/)"
      fi
    done || true
done

# Claude Desktop : historique des sessions Code + configuration (seule exception à Library)
for app in Claude Claude-3p; do
  src="$HOME/Library/Application Support/$app"
  [ -d "$src" ] || continue
  out="$AI/claude-desktop/$app"
  mkdir -p "$out"
  if [ -d "$src/claude-code-sessions" ]; then
    "$RSYNC" "${RSYNC_OPTS[@]}" "$src/claude-code-sessions/" "$out/claude-code-sessions/" >/dev/null \
      || c_warn "copie partielle des sessions Claude Desktop ($app)"
  fi
  if [ "$DRY_RUN" = 0 ]; then
    for f in "$src"/claude_desktop_config.json "$src"/config.json "$src"/ccd-*.json "$src"/cowork-*.json; do
      [ -f "$f" ] && cp -p "$f" "$out/"
    done
  fi
done

# ===========================================================================
# 3. Home
# ===========================================================================
if [ "$DO_HOME" = 1 ]; then
  c_info "Sauvegarde du home ($HOME)"
  HX="$M/excludes-home.txt"
  cat > "$HX" <<'EOF'
# Dossiers "publics" / données utilisateur non sauvegardées
/Desktop/
/Documents/
/Downloads/
/Library/
/Movies/
/Music/
/Pictures/
/Public/
/Applications/
/.Trash/
# Caches et installations reconstructibles
/.cache/
/.npm/
/.bun/install/cache/
/.yarn/berry/cache/
/.pnpm-store/
/.local/share/pnpm/store/
/.local/share/mise/installs/
/.local/share/mise/downloads/
/.local/share/uv/tools/
/.local/share/uv/python/
/.local/pipx/venvs/
/.local/pipx/shared/
/.local/pipx/.cache/
/.ollama/models/
/.gradle/caches/
/.m2/repository/
/.cargo/registry/
/.rustup/toolchains/
/.composer/cache/
/.node-gyp/
/.pm2/logs/
/.zcompdump*
# Caches des outils IA (les conversations, elles, sont conservées)
/.claude/cache/
/.claude/telemetry/
/.claude/shell-snapshots/
/.codex/cache/
/.codex/tmp/
/.codex/.tmp/
/.codex/..codex-global-state.json.*
# Plugins Claude/Codex : copiés à part (ils embarquent leurs node_modules)
/.claude/plugins/
/.codex/plugins/
# Partout
node_modules/
.DS_Store
EOF
  # Symlinks de ~/.local/bin pointant vers des venvs non sauvegardés (réinstallés par restore.sh)
  for l in "$HOME"/.local/bin/*; do
    [ -L "$l" ] || continue
    case "$(readlink "$l")" in
      */.local/pipx/venvs/*|*/.local/share/uv/tools/*) echo "/.local/bin/$(basename "$l")" >> "$HX" ;;
    esac
  done
  cat "$SNAP_EXCL" >> "$HX"
  dest_exclude "$HOME" >> "$HX"

  mkdir -p "$DEST/home"
  "$RSYNC" "${RSYNC_OPTS[@]}" --exclude-from="$HX" "$HOME/" "$DEST/home/" || c_warn "rsync home : erreurs (voir log)"

  for p in .claude/plugins .codex/plugins; do
    [ -d "$HOME/$p" ] || continue
    mkdir -p "$DEST/home/$p"
    "$RSYNC" "${RSYNC_OPTS[@]}" --exclude='.DS_Store' "$HOME/$p/" "$DEST/home/$p/" || c_warn "rsync $p : erreurs"
  done
fi

# ===========================================================================
# 4. Workspace
# ===========================================================================
if [ "$DO_WS" = 1 ]; then
  if [ ! -d "$WS" ]; then
    c_warn "Workspace introuvable : $WS"
  else
    c_info "Sauvegarde du workspace ($WS)"
    WX="$M/excludes-workspace.txt"
    cat > "$WX" <<'EOF'
# Métadonnées du volume
/.Spotlight-V100/
/.fseventsd/
/.Trashes/
/.TemporaryItems/
/.DocumentRevisions-V100/
/.pnpm-store/
# Dépendances et sorties de build (partout)
node_modules/
.pnpm-store/
bower_components/
jspm_packages/
dist/
coverage/
.nyc_output/
.turbo/
.nx/
.next/
.nuxt/
.angular/
.svelte-kit/
.output/
.vite/
.parcel-cache/
.docusaurus/
.cache/
.eslintcache
.stylelintcache
*.tsbuildinfo
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.venv/
.terraform/
.gradle/
.DS_Store
# --- Dossiers détectés automatiquement (lib/, build/, out/, target/, tmp/, vendor/) ---
EOF
    c_info "Détection des dossiers lib/ build/ out/ target/ tmp/ vendor/ générés…"
    command find "$WS" \( -name node_modules -o -name .git -o -name .pnpm-store -o -name dist -o -name coverage \
        -o -name .Spotlight-V100 -o -name .fseventsd -o -name .Trashes -o -name .DocumentRevisions-V100 -o -name .TemporaryItems \) -prune \
        -o -type d \( -name lib -o -name build -o -name out -o -name target -o -name tmp -o -name temp -o -name .tmp -o -name vendor \) -print -prune 2>/dev/null \
      | while IFS= read -r d; do
        parent="$(dirname "$d")"; name="$(basename "$d")"
        if git -C "$parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
          # Dans un repo git : on exclut seulement si le .gitignore l'ignore
          git -C "$parent" check-ignore -q "$name/" 2>/dev/null || continue
        else
          case "$name" in
            lib) [ -f "$parent/package.json" ] && [ -d "$parent/src" ] || continue ;;
            build|out) [ -f "$parent/package.json" ] || continue ;;
            target) [ -f "$parent/Cargo.toml" ] || [ -f "$parent/pom.xml" ] || continue ;;
            vendor) [ -f "$parent/composer.lock" ] || continue ;;
            tmp|temp|.tmp) ;;
          esac
        fi
        echo "/${d#$WS/}/"
      done >> "$WX" || true
    echo "   $(grep -c '^/.*/$' "$WX" | tr -d ' ') entrées d'exclusion -> manifest/excludes-workspace.txt"
    dest_exclude "$WS" >> "$WX"

    mkdir -p "$DEST/workspaces"
    "$RSYNC" "${RSYNC_OPTS[@]}" --exclude-from="$WX" "$WS/" "$DEST/workspaces/" || c_warn "rsync workspace : erreurs (voir log)"
  fi
fi

# ===========================================================================
# 5. Scripts de restauration
# ===========================================================================
cp "$SCRIPT_DIR/backup.sh" "$DEST/backup.sh"
[ -f "$SCRIPT_DIR/restore.sh" ] && cp "$SCRIPT_DIR/restore.sh" "$DEST/restore.sh"
[ -f "$SCRIPT_DIR/README.md" ] && cp "$SCRIPT_DIR/README.md" "$DEST/README.md"
chmod +x "$DEST"/*.sh

c_info "Terminé. Log : $LOG"
du -sh "$DEST"/home "$DEST"/workspaces "$DEST"/ai 2>/dev/null || true
c_warn "Le home contient des secrets (.zshrc, .ssh, .aws, auth Codex/Claude) : garde ce disque chiffré."
