# Design

## Context

- `HomeView` (`Cairn/Sources/Cairn/MainView.swift`) : onglets « Vue d'ensemble / Activité », barre de recherche,
  quatre raccourcis et trois cartes (disque, dernière sauvegarde figée, récupérable). L'onglet Activité n'affiche que
  `model.lastMessage`.
- Données déjà disponibles dans `AppModel` : `globalStatus` (même calcul que la barre des menus), `diskAlert`,
  `activeAlerts`, `summary` (`AnalysisSummary` persistée), `runState` (`RunState` par destination : dernière
  réussite, erreur, attente), `destinationWaiting`, `gitReports`, `aiStats`, `configIssues`, `trackedFolders`.
- Les analyses git passent par `GitWorkerPool` ; l'analyse disque par `Scanner` (lecture seule).
- Aucun journal d'événements persistant n'existe (`RunState` ne garde que le dernier état).
- Design system : `Cairn/DESIGN.md` (cartes sans ombre, noir pour l'action principale, accent bleu).

## Goals / Non-Goals

**Goals:**
- Un état par module calculé à partir des données existantes, sans analyse lourde à l'ouverture de l'accueil.
- Une priorité des problèmes définie une fois, en logique pure testable, partagée par le bandeau et l'état global.
- Une vérification complète qui réutilise les analyses existantes et n'en ajoute aucune.

**Non-Goals:**
- Modifier le calcul de `globalStatus` ou le panneau de la barre des menus.
- Une recherche globale (la barre de recherche actuelle disparaît ; elle pourra revenir dans la barre latérale).
- Carrousel ou pagination des cartes (5 modules tiennent dans une grille).

## Decisions

### 1. `HubState` dans `CairnCore`
Une fonction pure `HubState.make(inputs) -> HubState` prend des valeurs simples (config, `RunState`, alertes,
résumé d'analyse, rapports git, stats IA, date courante) et renvoie :
- `overall` (`ok`, `attention`, `error`) et `causes: [Issue]` triées ;
- `modules: [ModuleState]` (id, ton, chiffre clé, détail, action) ;
- `topIssue: Issue?`.

`Issue` porte un genre (`configInvalid`, `backupFailed`, `diskCritical`, `destinationOverdue`, `diskLow`,
`folderUnavailable`) et ses paramètres ; l'ordre de l'énumération donne la priorité. Les libellés sont produits dans
l'app via `T()`. *Alternative écartée* : calculer dans la vue ; la priorité serait intestable et dupliquée.

`globalStatus` reste la source de vérité de l'icône ; un test vérifie que `HubState.overall` lui correspond sur les
mêmes entrées.

### 2. Vérification complète orchestrée par `AppModel`
`checkEverything()` lance en parallèle, avec un état par module (`idle`, `running`, `done`, `failed`) :
- l'analyse des dossiers suivis (`scan()` existant, lecture seule) ;
- l'analyse git en simulation (`GitMaintenance` via `GitWorkerPool`, aucune suppression) ;
- la joignabilité des destinations (`provider.isReachable()`, sans montage) ;
- la relecture de `RunState` et des stats IA.
Annulation via les `Task` en cours ; un module annulé garde son état précédent. L'heure de la dernière
vérification est persistée dans `~/.cairn/state/hub.json`.

### 3. Journal d'activité
`ActivityLog` dans `CairnCore` : fichier `~/.cairn/state/activity.jsonl`, une ligne JSON par événement (date, genre,
paramètres), 200 lignes au plus (les plus anciennes sont retirées à l'écriture). Écrit par `BackupService`
(réussite, échec), le nettoyage confirmé, les alertes de stockage et la vérification complète. L'accueil lit les 10
dernières. Aucun chemin de fichier personnel n'y est écrit au-delà des noms de dossiers suivis et de destinations.

### 4. Mise en page
```
┌────────────────────────────────────────────────────────────┐
│        [icône d'état]  Tout est en ordre                   │
│        Vérifié il y a 2 h · causes éventuelles             │
│                 [ Tout vérifier ]  (noir)                  │
├──────────┬──────────┬──────────┬──────────┬────────────────┤
│ Stockage │Sauvegarde│   Git    │ Outils IA│  Restauration  │
│  (◯)     │   (◯)    │   (◯)    │   (◯)    │     (◯)        │
│ 25 Go    │ Il y a 3h│ 5 branch.│ 3 outils │ 2 versions     │
│ [Nettoy.]│[Sauveg.] │[Optimis.]│ [Voir]   │ [Restaurer]    │
└──────────┴──────────┴──────────┴──────────┴────────────────┘
  Activité récente (Card + SettingsRow)
╔ bandeau prioritaire fixé en bas : icône, texte, [Résoudre] ╗
```
- Cartes : `Card` avec `IconTile` cerclé (anneau de couleur du ton, comme la jauge d'Avast mais en trait fin),
  chiffre en 22 pt, détail en `secondary`, bouton `.pillOutline` en bas. Grille adaptative (`LazyVGrid`,
  minimum 180 pt) pour tenir de 1100 pt de large à plein écran.
- Bandeau : `Banner` du ton du problème, fixé en bas de la zone de contenu, bouton `.pillPrimary` « Résoudre ».
- Couleur (retour de l'utilisateur, plus de caractère à la Avast) : chaque module a une couleur d'identité
  (`Palette.module`) qui teinte une grande tuile d'icône centrée (64 pt) et un mini-graphique (jauge d'occupation,
  7 pastilles des derniers jours de sauvegarde tirées du journal d'activité, barre branches / worktrees, poids des
  outils IA) ; l'état du module est un `Badge` en haut à droite de la carte. L'en-tête garde un cercle au ton de
  l'état global. Cinq cartes sur une ligne si la largeur le permet, sinon trois colonnes.
- Les alertes de volume actuelles (`activeAlerts`) passent dans la carte Stockage et le bandeau ; elles ne sont
  plus empilées en haut de page.

### 5. Actions des cartes
Chaque action ne fait que naviguer (`model.section`, `analysisTab`, présélection du nettoyage) ou lancer une
sauvegarde, comme les actions rapides du panneau de la barre des menus. Aucune action destructive n'est exécutée
depuis l'accueil.

## Risks / Trade-offs

- [« Tout vérifier » sur de gros dossiers prend plusieurs minutes] → progression par carte, bouton « Arrêter »,
  l'accueil reste utilisable ; les cartes affichent l'état précédent tant que le module n'a pas fini.
- [L'analyse git sur beaucoup de dépôts charge la machine] → pool de workers existant et sa limite de parallélisme.
- [Le journal d'activité grossit] → plafond de 200 lignes, purge à l'écriture.
- [Disparition de la recherche sur l'accueil] → peu utilisée ; à réintroduire ailleurs si besoin (hors périmètre).

## Migration Plan

Pas de migration de données : `activity.jsonl` et `hub.json` sont créés au premier événement. Les clés de
traduction obsolètes de l'ancien accueil (`home.search`, `home.backup_soon`, `home.title`…) sont retirées dans le
même changement.
