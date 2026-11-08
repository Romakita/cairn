# Proposal

## Why

L'accueil de Cairn est aujourd'hui une barre de recherche, quatre raccourcis et trois chiffres. Il ne dit pas si
tout va bien, ni quoi faire en premier. Il est aussi en retard sur l'app : la carte « Dernière sauvegarde » annonce
que « les sauvegardes arrivent dans une prochaine version » alors qu'elles existent, et Git ou les outils IA n'y
apparaissent pas. L'idée, inspirée des tableaux de bord d'antivirus comme Avast mais dans le design de Codex : un
**hub** qui donne l'état de chaque module en un coup d'œil, avec une action par module et un bouton pour tout
vérifier.

## What Changes

- **État global en tête** : un titre qui résume la situation (« Tout est en ordre », « 2 points à regarder »,
  « Un problème à corriger »), la liste courte des causes et l'heure de la dernière vérification.
- **Bouton « Tout vérifier »** : lance en une fois, en lecture seule, l'analyse des dossiers suivis, la recherche du
  nettoyage git possible, la joignabilité des destinations et l'état de la dernière sauvegarde, avec une
  progression par module. Rien n'est supprimé ni sauvegardé.
- **Cartes de modules** : Stockage, Sauvegarde, Git, Outils IA et Restauration. Chacune montre un état (icône
  cerclée colorée), un chiffre ou une phrase clé et **une** action principale (Nettoyer, Sauvegarder maintenant,
  Optimiser, Voir, Restaurer) qui ouvre l'écran concerné.
- **Problème prioritaire** : un bandeau en bas d'écran montre le problème le plus urgent (disque critique,
  sauvegarde en échec, destination en attente depuis plus d'un jour, configuration invalide) avec un bouton
  « Résoudre » qui mène à l'endroit où le régler.
- **Activité récente** : les derniers événements (sauvegardes, nettoyages, alertes) sous les cartes, à la place de
  l'onglet « Activité ».
- Suppression de la barre de recherche et des raccourcis de l'accueil actuel (les actions passent dans les cartes)
  et de la carte « Dernière sauvegarde » obsolète.

## Capabilities

### New Capabilities

- `home-dashboard` : page d'accueil de l'app, état global, vérification complète, cartes de modules, problème
  prioritaire et activité récente.

### Modified Capabilities

Aucune. Les alertes de stockage continuent d'apparaître sur l'accueil comme le demande déjà `storage-alerts`.

## Impact

- App : réécriture de `HomeView` (`Cairn/Sources/Cairn/MainView.swift`) avec les composants de `Cairn/DESIGN.md`
  et de nouveaux composants de carte de module et de bandeau prioritaire.
- `AppModel` : état agrégé par module (réutilise `globalStatus`, `activeAlerts`, `summary`, `RunState`,
  `destinationWaiting`, `gitReports`, `aiStats`) et orchestration de « Tout vérifier » (pool de workers git existant).
- `CairnCore` : fonction pure qui classe les problèmes par priorité, testée dans `CairnSelfTest`.
- Traductions en-US et fr-FR ; captures `--snapshot` de l'accueil mises à jour.
