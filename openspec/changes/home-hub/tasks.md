# Tasks

## 1. État du hub (CairnCore)

- [ ] 1.1 Créer `HubState.swift` : types `Issue` (genres ordonnés par priorité), `ModuleState`, `HubState` et la fonction pure `HubState.make(...)`
- [ ] 1.2 Calculer l'état de chaque module (Stockage, Sauvegarde, Git, Outils IA, Restauration) à partir des données existantes, avec l'état « pas encore analysé »
- [ ] 1.3 Créer `ActivityLog.swift` : écriture JSON par ligne dans `~/.cairn/state/activity.jsonl`, plafond de 200 lignes, lecture des N dernières
- [ ] 1.4 Persister l'heure de la dernière vérification dans `~/.cairn/state/hub.json`

## 2. Tests (CairnSelfTest)

- [ ] 2.1 Suite `Hub` enregistrée dans `main.swift` : ordre de priorité des problèmes et choix du problème prioritaire
- [ ] 2.2 Cohérence entre `HubState.overall` et le calcul de `globalStatus` sur les mêmes entrées
- [ ] 2.3 États des modules : aucune destination, sauvegarde réussie, sauvegarde en échec, git jamais analysé
- [ ] 2.4 `ActivityLog` : ordre du plus récent au plus ancien, plafond de 200 lignes, fichier absent

## 3. Journalisation des événements

- [ ] 3.1 Écrire un événement à la fin d'une sauvegarde (réussite ou échec) dans `BackupService`
- [ ] 3.2 Écrire un événement après un nettoyage confirmé et après une alerte de stockage envoyée
- [ ] 3.3 Écrire un événement à la fin d'une vérification complète

## 4. Vérification complète (AppModel)

- [ ] 4.1 `checkEverything()` : analyse des dossiers suivis, analyse git en simulation via `GitWorkerPool`, joignabilité des destinations sans montage, relecture de `RunState` et des stats IA
- [ ] 4.2 État de progression par module et annulation (`Arrêter`) qui conserve l'état précédent des modules non terminés
- [ ] 4.3 Vérifier qu'aucun chemin de `checkEverything()` n'appelle de suppression, de nettoyage ou de sauvegarde

## 5. Interface de l'accueil

- [ ] 5.1 En-tête : icône et titre d'état, causes (3 au plus puis « et N autres »), heure de dernière vérification, bouton « Tout vérifier » / « Arrêter »
- [ ] 5.2 Composant `ModuleCard` (icône cerclée au ton du module, chiffre clé, détail, action `.pillOutline`, progression) et grille adaptative des 5 modules
- [ ] 5.3 Bandeau du problème prioritaire fixé en bas avec « Résoudre » et sa navigation (nettoyage présélectionné, sauvegarde, réglages, destination)
- [ ] 5.4 Section « Activité récente » (10 événements, état vide)
- [ ] 5.5 Retirer l'ancienne barre de recherche, les raccourcis, les onglets « Vue d'ensemble / Activité » et la carte de sauvegarde obsolète ; déplacer les alertes de volume dans la carte Stockage et le bandeau
- [ ] 5.6 Traductions en-US et fr-FR ; retirer les clés obsolètes de l'ancien accueil

## 6. Vérification

- [ ] 6.1 `just test` passe, dont `L10n.no_untranslated_ui_strings`
- [ ] 6.2 Captures `Cairn --snapshot` de l'accueil (en ordre, attention, erreur) en clair et en sombre, en fr et en en
- [ ] 6.3 Essai réel : « Tout vérifier » puis « Arrêter », et contrôle que rien n'est supprimé (comparaison `du -sk` et `git branch` avant / après)
- [ ] 6.4 `just storage-install` puis contrôle de l'accueil dans l'app installée
- [ ] 6.5 `openspec validate home-hub` puis `/opsx:verify`

## Workflow follow-up

- Archiver `cairn-integration-scripts` avant celui-ci (les capacités `storage-alerts` et `menu-bar` y sont créées).
