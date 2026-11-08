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

## 2026-11-08 — Design system tiré de captures
- Erreur : un composant (sélecteur en pilule) remplacé par la première variante vue dans les captures, alors que
  Codex en a deux (bascule segmentée « Chat / Work » et onglets de page « Aperçu ») ; rail et réglages laissés
  dans l'ancien style.
- Règle : avant de remplacer un composant, recenser toutes ses variantes dans les captures et garder une variante
  par usage ; appliquer le design system à tous les écrans qui l'utilisent (rail, réglages), pas seulement à
  l'écran demandé. Vérifier chaque écran avec `Cairn --snapshot` en clair et en sombre.

## 2026-11-08 — Release automatique
- Erreur : release déclenchée par un `just bump` manuel (tag absent ⇒ release), alors que le projet suit les
  Conventional Commits : un `feat` mergé (PR #3) aurait dû produire la 0.2.0 sans autre geste.
- Règle : quand les commits suivent une convention, la version en découle (semantic-release) ; ne pas ajouter d'étape
  manuelle au flux branche → PR → revue → merge → build → release. Préférer un outil standard à un script maison.
