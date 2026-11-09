# Proposal

## Why

Le mot de passe d'une image chiffrée n'existe que dans le Trousseau local du Mac qui l'a créée : il est généré au hasard, montré une seule fois, et l'entrée n'est pas synchronisée par iCloud. Si ce Mac est perdu et que le mot de passe n'a pas été noté, toutes les sauvegardes de la destination deviennent illisibles. La synchronisation iCloud n'est pas possible aujourd'hui : un élément synchronisable du Trousseau exige une app signée avec un identifiant d'équipe Apple, alors que Cairn est signé en ad hoc.

## What Changes

- À la création d'une destination chiffrée, l'utilisateur **choisit le mot de passe de l'image** (avec confirmation). Cairn propose un mot de passe généré, modifiable.
- La page d'une destination chiffrée permet d'**afficher et de copier le mot de passe** de l'image à tout moment, après authentification de l'utilisateur sur ce Mac (Touch ID ou mot de passe de session).
- La page permet de **changer le mot de passe d'une image existante** sans recopier les données. Le Trousseau n'est mis à jour qu'une fois le changement accepté par l'image.
- Cairn **avertit** sur la page de la destination, dans l'accueil et la barre de menus tant que l'utilisateur n'a pas confirmé avoir rangé le mot de passe ailleurs que sur ce Mac (gestionnaire de mots de passe, papier).
- La fenêtre « Image chiffrée créée » renvoie vers cette confirmation au lieu d'être la seule occasion de voir le mot de passe.
- Le mot de passe de l'image MUST NOT être écrit sur la destination (NAS, disque), ni dans `config.toml`, les journaux ou l'état.

Hors du périmètre : la synchronisation iCloud automatique du Trousseau, qui fera l'objet d'un second changement (signature de Cairn avec un compte Apple Developer, puis mot de passe rangé dans le Trousseau iCloud) ; ce changement-ci reste utile ensuite comme secours. Aussi hors du périmètre : l'affichage du mot de passe en ligne de commande et les destinations non chiffrées.

## Capabilities

### New Capabilities

Aucune.

### Modified Capabilities

- `backup` : l'exigence « Chiffrement » change (mot de passe choisi, retrouvable, modifiable) et une exigence est ajoutée pour l'avertissement tant que le mot de passe n'est pas rangé hors du Mac.

## Impact

- `CairnCore/Providers.swift` (`SparseImage`) : création avec un mot de passe fourni (déjà possible), nouveau changement de mot de passe (`hdiutil chpass`).
- `CairnCore/Retention.swift` (`RunState`) : date de confirmation du mot de passe rangé, par destination.
- `Cairn/DestinationForm.swift` : champs mot de passe et confirmation pour une nouvelle destination chiffrée.
- `Cairn/BackupView.swift` : section « Mot de passe de l'image » (afficher, copier, changer, confirmer) et bannière d'avertissement ; fenêtre « Image chiffrée créée ».
- Accueil et barre de menus : signal d'avertissement.
- Authentification locale avec le framework `LocalAuthentication` (sans droit particulier, compatible avec la signature ad hoc).
- Textes en-US et fr-FR, tests `CairnSelfTest`.
