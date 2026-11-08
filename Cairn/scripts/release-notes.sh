#!/bin/zsh
# Notes de la prochaine release, pour semantic-release (generateNotesCmd) et pour remplir le CHANGELOG.
# Source unique : les Conventional Commits depuis le dernier tag (feat → Added, fix/perf → Fixed, breaking → Changed).
# Le CHANGELOG n'est jamais rédigé à la main : c'est le sujet des commits feat/fix qui fait la note.
# Usage : release-notes.sh [--footer] [<commit du dernier tag>]
#   --footer : ajoute la notice d'installation (corps de la release GitHub, affiché aussi par la mise à jour de l'app).
set -euo pipefail
cd "${0:A:h:h:h}"

FOOTER=0
[[ "${1:-}" == "--footer" ]] && { FOOTER=1; shift; }
SINCE="${1:-}"

re='^([a-z]+)(\([^)]*\))?(!)?: (.+)$'
added=() fixed=() changed=()
for rec in "${(@ps:\x1e:)$(git log --no-merges --format='%s%n%b%x1e' "${SINCE:+$SINCE..}HEAD")}"; do
  rec="${rec#$'\n'}"
  subject="${rec%%$'\n'*}"
  [[ "$subject" =~ $re ]] || continue
  if [[ -n "${match[3]}" || "$rec" == *$'\n'BREAKING[\ -]CHANGE:* ]]; then changed+=("**Breaking:** ${match[4]}")
  elif [[ "${match[1]}" == feat ]]; then added+=("${match[4]}")
  elif [[ "${match[1]}" == (fix|perf) ]]; then fixed+=("${match[4]}")
  fi
done
notes="$(
  (( ${#changed} )) && { print "### Changed"; printf -- '- %s\n' "${changed[@]}"; print; }
  (( ${#added} ))   && { print "### Added";   printf -- '- %s\n' "${added[@]}";   print; }
  (( ${#fixed} ))   && { print "### Fixed";   printf -- '- %s\n' "${fixed[@]}";   print; }
  true
)"

print -r -- "$notes"
if (( FOOTER )); then
  cat <<'NOTES'

---
**Installation:** unzip the archive and drag `Cairn.app` into `~/Applications`. The app is not notarized: on
first launch, right-click → Open, or run `xattr -dr com.apple.quarantine ~/Applications/Cairn.app`.
`cairn` command: `ln -sf ~/Applications/Cairn.app/Contents/MacOS/Cairn ~/.local/bin/cairn`.
Later updates install from the app (**Update available** button, or **Cairn → Check for Updates…**).
NOTES
fi
