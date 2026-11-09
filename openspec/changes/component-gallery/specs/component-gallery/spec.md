# Spec Delta

## Purpose

Permet de consulter, sans Xcode, chaque composant de l'interface de Cairn dans toutes ses variantes, thèmes et
langues, en direct ou sous forme d'images exportées, pour développer et relire le design system.

## ADDED Requirements

### Requirement: Registre de stories
Le système SHALL fournir un registre de stories : chaque story a un identifiant unique, un groupe, un titre et
construit un composant réutilisable dans une variante donnée, uniquement avec des données factices.

#### Scenario: Identifiants uniques
- **WHEN** le registre est chargé
- **THEN** aucun identifiant de story n'apparaît deux fois et chaque story appartient à un groupe non vide

#### Scenario: Chaque composant partagé est couvert
- **WHEN** un composant public de la bibliothèque de composants est listé
- **THEN** au moins une story le présente

#### Scenario: Aucun accès au disque de l'utilisateur
- **WHEN** une story est rendue
- **THEN** elle n'analyse, ne modifie ni ne supprime aucun fichier de l'utilisateur

### Requirement: Fenêtre catalogue
Le système SHALL ouvrir une fenêtre catalogue quand l'app est lancée avec l'option `--gallery`, avec la liste des
stories groupées et l'aperçu de la story sélectionnée. Sans cette option, l'app ne montre jamais le catalogue.

#### Scenario: Ouverture du catalogue
- **WHEN** l'utilisateur lance `cairn --gallery`
- **THEN** une fenêtre affiche les stories groupées et l'aperçu de la première story

#### Scenario: Lancement normal
- **WHEN** l'app est lancée sans `--gallery`
- **THEN** aucune entrée, menu ni fenêtre du catalogue n'est visible

### Requirement: Réglages d'aperçu
La fenêtre catalogue SHALL permettre de basculer l'aperçu entre clair et sombre, entre fr-FR et en-US, et de choisir
la largeur du cadre, sans relancer l'app.

#### Scenario: Bascule du thème
- **WHEN** l'utilisateur choisit le thème sombre
- **THEN** l'aperçu se redessine en sombre, le reste de la fenêtre gardant son apparence

#### Scenario: Bascule de la langue
- **WHEN** l'utilisateur choisit en-US
- **THEN** les textes de l'aperçu s'affichent en anglais

### Requirement: Contrôles de story
Une story SHALL pouvoir déclarer des contrôles simples (texte, booléen, nombre dans un intervalle, choix dans une
liste) que la fenêtre catalogue affiche et dont la modification met à jour l'aperçu immédiatement.

#### Scenario: Modification d'un contrôle
- **WHEN** l'utilisateur fait passer le contrôle « pourcentage » d'une jauge de 10 à 95
- **THEN** l'aperçu montre la jauge remplie à 95 %

#### Scenario: Story sans contrôle
- **WHEN** la story sélectionnée ne déclare aucun contrôle
- **THEN** le panneau des contrôles indique qu'il n'y a aucun réglage

### Requirement: Export statique
Le système SHALL, avec `--gallery-export <dossier>`, écrire une image PNG par story et par combinaison thème × langue,
plus un fichier `index.html` qui les présente groupées, puis se terminer sans ouvrir de fenêtre.

#### Scenario: Export complet
- **WHEN** l'utilisateur lance `cairn --gallery-export /tmp/gallery`
- **THEN** le dossier contient 4 images par story (clair/sombre × fr/en) et un `index.html` qui les référence toutes

#### Scenario: Écriture limitée au dossier demandé
- **WHEN** l'export s'exécute
- **THEN** il n'écrit qu'à l'intérieur du dossier demandé, qu'il crée au besoin

#### Scenario: Dossier manquant en argument
- **WHEN** l'utilisateur lance `cairn --gallery-export` sans dossier
- **THEN** la commande affiche son usage et se termine avec un code d'erreur

### Requirement: Textes du catalogue traduits
Les textes visibles du catalogue et des stories SHALL être traduits en fr-FR et en-US comme le reste de l'app.

#### Scenario: Aucune chaîne en dur
- **WHEN** le test de traduction parcourt les sources de l'app et de la bibliothèque de composants
- **THEN** il ne trouve aucune chaîne visible écrite en dur
