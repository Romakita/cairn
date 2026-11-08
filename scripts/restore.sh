#!/usr/bin/env bash
# Redéploie une sauvegarde faite par backup.sh sur un Mac (neuf ou existant).
# À lancer depuis le dossier de sauvegarde : ./restore.sh [options]
#
#   --yes                 répond oui à toutes les questions
#   --apps                installe aussi les applications (manifest/Brewfile.apps)
#   --skip-home           ne restaure pas le home
#   --skip-workspace      ne restaure pas le workspace
#   --skip-tools          n'installe aucun outil (copie seulement)
#   --workspace-target P  dossier cible du workspace (défaut /Volumes/workspaces)
#   --check               vérifie seulement les outils requis (aucune modification)
#
# Ordre : Xcode CLT -> Homebrew -> zsh -> home -> oh-my-zsh -> Brewfile -> mise
#         -> npm globaux -> uv/pipx -> conversations IA -> workspace -> vérification

set -uo pipefail

BK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
M="$BK/manifest"
YES=0; APPS=0; DO_HOME=1; DO_WS=1; DO_TOOLS=1; CHECK_ONLY=0
WS_TARGET="/Volumes/workspaces"

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --apps) APPS=1 ;;
    --skip-home) DO_HOME=0 ;;
    --skip-workspace) DO_WS=0 ;;
    --skip-tools) DO_TOOLS=0 ;;
    --workspace-target) WS_TARGET="$2"; shift ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
  shift
done

info() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
ask()  { [ "$YES" = 1 ] && return 0; printf '   %s [o/N] ' "$1"; read -r r; case "$r" in o|O|y|Y|oui) return 0 ;; *) return 1 ;; esac; }

[ "$(uname)" = Darwin ] || { echo "Ce script est prévu pour macOS." >&2; exit 1; }
[ -d "$M" ] || { echo "Manifest introuvable : lance restore.sh depuis le dossier de sauvegarde." >&2; exit 1; }

load_env() {
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
  export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
}
load_env

# ---------------------------------------------------------------------------
# Vérification des outils requis
# ---------------------------------------------------------------------------
check_tools() {
  info "Vérification des outils requis"
  local missing=0
  if [ -f "$M/required-tools.txt" ]; then
    while IFS='|' read -r tool why; do
      [ -n "$tool" ] || continue
      if command -v "$tool" >/dev/null 2>&1; then ok "$tool"; else warn "MANQUANT : $tool  ($why)"; missing=$((missing+1)); fi
    done < "$M/required-tools.txt"
  fi
  if command -v brew >/dev/null && [ -f "$M/Brewfile" ]; then
    brew bundle check --no-upgrade --file="$M/Brewfile" >/dev/null 2>&1 && ok "Brewfile complet" \
      || { warn "Brewfile incomplet :"; brew bundle check --no-upgrade --verbose --file="$M/Brewfile" 2>&1 | sed 's/^/      /' | head -30; missing=$((missing+1)); }
  fi
  if command -v mise >/dev/null; then
    local mm; mm="$(mise ls --current --missing 2>/dev/null)"
    [ -z "$mm" ] && ok "outils mise installés" || { warn "outils mise manquants :"; echo "$mm" | sed 's/^/      /'; missing=$((missing+1)); }
  fi
  if [ -s "$M/uv-tools.txt" ] && command -v uv >/dev/null; then
    while IFS='|' read -r spec _; do
      n="${spec%%[*}"; uv tool list 2>/dev/null | grep -q "^$n " && ok "uv tool $n" || { warn "uv tool manquant : $n"; missing=$((missing+1)); }
    done < "$M/uv-tools.txt"
  fi
  echo
  [ "$missing" = 0 ] && ok "Tout est en place." || warn "$missing élément(s) à vérifier (voir ci-dessus)."
}

if [ "$CHECK_ONLY" = 1 ]; then check_tools; exit 0; fi

echo "Sauvegarde : $BK"
sed -nE 's/^(date|host|arch)=/   \1 = /p' "$M/system.txt" 2>/dev/null
[ "$(sed -n 's/^arch=//p' "$M/system.txt")" = "$(uname -m)" ] || warn "Architecture différente de la machine sauvegardée."

