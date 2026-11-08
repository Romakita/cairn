# menu-bar Specification

## Purpose
Donne un accès permanent à Cairn depuis la barre des menus de macOS, comme Slack : un résumé de l'état du stockage et des sauvegardes, et les actions courantes, sans ouvrir la fenêtre principale.

## Requirements

### Requirement: Icône dans la barre des menus
Quand le fonctionnement en tâche de fond est accepté, Cairn SHALL afficher une icône dans la barre des menus, même fenêtre fermée. L'icône MUST refléter l'état global : normal, sauvegarde en cours (animée), attention (disque presque plein, destination en attente depuis plus d'un jour, version abîmée) ou erreur.

#### Scenario: Sauvegarde en cours
- **WHEN** une sauvegarde est en cours
- **THEN** l'icône montre une animation de progression

#### Scenario: Disque presque plein
- **WHEN** un volume suivi passe sous le seuil d'alerte
- **THEN** l'icône passe à l'état « attention »

### Requirement: Résumé du stockage
Un clic sur l'icône SHALL ouvrir un panneau qui présente :
- pour chaque volume contenant un dossier suivi, une jauge de remplissage avec l'espace libre ;
- l'espace récupérable (régénérable, worktrees obsolètes, corbeille du volume) ;
- l'état des sauvegardes : dernière réussite, prochaine échéance, destination en attente ;
- les alertes en cours.

Les chiffres MUST venir de la dernière analyse, avec sa date, sans lancer d'analyse complète à l'ouverture du panneau.

#### Scenario: Ouverture du panneau
- **WHEN** l'utilisateur clique sur l'icône
- **THEN** le panneau s'affiche en moins d'une demi-seconde avec la jauge du volume `workspaces`, l'espace récupérable et la date de la dernière sauvegarde

#### Scenario: Analyse ancienne
- **WHEN** la dernière analyse date de plus de 7 jours
- **THEN** le panneau l'indique et propose de relancer l'analyse

### Requirement: Actions rapides
Le panneau SHALL proposer les actions suivantes :
- Nettoyer, qui ouvre l'écran Nettoyable de l'app ;
- Sauvegarder maintenant ;
- Analyser ;
- Ouvrir Cairn ;
- Réglages ;
- Quitter.

Le panneau MUST NOT exécuter lui-même d'action destructive : le nettoyage passe toujours par la confirmation habituelle de l'app.

#### Scenario: Nettoyer depuis le panneau
- **WHEN** l'utilisateur clique « Nettoyer » dans le panneau
- **THEN** la fenêtre de Cairn s'ouvre sur l'écran Nettoyable, avec les éléments récupérables présélectionnés, et rien n'est supprimé avant confirmation

#### Scenario: Sauvegarder maintenant
- **WHEN** l'utilisateur clique « Sauvegarder maintenant » alors qu'aucune sauvegarde n'est en cours
- **THEN** une sauvegarde démarre et sa progression s'affiche dans le panneau

### Requirement: Présentation du panneau
Le panneau SHALL avoir sa propre présentation, plus visuelle que la fenêtre principale : jauges circulaires, chiffres en grand, cartes arrondies et boutons d'action pleine largeur. Il suit les modes clair et sombre et la langue active.

#### Scenario: Mode sombre
- **WHEN** macOS est en mode sombre
- **THEN** le panneau s'affiche en sombre, avec des jauges lisibles
