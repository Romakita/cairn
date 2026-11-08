# Todo

Plan de la tâche en cours (voir la section « Gestion des tâches » d'AGENTS.md).
Les nouvelles fonctionnalités passent plutôt par un changement OpenSpec (`/opsx:propose`).

## Tâche en cours

_Aucune._

## Revue — vérification de bout en bout de Cairn (tâche 11.3 de `cairn-integration-scripts`, 2026-11-08)

Vérifié sur cette machine :

- [x] `just test` : 100 tests réussis, après chaque lot.
- [x] Les 8 recettes `just` (`backup-dry`, `restore`, `check`, `verify`, `git-clean`, `tools`, `storage-report`, `test`)
  passent en simulation (code 0).
- [x] Analyse : totaux identiques à `du -sk` (écart 0,000 % sur 172,85 Go).
- [x] Nettoyage git sur un dépôt de test : la simulation liste la branche `gone` et le worktree orphelin sans rien
  modifier ; `--apply` après confirmation les supprime et note les SHA dans `.git/cleanup-deleted-branches.log`.
- [x] `cairn git --json` en en-US et en fr-FR : sorties identiques octet par octet.
- [x] Sauvegarde chiffrée réelle vers une destination locale (même code d'image sparsebundle que le NAS) :
  la destination ne contient que l'image, la 2ᵉ version ne copie que 3 ko, `verify --full` donne 0 fichier abîmé,
  `restore` en simulation liste les outils, et l'image est démontée à la fin.
- [x] Reprise d'une sauvegarde interrompue, rétention, intégrité (fichier abîmé détecté puis recopié), mise en attente
  d'une destination injoignable, planificateur avec horloge, alimentation et réseau simulés : couverts par les tests.
- [x] Outils IA : 304 conversations Claude Code et 809 Codex détectées ; `backup --only ai --tool codex` ne crée que
  `ai/codex/`.
- [x] Panneau de la barre des menus et écrans dans les deux langues : rendus hors écran (`Cairn --snapshot`).
- Correction faite pendant la revue : la progression de `cairn git` n'est plus écrite quand la sortie d'erreur n'est
  pas un terminal (elle se collait au reste du texte dans les journaux).

Reste à faire à la main (impossible ici : NAS, veille réelle, compte vierge) :

- [ ] 7.4 : sauvegarde chiffrée sur le NAS Synology ; NAS éteint (sauvegarde en attente, autres destinations
  non touchées), puis rallumé (départ dans les 5 minutes).
- [ ] 7.5 : fermer le capot pendant une sauvegarde et la voir reprendre au réveil ; batterie sous 20 %.
- [ ] 10.5 et 11.3 : premier lancement sur un compte macOS vierge, puis restauration complète depuis le NAS sur ce
  compte, en en-US et en fr-FR.

<!--
## <Titre de la tâche>

- [ ] Étape 1
- [ ] Étape 2

### Revue
- Ce qui a changé :
- Comment c'est vérifié :
-->