# ---------------------------------------------------------------------------
if [ "$DO_TOOLS" = 1 ]; then
  info "Xcode Command Line Tools"
  if xcode-select -p >/dev/null 2>&1; then ok "déjà installés"; else
    xcode-select --install 2>/dev/null || true
    echo "   Termine l'installation dans la fenêtre macOS…"
    until xcode-select -p >/dev/null 2>&1; do sleep 10; done; ok "installés"
  fi

  info "Homebrew"
  if command -v brew >/dev/null; then ok "déjà installé ($(brew --version | head -1))"; else
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    load_env; command -v brew >/dev/null && ok "installé" || { warn "échec de l'installation de Homebrew"; exit 1; }
  fi

  info "zsh"
  command -v zsh >/dev/null || brew install zsh
  ok "$(zsh --version)"
  current_shell="$(dscl . -read "$HOME" UserShell 2>/dev/null | awk '{print $2}')"
  case "$current_shell" in
    */zsh) ok "shell par défaut : $current_shell" ;;
    *) ask "Définir zsh comme shell par défaut ?" && chsh -s /bin/zsh ;;
  esac
fi

# ---------------------------------------------------------------------------
if [ "$DO_HOME" = 1 ] && [ -d "$BK/home" ]; then
  info "Restauration du home"
  echo "   Les fichiers existants remplacés sont conservés avec le suffixe .pre-restore"
  if ask "Copier $BK/home vers $HOME ?"; then
    /usr/bin/rsync -a --backup --suffix=.pre-restore "$BK/home/" "$HOME/" && ok "home restauré" || warn "rsync home : erreurs"
    chmod 700 "$HOME/.ssh" 2>/dev/null; chmod 600 "$HOME"/.ssh/* 2>/dev/null; chmod 644 "$HOME"/.ssh/*.pub 2>/dev/null
    chmod 600 "$HOME/.netrc" "$HOME/.codex/auth.json" "$HOME/.codex/.credentials.json" 2>/dev/null
    load_env
  fi

  info "Conversations IA"
  if [ -d "$BK/ai/sqlite" ]; then
    # snapshots cohérents : on retire les WAL/SHM éventuels avant de poser la base
    (cd "$BK/ai/sqlite" && find . -type f) | while IFS= read -r f; do
      rel="${f#./}"; rm -f "$HOME/$rel-wal" "$HOME/$rel-shm"
      mkdir -p "$(dirname "$HOME/$rel")"; cp -p "$BK/ai/sqlite/$rel" "$HOME/$rel"
    done
    ok "bases Claude/Codex restaurées"
  fi
  if [ -d "$BK/ai/claude-desktop" ]; then
    pgrep -x Claude >/dev/null 2>&1 && warn "Claude Desktop est ouvert : quitte-le avant de continuer." && ask "Continuer ?"
    for d in "$BK"/ai/claude-desktop/*; do
      [ -d "$d" ] || continue
      dst="$HOME/Library/Application Support/$(basename "$d")"
      mkdir -p "$dst"; /usr/bin/rsync -a "$d/" "$dst/" && ok "Claude Desktop ($(basename "$d"))"
    done
  fi
fi

# ---------------------------------------------------------------------------
if [ "$DO_TOOLS" = 1 ]; then
  info "oh-my-zsh"
  if [ -d "$HOME/.oh-my-zsh" ]; then ok "présent"; else
    RUNZSH=no CHSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended \
      && ok "installé"
  fi

  info "Formules et taps Homebrew (manifest/Brewfile)"
  if [ -f "$M/Brewfile" ]; then
    grep -E '^(tap|brew|cask)' "$M/Brewfile" | sed 's/^/   /'
    if ask "Installer le contenu du Brewfile ?"; then
      brew bundle install --file="$M/Brewfile" || warn "certains éléments n'ont pas pu être installés"
    fi
  fi

  if [ -s "$M/Brewfile.apps" ]; then
    info "Applications (manifest/Brewfile.apps)"
    sed 's/^/   /' "$M/Brewfile.apps"
    if [ "$APPS" = 1 ] || ask "Installer ces applications ?"; then
      # une app déjà présente fait échouer son cask : on continue quand même
      brew bundle install --file="$M/Brewfile.apps" || warn "certaines apps étaient déjà là ou ont échoué"
    fi
  fi

  info "mise"
  if command -v mise >/dev/null; then ok "présent ($(mise --version 2>/dev/null | head -1))"; else
    curl -fsSL https://mise.run | sh && load_env && ok "installé"
  fi
  if command -v mise >/dev/null; then
    [ -f "$HOME/.config/mise/config.toml" ] || { mkdir -p "$HOME/.config/mise"; cp "$M/mise-config.toml" "$HOME/.config/mise/config.toml" 2>/dev/null; }
    mise install -y && mise reshim && ok "outils mise installés" || warn "mise install : erreurs"
  fi

  if [ -s "$M/npm-globals.txt" ] && command -v mise >/dev/null; then
    info "Paquets npm globaux"
    while read -r pkg; do
      [ -n "$pkg" ] || continue
      if mise exec -- npm ls -g --depth=0 "$pkg" >/dev/null 2>&1; then ok "$pkg"; else
        mise exec -- npm install -g "$pkg" >/dev/null 2>&1 && ok "$pkg installé" || warn "échec : $pkg"
      fi
    done < "$M/npm-globals.txt"
    mise reshim
  fi

  if [ -s "$M/uv-tools.txt" ]; then
    info "uv et outils Python"
    command -v uv >/dev/null || { curl -LsSf https://astral.sh/uv/install.sh | sh; load_env; }
    while IFS='|' read -r spec py; do
      n="${spec%%[*}"
      if uv tool list 2>/dev/null | grep -q "^$n "; then ok "$n"; else
        if [ -n "$py" ]; then uv tool install --force --python "$py" "$spec"; else uv tool install --force "$spec"; fi \
          && ok "$n installé" || warn "échec : $spec"
      fi
    done < "$M/uv-tools.txt"
  fi

  if [ -s "$M/pipx.json" ] && command -v pipx >/dev/null; then
    info "pipx"
    pipx install-all "$M/pipx.json" && ok "paquets pipx installés" || warn "pipx install-all : erreurs (déjà installés ?)"
  fi

  if [ -s "$M/ollama-models.txt" ] && command -v ollama >/dev/null; then
    info "Modèles Ollama"
    sed 's/^/   /' "$M/ollama-models.txt"
    if ask "Télécharger ces modèles ?"; then
      while read -r m; do ollama pull "$m" || warn "échec : $m"; done < "$M/ollama-models.txt"
    fi
  fi

  if [ -s "$M/vscode-extensions.txt" ] && command -v code >/dev/null; then
    info "Extensions VS Code"
    while read -r e; do code --install-extension "$e" >/dev/null 2>&1 && ok "$e"; done < "$M/vscode-extensions.txt"
  fi
fi

# ---------------------------------------------------------------------------
if [ "$DO_WS" = 1 ] && [ -d "$BK/workspaces" ]; then
  info "Workspace -> $WS_TARGET"
  if [ ! -d "$WS_TARGET" ] && [ "$WS_TARGET" = "/Volumes/workspaces" ]; then
    container="$(diskutil info / | sed -n 's/^ *Part of Whole: *//p')"
    echo "   /Volumes/workspaces n'existe pas. Les chemins (Claude, Codex, IDE) y font référence."
    if [ -n "$container" ] && ask "Créer un volume APFS 'workspaces' sur $container ?"; then
      diskutil apfs addVolume "$container" APFS workspaces && ok "volume créé"
    fi
    if [ ! -d "$WS_TARGET" ]; then WS_TARGET="$HOME/workspaces"; warn "repli sur $WS_TARGET"; fi
  fi
  if ask "Copier le workspace vers $WS_TARGET ?"; then
    mkdir -p "$WS_TARGET"
    /usr/bin/rsync -a "$BK/workspaces/" "$WS_TARGET/" && ok "workspace restauré" || warn "rsync workspace : erreurs"
    echo "   Pense à relancer l'installation des dépendances (pnpm/yarn/npm/bun install) dans chaque projet."
  fi
fi

# ---------------------------------------------------------------------------
load_env
check_tools

info "À faire à la main"
cat <<'EOF'
   - Ouvrir un nouveau terminal (zsh) pour charger .zshrc
   - Se reconnecter : gh auth login, claude (/login), codex login, docker login
   - Trousseau macOS / mots de passe : non sauvegardés (iCloud Keychain ou gestionnaire)
   - Apps gérées par l'IT (VPN, antivirus, MDM) : à installer via ton entreprise
EOF
