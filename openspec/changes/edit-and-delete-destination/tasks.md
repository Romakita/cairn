# Tasks

## 1. CairnCore

- [ ] 1.1 `CairnConfig.Destination.updatingConnection(from:)` : recopie adresse/chemin et identifiant, garde id, type, chiffrement et rétention ; test `Destination.edit_keeps_identity` dans une nouvelle suite `DestinationEditTests`
- [ ] 1.2 `DestinationRemoval.plan` (simulation) : éléments retirés de la config, de l'état, du Trousseau, et sauvegardes de ce Mac sur la destination avec taille ; les images d'autres Mac jamais listées ; tests sur un dossier local (chiffré et non chiffré) et destination injoignable
- [ ] 1.3 `DestinationRemoval.execute` : verrou d'opération, sauvegardes d'abord, puis mot de passe de l'image et état ; échec sur la destination = rien d'autre retiré ; tests (suppression réelle dans un dossier temporaire, verrou déjà pris)
- [ ] 1.4 `BackupActions.availability` : raison de désactivation par action (injoignable, en cours, rien à vérifier) ; tests de chaque cas
- [ ] 1.5 Enregistrer la suite dans `Tests/CairnSelfTest/main.swift` et vérifier que `just test` passe

## 2. Interface

- [ ] 2.1 `DestinationFormModel(editing:)` et mode `editing` de `DestinationForm` (type masqué, chiffrement en lecture seule, mot de passe vide = Trousseau) ; feuille `EditDestinationSheet` avec « Enregistrer » disponible seulement après vérification ; `saveEditedDestination` (Trousseau seulement si saisi)
- [ ] 2.2 Feuille `DeleteDestinationSheet` : choix garder (défaut) / supprimer les sauvegardes, « Simuler » qui liste les éléments avec taille, bouton destructif après simulation, erreurs affichées ; `deleteDestination` retire la config et l'état, met à jour la sélection
- [ ] 2.3 En-tête de la page : bouton « Modifier » et menu « … » avec « Supprimer la destination… » ; boutons d'action désactivés avec bulle d'aide selon `BackupActions.availability`
- [ ] 2.4 Carte « Historique des sauvegardes » : chargement automatique à l'ouverture si joignable, indicateur de chargement, état injoignable avec « Réessayer », rechargement après une sauvegarde, démontage garanti
- [ ] 2.5 Cartes d'une même rangée à la même hauteur (`Card(fill:)`, `fixedSize` vertical) pour les trois cartes d'état et pour Historique / Rétention + Planification
- [ ] 2.6 Traductions en-US et fr-FR de toutes les nouvelles clés ; `L10n.no_untranslated_ui_strings` passe

## 3. Vérification

- [ ] 3.1 `Snapshot.swift` : rendus de la page Sauvegardes avec un historique de démonstration, de la feuille de modification et de la feuille de suppression (simulation affichée) ; images relues en clair et en sombre
- [ ] 3.2 `just test`, `openspec validate edit-and-delete-destination`, construction de l'app (`swift build`)

## Workflow follow-up

- Essais à la main sur le NAS réel : modifier le mot de passe de `syno`, supprimer en gardant puis en supprimant les sauvegardes (sur une destination de test).
- Archiver le changement après revue.
