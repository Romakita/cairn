# Design

## Context

- `Cairn/Package.swift` a pour cibles `CairnCore` (logique, sans SwiftUI), `Cairn` (exécutable : interface et ligne
  de commande) et les tests (au départ l'exécutable `CairnSelfTest`, depuis la cible Swift Testing `CairnTests`).
- Les composants sont dans `Sources/Cairn/Components.swift`, `Theme.swift` et `AnalysisComponents.swift`, en accès
  `internal`. Ils dépendent de `CairnCore` (`Category`, `Node`, `Fmt`, `L10n`, `PathCompletion`) mais pas d'`AppModel`,
  sauf `ScanningView`.
- `Theme.swift` définit aussi `T(_:)`, le raccourci de traduction utilisé par tous les écrans.
- `Snapshot.swift` sait déjà rendre une vue hors écran en PNG (`NSHostingView` dans une `NSWindow` sans bordure, avec
  apparence et locale forcées), via `Cairn --snapshot <dossier>`.
- Contraintes : Command Line Tools seulement (pas de `#Preview`, `@ViewState` au lieu de `@State`), pas de XCTest.
- Le test `L10n.no_untranslated_ui_strings` ne parcourt que `Sources/Cairn` et `Sources/CairnCore`, sans sous-dossiers.

## Goals / Non-Goals

**Goals:**
- Une bibliothèque `CairnUI` avec une structure de dossiers lisible, sur laquelle l'app et le catalogue s'appuient.
- Un seul registre de stories, partagé par la fenêtre en direct, l'export statique et les tests.
- Aucun changement visuel ni fonctionnel des écrans existants.

**Non-Goals:**
- Comparaison automatique des images à une référence (régression visuelle) : possible plus tard sur l'export.
- Stories d'écrans complets branchés sur `AppModel` : `--snapshot` couvre déjà ce besoin et reste inchangé.
- Rechargement à chaud : on relance `just gallery` après une modification.

## Decisions

### 1. Bibliothèque `CairnUI` dépendant de `CairnCore`

Nouvelle cible `.target(name: "CairnUI", dependencies: ["CairnCore"], path: "Sources/CairnUI")`. `Cairn` dépend de
`CairnUI` ; la cible de tests aussi, pour tester le registre. Organisation :

```
Sources/CairnUI/
  Theme/        Palette.swift, Color+Hex.swift, Category+Style.swift, Localization.swift (T)
  Components/   Buttons.swift, Navigation.swift (RailButton, Sidebar*, TabBar, PillPicker),
                Containers.swift (Card, CardTray, SettingsRow, Banner), Feedback.swift (Badge, FillBar, HoverTooltip),
                Fields.swift (PathField, CairnFieldModifier, DropdownMenu), Charts.swift (BreakdownBar, BreakdownChart,
                CategoryTag), Brand.swift (CairnLogo, IconTile)
  Gallery/      Story.swift (types), Stories+<Groupe>.swift (une extension par groupe), GalleryView.swift,
                GalleryExport.swift
```

Les types et initialiseurs utilisés par l'app deviennent `public` ; les sous-vues privées (`SuggestionList`…) restent
privées. `ScanningView` reste dans l'app (elle lit `AppModel`).

Alternative écartée : garder les composants dans l'exécutable avec un simple dossier `Sources/Cairn/UI/`. Moins de
travail (pas de `public`), mais les tests ne peuvent pas rendre les stories et la frontière app / design system reste
implicite.

### 2. `T(_:)` dans `CairnUI`, chaînes dans `CairnCore`

`T` est déclaré `public` dans `CairnUI` (il appelle `L10n.tr`), donc visible dans l'app par `import CairnUI` sans
doublon. Les fichiers `.strings` restent dans `CairnCore/Resources` : une seule source de traduction, et `L10n` sait
déjà les charger. Les clés du catalogue sont préfixées `gallery.`.

### 3. Modèle de story

```swift
public struct Story: Identifiable {
    public let id: String            // "badge.warning", unique
    public let group: StoryGroup     // .buttons, .navigation, .containers, .feedback, .fields, .charts, .brand, .palette
    public let component: String     // nom du type présenté, pour le test de couverture
    public let titleKey: String      // clé de traduction
    public var controls: [StoryControl] = []
    public let make: (StoryValues) -> AnyView
}
```

`StoryControl` est une énumération (`text`, `toggle`, `number(range)`, `choice([String])`) avec une clé et une valeur
par défaut ; `StoryValues` est un dictionnaire typé lu par la closure. La fenêtre garde les valeurs courantes dans un
`@ViewState` par story. Le registre est `Stories.all`, assemblé à partir d'une extension par groupe.

Les composants à état interne (`PathField`, survols) sont rendus tels quels. `PathField` reçoit une `base` qui pointe
vers un dossier temporaire factice créé par la story, jamais vers le home.

Alternative écartée : un protocole `Previewable` sur chaque composant. Plus intrusif et ne permet pas plusieurs
variantes nommées par composant.

### 4. Fenêtre en direct

`main.swift` détecte `--gallery` avant l'aiguillage vers la ligne de commande et lance une petite `App` SwiftUI dédiée
(`GalleryApp`) qui ne contient que `GalleryView` : `NavigationSplitView` avec la liste groupée à gauche, l'aperçu au
centre, les contrôles à droite. L'aperçu applique `.environment(\.colorScheme, …)`, `.environment(\.locale, …)` et
une largeur fixe ; la langue passe aussi par `L10n.current` (les textes sont résolus par `T` au rendu), puis l'aperçu
est reconstruit via `.id(langue)`.

L'app normale n'importe pas `GalleryApp` : rien n'est visible sans l'option.

### 5. Export statique

`GalleryExport.run(outDir:)` réutilise la technique de `Snapshot.render` (extraite en fonction partagée dans
`CairnUI`, et `Snapshot` l'appelle). Pour chaque story × {clair, sombre} × {fr, en} : rendu à la taille idéale du
composant (`fittingSize`, bornée à la largeur choisie par la story, 480 pt par défaut) dans
`<dossier>/<id>-<lang>-<theme>.png`. Puis un `index.html` autonome (CSS inline, pas de script) : une section par
groupe, une ligne par story, les quatre images côte à côte. Chemins vérifiés pour rester sous le dossier demandé.

Alternative écartée : `ImageRenderer`. Il ignore une partie des effets AppKit (`NSColor` dynamiques, `TextField`) déjà
contournés par `Snapshot`.

### 6. Tests

Nouvelle suite `GalleryTests` (Swift Testing, `Tests/CairnTests` ; les tests qui changent la langue ou rendent des
vues portent `.globalState`) : identifiants uniques et groupes non vides ; couverture (chaque `public struct … : View`
des fichiers de `Sources/CairnUI/Components` a au moins une story, par analyse du texte comme le test de traduction) ;
chaque story se rend en image non vide en clair et en sombre ; l'export d'une story vers un dossier temporaire produit
4 PNG et un `index.html` qui les référence. Le test de traduction passe à un parcours récursif et inclut
`Sources/CairnUI`.

## Risks / Trade-offs

- [Le passage en `public` touche beaucoup de signatures] → déplacement fichier par fichier, `just test` et
  `just storage-install` après chaque lot, comparaison des PNG de `--snapshot` avant et après.
- [Rendu hors écran dans les tests lent ou instable (attente de 0,6 s de `Snapshot`)] → attente réduite pour les petits
  composants, et test de rendu limité à une passe clair/sombre en une seule langue.
- [Stories oubliées pour un nouveau composant] → le test de couverture échoue.
- [Les stories gonflent le binaire livré] → code léger, sans ressources ; acceptable. Si besoin plus tard, les déplacer
  dans une cible `CairnGallery` séparée.
- [Conflit de nom `Category` entre `CairnCore` et SwiftUI] → l'alias `typealias Category = CairnCore.Category` reste
  dans l'app, et `CairnUI` qualifie explicitement `CairnCore.Category`.

## Migration Plan

Refactor interne livré en un seul changement : pas de donnée ni de configuration à migrer. Retour arrière par revert du
commit.
