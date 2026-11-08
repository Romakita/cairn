# storage-alerts Specification

## Purpose
Prévient avant que le disque ne soit plein, au bon moment et sans harceler, en proposant directement de quoi libérer de l'espace.

## Requirements

### Requirement: Surveillance de l'espace libre
Tant que Cairn tourne, il SHALL surveiller l'espace libre de chaque volume qui contient un dossier suivi : toutes les 15 minutes, ainsi qu'après chaque analyse, sauvegarde ou nettoyage. La surveillance MUST lire seulement la capacité du volume, sans parcourir les fichiers.

#### Scenario: Volume surveillé
- **WHEN** `/Volumes/workspaces` est suivi
- **THEN** son espace libre est relevé toutes les 15 minutes et enregistré dans l'état de Cairn, avec l'historique des 30 derniers jours

### Requirement: Seuils d'alerte
Cairn SHALL considérer un volume comme presque plein quand son espace libre passe sous 10 % de sa capacité ou sous 20 Go, selon la première limite atteinte. Il le considère comme critique sous 5 % ou 5 Go. Les seuils sont réglables dans `config.toml`.

#### Scenario: Passage sous 10 %
- **WHEN** l'espace libre de `workspaces` passe de 11 % à 9 %
- **THEN** une alerte « presque plein » est émise

### Requirement: Prévision de remplissage
À partir de l'historique de l'espace libre, Cairn SHALL estimer la date à laquelle le volume serait plein au rythme des 7 derniers jours. Il MUST émettre une alerte anticipée si cette date arrive dans moins de 7 jours, même au-dessus des seuils.

#### Scenario: Remplissage rapide
- **WHEN** un volume perd 5 Go par jour depuis une semaine et qu'il lui reste 30 Go
- **THEN** une alerte annonce qu'il sera plein dans environ 6 jours

### Requirement: Notifications sans harcèlement
Les alertes SHALL être envoyées comme notifications macOS, au plus une par volume et par jour. Une nouvelle notification n'est envoyée plus tôt que si le volume passe au niveau critique. Un volume revenu au-dessus du seuil avec une marge de 2 points remet le compteur à zéro. L'utilisateur MUST pouvoir mettre en sourdine les alertes d'un volume pendant 7 jours depuis la notification.

#### Scenario: Oscillation autour du seuil
- **WHEN** l'espace libre oscille entre 9,8 % et 10,2 % plusieurs fois dans la journée
- **THEN** une seule notification est envoyée ce jour-là

#### Scenario: Notifications refusées
- **WHEN** l'utilisateur a refusé les notifications de Cairn et qu'un volume passe sous le seuil
- **THEN** l'alerte apparaît dans le panneau de la barre des menus et sur l'accueil de l'app

#### Scenario: Passage critique
- **WHEN** une alerte « presque plein » a été envoyée le matin et que le volume passe sous 5 % l'après-midi
- **THEN** une notification « critique » est envoyée sans attendre le lendemain

### Requirement: Alertes utiles
Chaque notification SHALL indiquer l'espace libre restant et l'espace récupérable connu (régénérable, worktrees obsolètes, corbeille du volume, d'après la dernière analyse). Elle propose aussi l'action « Nettoyer », qui ouvre l'écran Nettoyable avec les plus gros éléments récupérables présélectionnés.

#### Scenario: Notification avec action
- **WHEN** l'utilisateur clique « Nettoyer » sur une alerte
- **THEN** Cairn ouvre l'écran Nettoyable, et rien n'est supprimé sans confirmation

#### Scenario: Corbeille du volume pleine
- **WHEN** la corbeille de `workspaces` contient 15 Go
- **THEN** la notification indique que vider la corbeille libérerait 15 Go
