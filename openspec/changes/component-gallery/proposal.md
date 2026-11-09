# Proposal

## Why

Les composants SwiftUI de Cairn (`Card`, `PillPicker`, `Badge`, `Banner`, `FillBar`, `PathField`, `BreakdownChart`…) sont
mélangés aux écrans dans la cible exécutable `Cairn`. Sans Xcode, `#Preview` n'existe pas : pour voir un composant, il
faut lancer l'app et naviguer jusqu'à l'écran qui l'utilise, et ses variantes (états, thèmes, langues) ne sont visibles
nulle part ensemble. Un catalogue façon Storybook, appuyé sur une bibliothèque de composants dédiée, rend le design
system lisible, facilite la relecture visuelle des PR et prépare la vérification visuelle automatisée.

## What Changes

- Nouvelle bibliothèque SwiftPM `CairnUI` (dossier `Cairn/Sources/CairnUI`) qui accueille les jetons de thème
  (`Palette`, couleurs de catégories, raccourci `T`) et les composants réutilisables, aujourd'hui dans
  `Components.swift`, `Theme.swift` et `AnalysisComponents.swift`. Les vues qui dépendent de `AppModel` (par exemple
  `ScanningView`) restent dans l'app. Aucun changement visible pour l'utilisateur.
- Un registre de « stories » dans `CairnUI` : chaque composant expose ses variantes nommées avec des données factices.
- Une fenêtre catalogue en direct, ouverte par `cairn --gallery` (et `just gallery`) : liste des stories groupées,
  aperçu, bascule clair/sombre, langue fr/en, largeur du cadre, et réglages simples sur les variantes qui le permettent.
- Un export statique, `cairn --gallery-export <dossier>` (et `just gallery-export`) : une image PNG par story et par
  combinaison thème × langue, plus une planche `index.html` pour les parcourir.
- Le test de traduction (`L10n.no_untranslated_ui_strings`) couvre aussi `Sources/CairnUI`, sous-dossiers compris.

## Capabilities

### New Capabilities
- `component-gallery` : catalogue des composants de l'interface (stories, fenêtre de consultation, export statique).

### Modified Capabilities
<!-- Aucune : l'extraction de CairnUI est un refactor sans changement de comportement. -->

## Impact

- `Cairn/Package.swift` : nouvelle cible `CairnUI` (dépend de `CairnCore`), dont dépend `Cairn`.
- `Cairn/Sources/Cairn` : les fichiers de composants partent dans `CairnUI` ; les écrans importent `CairnUI`.
  Les types déplacés deviennent `public`.
- `Cairn/Sources/Cairn/main.swift` : aiguillage des options `--gallery` et `--gallery-export`.
- `Cairn/Sources/CairnCore/Resources/{en,fr}.lproj` : libellés du catalogue.
- `Tests/CairnTests` (Swift Testing) : parcours récursif des sources pour le test de traduction, tests du registre de
  stories.
- `justfile`, `Cairn/README.md`, `AGENTS.md` : nouvelles recettes et documentation.
- Rien de destructif : le catalogue ne lit ni n'écrit dans le home, seul l'export écrit dans le dossier demandé.
