# Proposal

## Why

La page Sauvegardes affiche la configuration d'une destination sans permettre de la corriger ni de la retirer : un
mot de passe absent du Trousseau (« Aucun mot de passe dans le Trousseau pour « main » ») laisse la destination
bloquée sans autre recours que d'éditer `config.toml`. La carte « Versions » demande un clic pour se remplir, les
cartes d'une même rangée n'ont pas la même hauteur, et les boutons d'action restent actifs même quand leur action
ne peut pas aboutir (rien à vérifier, destination injoignable).

## What Changes

- Modifier une destination depuis sa page : même formulaire que l'ajout (adresse, identifiant, mot de passe,
  dossier), prérempli, avec une nouvelle vérification obligatoire avant l'enregistrement. Le mot de passe va dans le
  Trousseau, jamais dans `config.toml`. L'identifiant interne, le type, le chiffrement et la rétention sont conservés.
- Supprimer une destination : confirmation explicite, choix entre garder les sauvegardes sur la destination (par
  défaut) ou les supprimer, et une simulation qui liste ce qui serait supprimé (avec la taille) avant toute action.
- La carte « Versions » devient « Historique des sauvegardes » : la liste se charge seule à l'ouverture de la page
  quand la destination est joignable, en arrière-plan, et la destination est démontée ensuite.
- Les boutons « Simuler », « Vérifier l'intégrité », « Vérification complète » et « Sauvegarder maintenant » sont
  désactivés quand leur action ne peut pas aboutir, avec une bulle d'aide qui dit pourquoi.
- Mise en page : les cartes d'une même rangée partagent la même hauteur.

## Capabilities

### New Capabilities

Aucune.

### Modified Capabilities

- `backup` : ajout des exigences « Modification d'une destination », « Suppression d'une destination »,
  « Historique des sauvegardes chargé automatiquement » et « Actions indisponibles désactivées ».

## Impact

- `Cairn/Sources/CairnCore` : nouveau `DestinationRemoval.swift` (plan de suppression, simulation, exécution) et
  fonction de mise à jour d'une destination modifiée ; tests dans `Tests/CairnSelfTest`.
- `Cairn/Sources/Cairn/BackupView.swift` (en-tête, cartes, historique), `DestinationForm.swift` (préremplissage,
  feuille de modification), nouvelle feuille de suppression, `Snapshot.swift` (rendus).
- Traductions `en.lproj` et `fr.lproj`.
- Hors périmètre : l'échec de copie de `state_5.sqlite` (traité ailleurs), la page d'accueil, une commande CLI de
  suppression de destination.
