# Leçons

Une entrée après chaque correction de l'utilisateur. À relire au début de chaque session.

<!--
## <Date> — <Sujet>
- Erreur :
- Règle :
-->

## 2026-11-08 — Langue du README public
- Erreur : README open source écrit en français parce que les docs du projet sont en français.
- Règle : ce qui s'adresse au public (README racine, page de release, captures) est en anglais d'abord, avec une
  version française à côté (`README.fr.md`, captures `-fr`). Les docs internes, specs et commentaires restent en français.

## 2026-11-08 — Commits, note de release et mise à jour d'une PR
- Erreur : commits sans convention (« In-app updates, like Codex »), entrée du CHANGELOG en français alors qu'il sert
  de note de release, et conflit de PR résolu par un commit de fusion.
- Règle : messages de commit en anglais au format Conventional Commits (`type(scope): sujet`) ; CHANGELOG et notes de
  release en anglais ; une branche de PR se met à jour par rebase sur `main` et `--force-with-lease`, jamais par merge.
