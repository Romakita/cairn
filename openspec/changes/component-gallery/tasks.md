# Tasks

## 1. Bibliothèque CairnUI

- [x] 1.1 Avant tout déplacement, générer les captures de référence avec `Cairn --snapshot <scratch>/before` et les garder pour la comparaison du 1.6
- [x] 1.2 Ajouter la cible `CairnUI` (dépend de `CairnCore`) dans `Cairn/Package.swift`, faire dépendre `Cairn` et `CairnSelfTest` de `CairnUI`, et vérifier que `swift build --package-path Cairn` passe
- [x] 1.3 Déplacer `Theme.swift` dans `Sources/CairnUI/Theme/` (palette, `Color(light:dark:)`, style des catégories, `T`) en `public`, garder l'alias `Category` dans l'app, ajouter `import CairnUI` aux écrans, et vérifier que la compilation passe
- [x] 1.4 Déplacer les composants de `Components.swift` dans `Sources/CairnUI/Components/` (un fichier par famille, voir design), en `public` pour ce que l'app utilise, et vérifier que la compilation passe
- [x] 1.5 Déplacer `BreakdownBar`, `CategoryTag` et `BreakdownChart` dans `Sources/CairnUI/Components/Charts.swift`, laisser `ScanningView` dans l'app, et vérifier que la compilation passe
- [x] 1.6 Rendre le test `L10n.no_untranslated_ui_strings` récursif et y inclure `Sources/CairnUI`, puis vérifier : `just test` vert, `Cairn --snapshot <scratch>/after` identique à `before` (comparaison des PNG), `just storage-install` qui reconstruit l'app

## 2. Registre de stories

- [x] 2.1 Créer `Sources/CairnUI/Gallery/Story.swift` (`Story`, `StoryGroup`, `StoryControl`, `StoryValues`, `Stories.all`) et vérifier que la compilation passe
- [x] 2.2 Écrire les stories par groupe (`Stories+Buttons.swift`, `+Navigation`, `+Containers`, `+Feedback`, `+Fields`, `+Charts`, `+Brand`, `+Palette`) avec données factices et contrôles là où c'est utile (texte d'un `Badge`, pourcentage d'une `FillBar`, ton d'un `Banner`…) ; `PathField` sur un dossier temporaire factice, jamais le home
- [x] 2.3 Ajouter les clés `gallery.*` dans `en.lproj` et `fr.lproj` et vérifier que `L10n.catalogs_have_same_keys` et `L10n.no_untranslated_ui_strings` passent
- [x] 2.4 Ajouter la suite `GalleryTests` (identifiants uniques, groupes non vides, couverture de chaque `public struct … : View` de `Sources/CairnUI/Components`, rendu non vide en clair et sombre), l'enregistrer dans `main.swift` des tests, et vérifier `just test Gallery`

## 3. Fenêtre catalogue

- [x] 3.1 Créer `GalleryView` (liste groupée, aperçu, panneau de contrôles avec message « aucun réglage », bascules thème / langue / largeur) dans `Sources/CairnUI/Gallery/GalleryView.swift`
- [x] 3.2 Ajouter `GalleryApp` et l'aiguillage `--gallery` dans `Sources/Cairn/main.swift`, avant la ligne de commande ; vérifier que `Cairn --gallery` ouvre la fenêtre, que thème, langue, largeur et contrôles mettent l'aperçu à jour, et qu'un lancement normal n'affiche rien du catalogue
- [x] 3.3 Ajouter la recette `just gallery` et la documenter dans `Cairn/README.md` ; vérifier que la recette lance la fenêtre

## 4. Export statique

- [x] 4.1 Extraire le rendu hors écran de `Snapshot.render` dans une fonction partagée de `CairnUI` et faire appeler celle-ci par `Snapshot` ; vérifier que `Cairn --snapshot` produit toujours les mêmes images
- [x] 4.2 Implémenter `GalleryExport` (4 PNG par story, `index.html` groupé et autonome, écriture limitée au dossier demandé) et l'option `--gallery-export <dossier>` ; sans dossier, afficher l'usage et sortir avec un code d'erreur
- [x] 4.3 Ajouter à `GalleryTests` un test d'export d'une story vers un dossier temporaire (4 PNG, `index.html` qui les référence) et vérifier `just test Gallery`
- [x] 4.4 Ajouter la recette `just gallery-export` (dossier par défaut `build/gallery`), la documenter dans `Cairn/README.md`, et vérifier que l'`index.html` s'ouvre et affiche toutes les stories

## 5. Intégration

- [x] 5.1 Rédiger le sujet du commit `feat` comme une ligne de note de release (le `CHANGELOG.md` est généré par la CI) et mentionner `CairnUI` dans les consignes « App Cairn » d'`AGENTS.md`
- [x] 5.2 Vérification finale : `just test`, `just storage-install`, lancement normal de l'app inchangé, `just gallery`, `just gallery-export`, puis `openspec validate component-gallery`

## 6. Deuxième passe d'extraction

- [x] 6.1 Déplacer dans `CairnUI` les vues autonomes restées dans l'app (`SegmentBar`, `MessageBar`, `WorkerRow`, `FilterChip`, `ChoiceChip`, `ChoiceTile`, `SelectableRow`, `FolderRow`, `WizardStepper`, `FolderBreadcrumb`), en `public` avec init explicite, et vérifier que la compilation passe ; les vues qui lisent l'état de l'app ou un type de l'app restent dans l'app
- [x] 6.2 Ajouter une story par composant déplacé (titres traduits) et vérifier `just test` (dont `Gallery.every_component_has_a_story`)
- [x] 6.3 Vérifier à l'œil les nouvelles stories exportées et les captures `--snapshot` des écrans qui les utilisent (assistant, suppression de destination, accueil, analyse)

## Workflow follow-up

- Lancer `/opsx:verify` puis archiver le changement après revue.
