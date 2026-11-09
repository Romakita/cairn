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

## 2026-11-08 — Accueil trop neutre
- Erreur : le hub reprenait le style neutre des réglages de Codex (icônes grises cerclées) ; jugé simpliste, sans
  couleur ni caractère, alors que la référence demandée (Avast) mise sur de grandes icônes colorées.
- Règle : quand une page s'inspire d'une référence visuelle, en reprendre la hiérarchie (taille des icônes, couleur
  par module, petits graphiques) et ne garder le neutre du design system que pour la structure (cartes, boutons) ;
  montrer une capture avant de considérer le design comme fini.

## 2026-11-08 — Noms de branche générés
- Erreur : branches laissées avec le nom généré par l'app (`claude/wonderful-varahamihira-8cbf34`), illisible.
- Règle : renommer la branche en `<type>/<description-courte>` (types Conventional Commits) avant le premier commit.

## 2026-11-08 — Boutons d'action et groupes de boutons
- Erreur : boutons « Vérifier l'intégrité » / « Vérification complète » actifs alors que rien ne peut être vérifié ;
  sélecteur de rétention laissé en `Picker(.segmented)` natif (bleu) au lieu du style Codex.
- Règle : tout bouton d'action est désactivé quand son action ne peut pas aboutir, avec la raison en `.help`
  (règle pure et testée dans CairnCore). Aucun `Picker(.segmented)` : les groupes de boutons utilisent `TabBar`
  (« Public  Personnel ») ; en-tête de détail = menu « … » (destructif en rouge, en dernier), « Gérer », action principale.

## 2026-11-08 — CHANGELOG rédigé à la main
- Erreur : la section `[Unreleased]` du CHANGELOG était rédigée à la main (commits `docs(changelog): …`), alors que
  semantic-release génère le CHANGELOG et la release GitHub.
- Règle : ne jamais modifier `CHANGELOG.md` ; la note de release vient des sujets des commits `feat`/`fix`/`perf`,
  qu'il faut donc écrire comme des lignes lisibles par un utilisateur.

## 2026-11-09 — `git push -u` réécrit par rtk : poussé sur `main`
- Erreur : `git push -u origin fix/…` passe par le hook rtk, qui prend `-u` pour son option `--ultra-compact`, jette
  les arguments et lance un `git push` nu. La branche (créée par `git worktree add -b … origin/main`) suivait
  `origin/main` : le commit est parti directement sur `main`, sans PR.
- Règle : pousser avec `rtk proxy git push --set-upstream origin <branche>` (jamais `-u`), et créer une branche de
  correctif avec `--no-track` (`git worktree add --no-track -b <branche> <dossier> origin/main`) pour qu'un push nu
  ne vise jamais `main`. Vérifier `git ls-remote origin main <branche>` juste après.

## 2026-11-08 — Deux rendus de groupe de boutons, menus déroulants
- Erreur : onglets de page (Explorateur / Nettoyable…) rendus avec `TabBar` (texte gris, pilule grise), alors que
  Codex a deux rendus : la bascule « Chat / Work » pour les onglets d'une page, le groupe sans conteneur dans une
  carte ou un tableau (fréquence, rétention). Menus « … » et listes déroulantes laissés au menu natif de macOS.
- Règle : onglets d'une page → `PillPicker` ; choix dans une carte ou un tableau → `TabBar`. Tout menu passe par
  `PopupMenuButton` (panneau blanc arrondi, icône + texte, séparateurs, destructif en rouge) ; aucun `Menu` natif,
  aucun `.bordered` / `.borderedProminent` (boutons `.pill*`).

## 2026-11-08 — Adresse SMB sans partage
- Erreur : `smb://syno` refusé (« n'est pas une adresse de partage ») alors que l'utilisateur ne connaît que l'hôte.
- Règle : une adresse réduite à l'hôte liste les dossiers partagés (`smbutil view`, mot de passe sur l'entrée
  standard) ; le partage choisi reçoit un dossier `cairn` pour les sauvegardes.

## 2026-11-09 — Pousser sans rebaser
- Erreur : branche poussée alors que `main` avait avancé (release 0.6.1), sans rebase préalable.
- Règle : avant chaque push, `git fetch origin` puis `git rebase origin/main`, tests relancés, puis
  `rtk proxy git push --force-with-lease`. Jamais de push d'une branche en retard sur `main`.

## 2026-11-09 — Tests lancés pour un changement simple
- Erreur : suite complète relancée pour une simple résolution de conflit (deux blocs de clés de traduction gardés
  côte à côte), alors qu'elle prend près d'une minute.
- Règle : pas de `just test` pour un changement simple (fusion de textes, doc, renommage local) : une vérification
  ciblée suffit (doublons de clés, `swift build` si du code change). Garder la suite complète pour un changement de
  code qui peut casser un comportement.
