# Spec Delta

## Purpose

Décrit la page d'accueil de Cairn : un hub qui montre l'état de chaque module, propose une action par module,
met en avant le problème le plus urgent et permet de tout vérifier en un clic, sans rien modifier.

## ADDED Requirements

### Requirement: État global en tête de l'accueil
L'accueil SHALL afficher en tête un titre qui résume l'état global (en ordre, points à regarder, problème à corriger), la liste des causes (trois au plus, puis « et N autres ») et l'heure de la dernière vérification. L'état MUST être le même que celui de l'icône de la barre des menus.

#### Scenario: Tout est en ordre
- **WHEN** aucun disque n'est sous le seuil, la dernière sauvegarde a réussi et la configuration est valide
- **THEN** l'accueil affiche « Tout est en ordre » avec l'heure de la dernière vérification

#### Scenario: Plusieurs points d'attention
- **WHEN** un disque est presque plein et une destination est en attente depuis 30 heures
- **THEN** l'accueil affiche « 2 points à regarder » et liste ces deux causes

#### Scenario: Configuration invalide
- **WHEN** `config.toml` contient une erreur de syntaxe
- **THEN** l'accueil affiche « Un problème à corriger » et la cause mentionne la ligne fautive

### Requirement: Vérification complète en lecture seule
L'accueil SHALL proposer un bouton « Tout vérifier » qui lance, en une fois, l'analyse des dossiers suivis, la recherche du nettoyage git possible, la joignabilité des destinations et la lecture de l'état des sauvegardes, avec une progression par module. Cette vérification MUST NOT supprimer, nettoyer ni sauvegarder quoi que ce soit.

#### Scenario: Vérification lancée
- **WHEN** l'utilisateur clique « Tout vérifier »
- **THEN** chaque carte de module affiche sa progression, puis son état mis à jour, et l'heure de dernière vérification change

#### Scenario: Aucune modification sur le disque
- **WHEN** la vérification se termine avec 12 Go de régénérable et 5 branches git supprimables
- **THEN** ces éléments sont signalés sur les cartes, et aucun fichier ni aucune branche n'est supprimé

#### Scenario: Vérification annulée
- **WHEN** l'utilisateur clique « Arrêter » pendant la vérification
- **THEN** les modules déjà vérifiés gardent leur nouvel état et les autres gardent l'état précédent

#### Scenario: Destination injoignable pendant la vérification
- **WHEN** le NAS ne répond pas pendant la vérification
- **THEN** la carte Sauvegarde indique « NAS injoignable » et la vérification des autres modules se poursuit

### Requirement: Cartes de modules
L'accueil SHALL présenter une carte par module : Stockage, Sauvegarde, Git, Outils IA, Restauration. Chaque carte affiche une icône cerclée dont la couleur suit l'état du module, un chiffre ou une phrase clé et une seule action principale, qui ouvre l'écran du module sans exécuter d'action destructive.

#### Scenario: Carte Stockage
- **WHEN** l'analyse a trouvé 12 Go régénérables sur le disque suivi
- **THEN** la carte Stockage affiche l'espace libre, « 12 Go récupérables » et l'action « Nettoyer », qui ouvre l'écran Nettoyable sans rien supprimer

#### Scenario: Carte Sauvegarde
- **WHEN** la dernière sauvegarde a réussi il y a 3 heures et la suivante est prévue à 12:30
- **THEN** la carte Sauvegarde affiche « Il y a 3 heures », « Prochaine à 12:30 » et l'action « Sauvegarder maintenant »

#### Scenario: Aucune destination
- **WHEN** aucune destination n'est configurée
- **THEN** la carte Sauvegarde est à l'état d'attention, affiche « Aucune destination » et l'action « Ajouter une destination »

#### Scenario: Module jamais analysé
- **WHEN** l'analyse git n'a jamais été lancée
- **THEN** la carte Git affiche « Pas encore analysé » et l'action « Analyser », sans lancer d'analyse à l'ouverture de l'accueil

### Requirement: Problème prioritaire
Quand au moins un problème est présent, l'accueil SHALL afficher un bandeau avec le problème le plus urgent et un bouton « Résoudre » qui mène là où il se règle. L'ordre de priorité MUST être : configuration invalide, sauvegarde en échec, disque critique, destination en attente depuis plus d'un jour, disque presque plein, dossier suivi indisponible.

#### Scenario: Deux problèmes simultanés
- **WHEN** la dernière sauvegarde a échoué et un disque est presque plein
- **THEN** le bandeau montre l'échec de sauvegarde, et l'alerte de disque reste visible sur la carte Stockage

#### Scenario: Résoudre un disque critique
- **WHEN** le bandeau montre un disque critique et l'utilisateur clique « Résoudre »
- **THEN** l'écran Nettoyable s'ouvre avec les éléments récupérables présélectionnés, et rien n'est supprimé avant confirmation

#### Scenario: Aucun problème
- **WHEN** l'état global est « en ordre »
- **THEN** aucun bandeau n'est affiché

### Requirement: Activité récente
L'accueil SHALL lister sous les cartes les derniers événements (sauvegardes réussies ou en échec, nettoyages, alertes de disque, vérifications), du plus récent au plus ancien, avec leur heure, dix au plus.

#### Scenario: Après une sauvegarde
- **WHEN** une sauvegarde vers le NAS vient de se terminer
- **THEN** l'événement « Sauvegarde vers syno réussie » apparaît en haut de l'activité récente avec son heure

#### Scenario: Première ouverture
- **WHEN** aucun événement n'a encore eu lieu
- **THEN** l'activité récente affiche « Rien à signaler pour l'instant »
