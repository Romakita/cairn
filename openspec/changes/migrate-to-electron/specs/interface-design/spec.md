# Spec Delta

## Purpose

Garantit une interface cohérente avec le design system de Codex sur tous les écrans de Cairn : mêmes jetons, mêmes composants, actions compréhensibles, en clair comme en sombre.

## ADDED Requirements

### Requirement: Jetons de design communs
Couleurs, typographie, rayons, espacements, ombres et durées d'animation MUST venir d'un jeu unique de jetons défini pour le thème clair et le thème sombre. Aucun écran ne SHALL utiliser une couleur ou une taille de titre hors de ces jetons.

#### Scenario: Thème sombre
- **WHEN** macOS passe en apparence sombre
- **THEN** tous les écrans, la barre des menus et la galerie suivent le thème sombre sans relancer l'app

#### Scenario: Couleur hors jeton
- **WHEN** un style utilise une couleur littérale hors du fichier des jetons
- **THEN** le contrôle automatique du style échoue

### Requirement: Bibliothèque de composants unique
Chaque élément d'interface (bouton, menu, onglets, champ, case, interrupteur, tableau, feuille, infobulle, badge, bandeau, graphique) MUST provenir de la bibliothèque de composants de Cairn. Aucun contrôle natif du navigateur ou du système ne SHALL être visible, hors dialogues système d'ouverture de fichier et d'autorisation.

#### Scenario: Menu d'une ligne
- **WHEN** l'utilisateur ouvre le menu « … » d'une destination, d'un dépôt ou d'un fichier
- **THEN** le menu est le menu de Cairn (icône et texte, séparateurs, action destructive en rouge et en dernier), jamais un menu contextuel natif

#### Scenario: Deux usages des onglets
- **WHEN** un écran propose des onglets de page et, dans une carte, un choix entre options
- **THEN** les onglets de page utilisent la bascule en pilule, et le choix dans la carte le groupe de boutons sans conteneur

### Requirement: Galerie des composants
Cairn SHALL fournir une galerie qui montre chaque composant avec ses variantes et ses états (normal, survol, désactivé, destructif, chargement), en clair et en sombre, et qui peut être exportée en images.

#### Scenario: Export de la galerie
- **WHEN** le développeur lance l'export de la galerie vers un dossier
- **THEN** une image par composant et par thème est écrite dans ce dossier avec une page d'index, et rien n'est écrit ailleurs

### Requirement: Action indisponible expliquée
Une action qui ne peut pas aboutir MUST être affichée désactivée, avec sa raison dans une infobulle. La raison vient des mêmes règles que celles de la ligne de commande.

#### Scenario: Vérifier sans sauvegarde
- **WHEN** une destination n'a encore aucune sauvegarde
- **THEN** « Vérifier l'intégrité » est désactivé et son infobulle indique qu'il n'y a rien à vérifier

#### Scenario: Sauvegarde en cours
- **WHEN** une sauvegarde est en cours et l'utilisateur survole « Installer la mise à jour »
- **THEN** le bouton est désactivé, l'infobulle l'explique, et le bouton se réactive dès la fin de la sauvegarde

### Requirement: Vocabulaire de l'utilisateur
Les textes visibles MUST décrire ce que voit et fait l'utilisateur, sans nom d'outil interne ni jargon (« rsync », « worker », « sparsebundle », « fetch »). Les badges et libellés d'un même type suivent la même casse.

#### Scenario: Comptage des fichiers
- **WHEN** Cairn compte les fichiers avant la copie
- **THEN** la progression affiche « Comptage des fichiers » et l'avancement de chaque compteur, sans mentionner rsync

### Requirement: Navigation cohérente
Chaque lien et chaque action de navigation MUST mener à un écran qui permet de faire ce qu'il annonce.

#### Scenario: Ajouter une destination depuis l'accueil
- **WHEN** l'utilisateur clique « Ajouter une destination » sur l'accueil
- **THEN** le formulaire d'ajout de destination s'ouvre

### Requirement: Vérification visuelle des écrans
Chaque écran MUST pouvoir être affiché avec des données d'exemple, sans toucher au disque de l'utilisateur, pour être capturé en clair et en sombre de façon automatique.

#### Scenario: Captures d'exemple
- **WHEN** le développeur lance la capture des écrans
- **THEN** une image par écran et par thème est produite à partir des données d'exemple, et aucune analyse ni sauvegarde réelle n'est lancée
