#!/usr/bin/env bash
# Nettoyage des repos git d'un dossier (par défaut /Volumes/workspaces).
#
# Par défaut : SIMULATION. Rien n'est modifié, le script affiche le gain estimé
# par repo et écrit la liste des branches qu'il supprimerait.
#
# Usage : ./git-cleanup.sh [options]
#   --root DIR          dossier à parcourir (défaut /Volumes/workspaces)
#   --only MOTIF        ne traite que les repos dont le chemin contient MOTIF
#   --fetch             git fetch --prune d'abord (réseau ; retire les refs de
#                       branches supprimées sur le serveur, rien d'autre)
#   --apply             exécute : suppression des branches "gone" fusionnées + git gc
#   --include-unmerged  avec --apply : supprime aussi les branches "gone" NON fusionnées
#   --prune-now         avec --apply : libère tout de suite l'espace des branches
#                       supprimées (sinon git garde leurs objets 2 semaines)
#   --no-gc             ne lance pas git gc
#
# Une branche "gone" est une branche locale dont la branche distante a été supprimée.
# Elle est considérée fusionnée si ses commits sont dans la branche principale,
# y compris via un "squash merge".
#
# Les SHA des branches supprimées sont notés dans .git/cleanup-deleted-branches.log
# de chaque repo : `git branch <nom> <sha>` permet de les recréer (avant le prune).

set -uo pipefail
export LC_ALL=C GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=10}"

ROOT=/Volumes/workspaces
ONLY=""
FETCH=0; APPLY=0; UNMERGED=0; PRUNE_NOW=0; GC=1

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift ;;
    --only) ONLY="$2"; shift ;;
    --fetch) FETCH=1 ;;
    --apply) APPLY=1 ;;
    --include-unmerged) UNMERGED=1 ;;
    --prune-now) PRUNE_NOW=1 ;;
    --no-gc) GC=0 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
  shift
done

REPORT="$(pwd)/git-cleanup-report-$(date +%Y%m%d-%H%M%S).tsv"
printf 'repo\tbranche\tstatut\tsha\tdernier_commit\tsujet\n' > "$REPORT"

mode="SIMULATION"; [ "$APPLY" = 1 ] && mode="APPLICATION"
printf '\033[1m%s\033[0m sur %s\n\n' "$mode" "$ROOT"

human() { awk -v b="$1" 'BEGIN{ split("o Ko Mo Go",u," "); i=1; while (b>=1024 && i<4) { b/=1024; i++ } printf (i==1?"%d %s":"%.1f %s"), b, u[i] }'; }

# Branche principale : origin/HEAD, sinon main/master/develop (distante puis locale)
main_ref() {
  local r
  r=$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null) && { echo "$r"; return; }
  for b in main master develop; do
    git show-ref -q --verify "refs/remotes/origin/$b" && { echo "refs/remotes/origin/$b"; return; }
  done
  for b in main master develop; do
    git show-ref -q --verify "refs/heads/$b" && { echo "refs/heads/$b"; return; }
  done
}

# fusionnée (merge classique), squash (même contenu qu'un commit de main), ou non
merge_status() { # $1 = branche, $2 = ref principale
  local br="$1" mr="$2" base pid
  [ -n "$mr" ] || { echo unmerged; return; }
  if git merge-base --is-ancestor "refs/heads/$br" "$mr" 2>/dev/null; then echo merged; return; fi
  base=$(git merge-base "refs/heads/$br" "$mr" 2>/dev/null) || { echo unmerged; return; }
  # empreinte du diff complet de la branche ; si un commit de main a la même -> squash merge
  pid=$(git diff "$base" "refs/heads/$br" 2>/dev/null | git patch-id --stable 2>/dev/null | cut -d' ' -f1)
  [ -n "$pid" ] || { echo merged; return; }   # la branche n'apporte aucun changement
  if git log -p --no-merges --format='commit %H' "$base..$mr" 2>/dev/null | git patch-id --stable 2>/dev/null | grep -q "^$pid "; then
    echo squash
  else
    echo unmerged
  fi
}

T_GIT=0; T_LOOSE=0; T_FREE=0; T_DEL=0; T_KEEP=0; N=0

