# Spec Delta

## MODIFIED Requirements

### Requirement: Chiffrement
Une destination SHALL pouvoir être chiffrée (activé par défaut). Les données sont alors écrites dans une image disque chiffrée en AES-256 sur la destination, dont le mot de passe est dans le Trousseau de ce Mac. Sans chiffrement, Cairn MUST avertir que des secrets du home seront stockés en clair.

À l'ajout d'une destination chiffrée, l'utilisateur SHALL choisir le mot de passe de l'image : Cairn propose un mot de passe généré, que l'utilisateur peut garder ou remplacer, et le nouveau mot de passe MUST être saisi deux fois et compter au moins 12 caractères. Le mot de passe de l'image MUST NOT être écrit sur la destination, dans `config.toml`, dans les journaux ni dans l'état de Cairn.

#### Scenario: Destination chiffrée
- **WHEN** une sauvegarde vers une destination chiffrée se termine
- **THEN** la destination ne contient qu'une image chiffrée, illisible sans le mot de passe

#### Scenario: Désactivation du chiffrement
- **WHEN** l'utilisateur désactive le chiffrement sur une destination alors que `~/.ssh` est sélectionné
- **THEN** Cairn affiche un avertissement et demande une confirmation explicite

#### Scenario: Mot de passe choisi à l'ajout
- **WHEN** l'utilisateur ajoute une destination chiffrée en remplaçant le mot de passe proposé par le sien, saisi deux fois à l'identique
- **THEN** la première sauvegarde crée l'image avec ce mot de passe, et le Trousseau de ce Mac le contient

#### Scenario: Confirmation différente
- **WHEN** les deux saisies du mot de passe diffèrent, ou qu'il compte moins de 12 caractères
- **THEN** le bouton d'enregistrement reste désactivé et Cairn indique la raison sous le champ

#### Scenario: Aucun mot de passe hors du Trousseau
- **WHEN** une sauvegarde chiffrée se termine
- **THEN** ni la destination, ni `~/.cairn` (configuration, journaux, état) ne contiennent le mot de passe de l'image

## ADDED Requirements

### Requirement: Mot de passe de l'image retrouvable
La page d'une destination chiffrée SHALL permettre d'afficher et de copier le mot de passe de l'image de ce Mac à tout moment. L'affichage et la copie MUST être précédés d'une authentification de l'utilisateur sur ce Mac (Touch ID ou mot de passe de session). Le mot de passe affiché est masqué de nouveau quand l'utilisateur quitte la page.

#### Scenario: Afficher le mot de passe
- **WHEN** l'utilisateur clique « Afficher le mot de passe » sur la page d'une destination chiffrée et s'authentifie
- **THEN** Cairn affiche le mot de passe de l'image et un bouton pour le copier

#### Scenario: Authentification annulée
- **WHEN** l'utilisateur annule l'authentification
- **THEN** le mot de passe reste masqué et rien n'est copié

#### Scenario: Mot de passe absent du Trousseau
- **WHEN** l'image existe mais que son mot de passe n'est pas dans le Trousseau de ce Mac
- **THEN** Cairn indique que le mot de passe n'est pas connu sur ce Mac et propose de le saisir ; il n'est enregistré qu'après avoir ouvert l'image avec succès

### Requirement: Changement du mot de passe de l'image
La page d'une destination chiffrée SHALL permettre de changer le mot de passe de l'image existante sans recopier les données. Cairn MUST vérifier que l'ancien mot de passe ouvre l'image, et MUST NOT remplacer le mot de passe du Trousseau avant que l'image ait accepté le nouveau. Le changement est impossible pendant une sauvegarde, une vérification ou une restauration, et quand la destination est injoignable.

#### Scenario: Changement réussi
- **WHEN** l'utilisateur saisit deux fois un nouveau mot de passe d'au moins 12 caractères et confirme
- **THEN** l'image s'ouvre avec le nouveau mot de passe et plus avec l'ancien, le Trousseau contient le nouveau, et les versions existantes restent lisibles

#### Scenario: Échec du changement
- **WHEN** l'image refuse le changement (destination coupée, image occupée)
- **THEN** l'ancien mot de passe ouvre toujours l'image, le Trousseau n'est pas modifié, et Cairn affiche l'erreur

#### Scenario: Opération en cours
- **WHEN** une sauvegarde est en cours sur cette destination
- **THEN** l'action « Changer le mot de passe » est désactivée avec la raison

#### Scenario: Confirmation remise à zéro
- **WHEN** le mot de passe vient d'être changé
- **THEN** l'avertissement « mot de passe non rangé » réapparaît jusqu'à une nouvelle confirmation

### Requirement: Avertissement tant que le mot de passe n'est pas rangé
Tant que l'utilisateur n'a pas confirmé avoir rangé le mot de passe de l'image ailleurs que sur ce Mac, Cairn SHALL afficher un avertissement sur la page de la destination, dans l'accueil et dans la barre de menus. La confirmation est propre à chaque destination et à chaque Mac. La fenêtre affichée à la création de l'image SHALL proposer cette confirmation.

#### Scenario: Image créée
- **WHEN** la première sauvegarde crée l'image chiffrée
- **THEN** Cairn affiche le mot de passe avec « Copier » et « Je l'ai rangé hors de ce Mac », et l'avertissement reste affiché si l'utilisateur ferme la fenêtre sans confirmer

#### Scenario: Confirmation
- **WHEN** l'utilisateur confirme « Je l'ai rangé hors de ce Mac »
- **THEN** l'avertissement disparaît de la page de la destination, de l'accueil et de la barre de menus

#### Scenario: Image existante d'avant ce changement
- **WHEN** Cairn démarre avec une destination chiffrée dont l'image existe et qui n'a jamais été confirmée
- **THEN** l'avertissement s'affiche
