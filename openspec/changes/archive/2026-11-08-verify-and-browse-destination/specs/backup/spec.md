# Spec Delta

## ADDED Requirements

### Requirement: Ajout d'une destination vérifiée
Avant d'enregistrer une destination, dans l'assistant comme dans l'app, Cairn SHALL vérifier qu'elle est joignable, que les identifiants sont acceptés et que le dossier choisi accepte l'écriture. L'enregistrement MUST rester impossible tant que la vérification n'a pas réussi ; l'assistant garde l'option « Plus tard » pour avancer sans destination.

#### Scenario: NAS vérifié
- **WHEN** l'utilisateur saisit `smb://nas.local/backups`, un nom d'utilisateur et le bon mot de passe, puis lance la vérification
- **THEN** Cairn indique que la connexion a réussi avec l'espace libre du partage, et « Continuer » devient disponible

#### Scenario: Serveur injoignable
- **WHEN** l'hôte du NAS ne répond pas sur le port SMB en 3 secondes
- **THEN** Cairn affiche « Serveur injoignable » avec l'adresse essayée, et « Continuer » reste indisponible

#### Scenario: Mot de passe refusé
- **WHEN** le partage refuse les identifiants saisis
- **THEN** Cairn affiche « Identifiants refusés », met en évidence le champ du mot de passe, et rien n'est enregistré dans le Trousseau

#### Scenario: Dossier en lecture seule
- **WHEN** le dossier choisi n'accepte pas l'écriture
- **THEN** Cairn affiche « Dossier en lecture seule » et propose d'en choisir un autre

#### Scenario: Disque débranché pendant la saisie
- **WHEN** l'utilisateur a choisi un dossier sur un disque externe puis débranche le disque avant de continuer
- **THEN** la vérification précédente est annulée et Cairn demande de vérifier à nouveau

#### Scenario: Passer à plus tard
- **WHEN** la vérification échoue et l'utilisateur choisit « Plus tard » dans l'assistant
- **THEN** l'assistant continue sans destination et `config.toml` n'en contient aucune

### Requirement: Vérification sans trace sur la destination
La vérification MUST NOT laisser de trace : le seul fichier écrit est un fichier témoin supprimé aussitôt, et tout partage ou volume monté par Cairn pour vérifier ou parcourir est démonté quand le formulaire se ferme. Un mot de passe saisi n'est enregistré dans le Trousseau qu'à l'enregistrement de la destination.

#### Scenario: Partage monté pour vérifier
- **WHEN** Cairn monte `smb://nas.local/backups` pour vérifier puis l'utilisateur ferme le formulaire
- **THEN** le partage est démonté et ne contient aucun fichier nouveau

#### Scenario: Partage déjà monté par l'utilisateur
- **WHEN** le partage était déjà monté dans le Finder avant la vérification
- **THEN** Cairn l'utilise sans le démonter à la fermeture

#### Scenario: Assistant abandonné après vérification
- **WHEN** l'utilisateur vérifie un NAS puis ferme l'assistant sans terminer
- **THEN** aucun mot de passe n'est enregistré dans le Trousseau et aucun `config.toml` n'est écrit

### Requirement: Choix du dossier sur la destination
Cairn SHALL proposer un navigateur de dossiers pour choisir le dossier de sauvegarde sur la destination : fil d'Ariane, sous-dossiers du dossier courant, création d'un nouveau dossier. Pour un NAS, il parcourt le partage indiqué une fois connecté ; pour un dossier local, il part des volumes montés et du home. Le dossier choisi devient le chemin de la destination.

#### Scenario: Choix d'un sous-dossier sur le NAS
- **WHEN** l'utilisateur se connecte au partage `smb://nas.local/backups` puis ouvre le dossier `mac`
- **THEN** la destination enregistrée a pour adresse `smb://nas.local/backups/mac`

#### Scenario: Création d'un dossier
- **WHEN** l'utilisateur crée le dossier `Cairn` dans `/Volumes/Externe` depuis le navigateur
- **THEN** le dossier est créé, sélectionné, et la destination pointe vers `/Volumes/Externe/Cairn`

#### Scenario: Nom de dossier invalide
- **WHEN** l'utilisateur tente de créer un dossier dont le nom contient `/` ou existe déjà
- **THEN** Cairn refuse la création et explique pourquoi, sans rien écrire

#### Scenario: Sous-dossier illisible
- **WHEN** l'utilisateur ouvre un dossier dont il n'a pas le droit de lister le contenu
- **THEN** le navigateur affiche « Accès refusé » à cet endroit et permet de remonter

### Requirement: Sauvegardes existantes sur la destination
Quand le dossier choisi contient déjà des sauvegardes Cairn, le navigateur SHALL les signaler avec le nom de la machine de chaque sauvegarde, et l'assistant MUST proposer de restaurer plutôt que de créer une nouvelle configuration.

#### Scenario: Sauvegarde d'un autre Mac trouvée
- **WHEN** le dossier choisi contient `cairn-MacBook-Pro.sparsebundle`
- **THEN** le navigateur indique « Sauvegarde de MacBook-Pro trouvée » et l'assistant propose « Restaurer cette sauvegarde »

#### Scenario: Sauvegarde de ce Mac trouvée
- **WHEN** le dossier choisi contient déjà la sauvegarde de ce Mac
- **THEN** Cairn indique que les prochaines sauvegardes continueront cette image au lieu d'en créer une nouvelle
