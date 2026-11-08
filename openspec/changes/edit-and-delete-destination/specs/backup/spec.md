# Spec Delta

## ADDED Requirements

### Requirement: Modification d'une destination
Depuis la page d'une destination, Cairn SHALL permettre de modifier sa connexion (adresse, identifiant, mot de passe, dossier) avec le formulaire d'ajout prérempli. L'enregistrement MUST rester impossible tant que la nouvelle vérification n'a pas réussi. Le type, le chiffrement, la rétention et l'historique de la destination sont conservés ; le mot de passe n'est écrit que dans le Trousseau.

#### Scenario: Mot de passe manquant corrigé
- **WHEN** la dernière sauvegarde a échoué faute de mot de passe dans le Trousseau, et l'utilisateur ouvre « Modifier », saisit le mot de passe, vérifie puis enregistre
- **THEN** le mot de passe est rangé dans le Trousseau pour l'hôte et l'identifiant, `config.toml` n'en contient aucune trace, et la prochaine sauvegarde monte le partage

#### Scenario: Mot de passe laissé vide
- **WHEN** l'utilisateur modifie seulement le dossier d'un NAS sans saisir de mot de passe
- **THEN** la vérification utilise le mot de passe déjà présent dans le Trousseau, et le Trousseau n'est pas modifié

#### Scenario: Modification non vérifiée
- **WHEN** l'utilisateur change l'adresse puis tente d'enregistrer sans vérifier
- **THEN** « Enregistrer » reste indisponible et `config.toml` n'est pas modifié

#### Scenario: Modification abandonnée
- **WHEN** l'utilisateur vérifie une nouvelle adresse puis ferme la feuille par « Annuler »
- **THEN** la configuration et le Trousseau sont inchangés, et ce que Cairn a monté pour vérifier est démonté

#### Scenario: Historique conservé
- **WHEN** l'utilisateur enregistre une modification de la destination `main`
- **THEN** la destination garde l'identifiant `main`, sa rétention, son chiffrement, l'état de ses dernières sauvegardes et le mot de passe de son image

### Requirement: Suppression d'une destination
Cairn SHALL permettre de supprimer une destination après une confirmation explicite. Par défaut, les sauvegardes restent sur la destination ; l'utilisateur MAY choisir de supprimer aussi les sauvegardes de ce Mac. Une simulation MUST lister ce qui serait supprimé, avec la taille, avant toute suppression. Les sauvegardes des autres Mac ne sont jamais touchées.

#### Scenario: Suppression en gardant les sauvegardes
- **WHEN** l'utilisateur supprime la destination en laissant l'option par défaut et confirme
- **THEN** la destination disparaît de `config.toml` et de l'état des sauvegardes, rien n'est effacé sur la destination, et le mot de passe de l'image reste dans le Trousseau pour une restauration future

#### Scenario: Simulation de la suppression des sauvegardes
- **WHEN** l'utilisateur choisit de supprimer aussi les sauvegardes et lance la simulation
- **THEN** Cairn liste l'image ou le dossier de ce Mac sur la destination avec sa taille, et les éléments retirés de la configuration et du Trousseau, sans rien supprimer

#### Scenario: Suppression des sauvegardes confirmée
- **WHEN** l'utilisateur confirme la suppression avec les sauvegardes après la simulation
- **THEN** les sauvegardes de ce Mac sont supprimées de la destination, puis la destination est retirée de la configuration et le mot de passe de l'image du Trousseau ; le mot de passe du partage, partagé avec le Finder, est conservé

#### Scenario: Destination injoignable
- **WHEN** l'utilisateur demande la suppression des sauvegardes et la destination ne répond pas
- **THEN** la simulation indique que les sauvegardes ne peuvent pas être supprimées, la confirmation reste indisponible pour ce choix, et la configuration est inchangée

#### Scenario: Échec pendant la suppression
- **WHEN** la suppression des sauvegardes échoue sur la destination
- **THEN** la destination reste dans la configuration et Cairn affiche la cause

#### Scenario: Sauvegarde en cours
- **WHEN** une sauvegarde ou une vérification est en cours
- **THEN** la suppression est refusée et Cairn indique qu'une opération est déjà en cours

### Requirement: Historique des sauvegardes chargé automatiquement
La page d'une destination SHALL afficher l'historique des sauvegardes de ce Mac (date, état, nom) et le charger seule à l'ouverture quand la destination est joignable, sans bloquer l'interface. La destination MUST être démontée après la lecture si Cairn l'a montée. Une destination injoignable affiche pourquoi la liste est absente.

#### Scenario: Ouverture de la page
- **WHEN** l'utilisateur ouvre la page d'une destination joignable
- **THEN** l'historique affiche un indicateur de chargement puis la liste, sans clic, et le partage monté pour la lire est démonté

#### Scenario: Destination injoignable
- **WHEN** l'utilisateur ouvre la page d'une destination injoignable
- **THEN** l'historique indique que la destination est injoignable et propose de réessayer, sans tentative de montage

#### Scenario: Après une sauvegarde
- **WHEN** une sauvegarde de cette destination se termine
- **THEN** l'historique est rechargé

### Requirement: Actions indisponibles désactivées
Sur la page d'une destination, chaque bouton d'action SHALL être désactivé quand son action ne peut pas aboutir, avec une bulle d'aide qui en donne la raison : destination injoignable, sauvegarde ou vérification en cours, ou aucune sauvegarde à vérifier.

#### Scenario: Aucune sauvegarde encore
- **WHEN** la destination n'a encore aucune sauvegarde
- **THEN** « Vérifier l'intégrité » et « Vérification complète » sont désactivés et leur bulle d'aide indique qu'il n'y a rien à vérifier

#### Scenario: Destination injoignable
- **WHEN** la destination ne répond pas
- **THEN** « Simuler », « Vérifier l'intégrité », « Vérification complète » et « Sauvegarder maintenant » sont désactivés et leur bulle d'aide indique que la destination est injoignable

#### Scenario: Sauvegarde en cours
- **WHEN** une sauvegarde est en cours
- **THEN** les vérifications et la simulation sont désactivées, et « Arrêter » remplace « Sauvegarder maintenant »