while IFS= read -r gitdir; do
  repo="${gitdir%/.git}"
  rel="${repo#$ROOT/}"
  [ -n "$ONLY" ] && case "$rel" in *"$ONLY"*) ;; *) continue ;; esac
  cd "$repo" || continue
  N=$((N+1))

  if [ "$FETCH" = 1 ] && [ -n "$(git remote)" ]; then
    git fetch --all --prune --quiet 2>/dev/null || printf '   \033[33m!\033[0m fetch impossible : %s\n' "$rel"
  fi

  loose=0; pack=0
  while IFS=': ' read -r k v; do
    case "$k" in size) loose=$((v*1024)) ;; size-pack) pack=$((v*1024)) ;; esac
  done < <(git count-objects -v 2>/dev/null)
  T_GIT=$((T_GIT+loose+pack)); T_LOOSE=$((T_LOOSE+loose))

  mr=$(main_ref)
  current=$(git symbolic-ref -q --short HEAD 2>/dev/null || true)
  to_delete=(); kept=0
  while IFS='|' read -r br track sha date subj; do
    case "$track" in *gone*) ;; *) continue ;; esac
    [ "$br" = "$current" ] && continue                      # jamais la branche courante
    [ -n "$mr" ] && [ "refs/heads/$br" = "$mr" ] && continue
    st=$(merge_status "$br" "$mr")
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$rel" "$br" "$st" "$sha" "$date" "$subj" >> "$REPORT"
    if [ "$st" != unmerged ] || [ "$UNMERGED" = 1 ]; then to_delete+=("$br"); else kept=$((kept+1)); fi
  done < <(git for-each-ref refs/heads --format='%(refname:short)|%(upstream:track)|%(objectname:short)|%(committerdate:short)|%(subject)')

  # Espace occupé par les seuls objets des branches à supprimer (estimation)
  free=0
  if [ ${#to_delete[@]} -gt 0 ]; then
    free=$( { for b in "${to_delete[@]}"; do echo "refs/heads/$b"; done
              git for-each-ref --format='%(refname)' | grep -vxF -f <(for b in "${to_delete[@]}"; do echo "refs/heads/$b"; done) | sed 's/^/^/'
            } | git rev-list --stdin --objects --disk-usage 2>/dev/null || echo 0)
  fi
  T_FREE=$((T_FREE+free)); T_DEL=$((T_DEL+${#to_delete[@]})); T_KEEP=$((T_KEEP+kept))

  line=$(printf '%-60s .git %9s  non compressé %9s  branches à supprimer %3d (%s)  gardées %3d' \
    "$rel" "$(human $((loose+pack)))" "$(human $loose)" "${#to_delete[@]}" "$(human "$free")" "$kept")
  [ ${#to_delete[@]} -gt 0 ] || [ "$loose" -gt 52428800 ] && echo "$line"

  if [ "$APPLY" = 1 ]; then
    if [ ${#to_delete[@]} -gt 0 ]; then
      for b in "${to_delete[@]}"; do
        printf '%s\t%s\t%s\n' "$(date '+%F %T')" "$b" "$(git rev-parse "refs/heads/$b")" >> "$(git rev-parse --git-dir)/cleanup-deleted-branches.log"
      done
      git branch -D "${to_delete[@]}" >/dev/null 2>&1 || printf '   \033[33m!\033[0m suppression partielle dans %s\n' "$rel"
    fi
    if [ "$PRUNE_NOW" = 1 ]; then
      git reflog expire --expire-unreachable=now --all 2>/dev/null
      [ "$GC" = 1 ] && git gc --quiet --prune=now 2>/dev/null
    elif [ "$GC" = 1 ]; then
      git gc --quiet 2>/dev/null
    fi
  fi
done < <(find "$ROOT" \( -name node_modules -o -name .pnpm-store -o -name .Trashes -o -name .Spotlight-V100 -o -name .fseventsd \) -prune \
           -o -type d -name .git -print -prune 2>/dev/null | sort)

echo
echo "Repos analysés            : $N"
echo "Taille totale des .git    : $(human $T_GIT)"
echo "Objets non compressés     : $(human $T_LOOSE)  (git gc en récupère la majeure partie)"
echo "Branches 'gone' supprimées: $T_DEL  -> environ $(human $T_FREE) libérés (avec --prune-now)"
echo "Branches 'gone' gardées   : $T_KEEP  (non fusionnées ; --include-unmerged pour les supprimer)"
echo "Détail par branche        : $REPORT"
[ "$APPLY" = 1 ] || echo "Simulation : rien n'a été modifié. Relance avec --apply pour exécuter."
