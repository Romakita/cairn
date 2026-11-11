# Design system de Cairn (Electron)

Règles de l'interface React (`src/renderer`), tirées du design system de Codex et de la spec
`openspec/changes/migrate-to-electron/specs/interface-design/spec.md`. Le détail des composants et de leurs variantes
est dans la galerie (`bun run dev:web` puis `#/gallery`, ou `bun run shots`) ; les mesures de référence dans
`openspec/changes/migrate-to-electron/parity/ui.md` (§2).

Esprit : celui des réglages de Codex (app de bureau ChatGPT), repris de l'app Swift de la 0.8.0. Neutre et aéré, un
seul accent bleu (`--color-accent` : liens, interrupteurs, focus), le noir (`--color-primary`) pour l'action
principale. Tout nouvel écran réutilise les jetons et les composants plutôt que de recréer un style local.

## Fenêtre

Un cadre gris uni (`--color-rail`) porte la barre du haut (boutons de fenêtre, bascule de la barre latérale, logo de
Cairn) et le rail d'icônes. La barre latérale (`--color-sidebar`) et le contenu (`--color-content`) partagent un corps
qui flotte dans ce cadre (`--radius-window`, bordure fine, `--shadow-window` ; `screens/shell/Shell.module.css`) :
c'est la seule ombre d'un élément non flottant.

## Jetons

Toutes les valeurs visuelles viennent de [`src/renderer/styles/tokens.css`](src/renderer/styles/tokens.css), défini pour
le clair et redéfini (couleurs seulement) pour le sombre. Le lint (`bun run lint`, `scripts/check-style.ts`) refuse
toute couleur littérale ailleurs (`#…`, `rgb()`, `oklch()`, `color-mix()`), tout élément natif
(`<button>`, `<input>`, `<select>`, `<table>`…) hors de `ui/`, et l'attribut `title=` (infobulle native).

| Famille | Rôle |
|---|---|
| `--color-*` | Neutres : fonds (`content`, `field`, `sidebar`), textes (`text`, `-secondary`, `-tertiary`), bordures, action principale (`primary`, `primary-text`), survol de ligne |
| `--tone-*` | Tons d'état des badges et bandeaux seulement (`success`, `info`, `warning`, `danger` : `-bg`, `-fg`) |
| `--status-*` | État global (pastille de la barre du haut, en-tête de l'accueil, points des destinations) : `ok`, `attention`, `error`, `unknown` |
| `--module-*`, `--tint-*` | Couleur de chaque module (stockage, sauvegarde, git, IA, restauration) : **accueil seulement** |
| `--category-*` | Catégories de l'analyse (sources, dépendances, builds…) : graphiques, identiques en clair et sombre |
| `--text-*`, `--font-*` | Typographie : un jeton par usage (`page-title`, `card-title`, `row`, `body`, `caption`, `meta`, `stat`, `mono`…) |
| `--radius-*`, `--space-*`, `--size-*` | Rayons, espacements (échelle `--space-1` à `--space-12`), tailles fixes des composants |
| `--shadow-*` | Ombres des éléments flottants (menus, infobulles, feuilles, segment de `PillPicker`) : **jamais les cartes** |
| `--duration-*`, `--ease-*`, `--delay-*` | Mouvement (états, apparition des infobulles) |
| `--opacity-*` | Opacité d'un élément désactivé (`--opacity-disabled`) |

Un écran n'invente pas de jeton : s'il en manque un, il s'ajoute dans `tokens.css` (clair et sombre).

## Composants

Un écran n'utilise que `src/renderer/ui/` (import depuis le fichier du composant, pas depuis `ui/index.ts`), et un
fichier `.module.css` par composant d'écran, avec des jetons seulement.

| Besoin | Composant | Quand |
|---|---|---|
| Onglets d'une page (Vue d'ensemble / Explorateur…) | `PillPicker` | Bascule en pilule, segment blanc qui glisse. Un onglet indisponible a son `disabledReason` |
| Choix entre options dans une carte ou un tableau (fréquence, rétention) | `TabBar` | Texte gris sans conteneur, choix courant en pilule grise. Jamais pour des onglets de page |
| Bouton | `Button` | `primary` (noir) : l'action principale de la zone, une seule ; `secondary` : courant ; `outline` : action d'une carte ; `danger` : confirmation d'une suppression, dans une feuille seulement |
| Bouton icône (corbeille d'une ligne, fermer) | `IconButton` | Le libellé sert d'infobulle et de nom accessible |
| Menu « … » d'une ligne ou d'un en-tête | `MoreButton` / `PopupMenu` | Icône + texte, séparateurs, action destructive en rouge **en dernier** après un séparateur |
| Liste déroulante | `DropdownMenu` | Jamais de `<select>` ni de menu natif |
| Confirmation, formulaire court, détail | `Sheet` | Feuille modale (520 pour une suppression, 640 par défaut, 760 pour une destination) ; pied : « Annuler » puis l'action |
| Information, avertissement, erreur dans la page | `Banner` | Ton (`info`, `success`, `warning`, `danger`), action optionnelle à droite |
| Message bref du main | `MessageBar` | En bas du contenu (barre de messages du shell), avec son niveau |
| Nombre (rétention, seuils) | `NumberStepper` | Moins / valeur / plus, flèches au clavier |
| Chemin relatif au home | `PathField` | Complétion par `completePath` |
| Interrupteur, case, puce | `Toggle`, `Checkbox`, `ChoiceChip` | Réglage immédiat ; case dans une liste ou une feuille ; catégories des outils IA |
| Ligne de réglage | `SettingsRow` dans une `Card flush`, séparées par `RowDivider` | |
| Chiffre clé | `Stat` ; graphiques `BreakdownChart`, `SegmentBar`, `FillBar`, `RingGauge` | |
| Infobulle | `Tooltip` | Une seule infobulle pour l'app ; jamais `title=` |
| Texte long sur une ligne (chemin) | `MiddleText` | Tronqué au milieu, la fin reste visible |

## Iconographie

Icônes [Lucide](https://lucide.dev) (paquet `lucide-react`, licence ISC), affichées par le composant `Icon` et teintées
comme le texte. Les icônes de la barre des menus sont des images « template » de macOS dans `resources/tray/`
(générées depuis les SVG du dossier, logo de Cairn et icônes Lucide, par `resources/tray/render-icons.mjs`).

## Règles

- **Action indisponible** : le composant est affiché désactivé avec `disabledReason` (raison traduite, venant du
  snapshot : `unavailable`, `lock`, `updates.blocker`, configuration invalide…). Tous les contrôles l'acceptent
  (`Button`, `IconButton`, éléments de menu, `TextField`, `PathField`, `Toggle`, `Checkbox`, `ChoiceChip`, `TabBar`,
  options de `PillPicker` et `TabBar`, `NumberStepper`, `DropdownMenu`) ; on n'enveloppe jamais un contrôle dans un
  `Tooltip` ou un conteneur `inert` pour le simuler.
- **Destructif** : confirmation dans une feuille, corbeille par défaut, case dédiée quand du travail peut être perdu
  (branche non fusionnée, worktree ou dépôt à risque). **Une seule confirmation** : la feuille appelle
  `confirmedCall(api, méthode, args)` (`api/confirm.ts`) qui obtient un jeton du main ; le main n'ouvre sa boîte native
  que pour un appel sans jeton valide (voir « Confirmation des actions destructives » dans `src/shared/contract.ts`).
- **Une seule action principale noire** par zone (en-tête de page, pied de feuille, carte).
- **Cartes sans ombre** : bordure fine et fond `content` ; les ombres sont réservées aux éléments flottants.
- **Couleurs de module à l'accueil seulement** (tuiles, mini-graphiques) ; ailleurs, neutres et tons d'état.
- **Pourcentages** : toujours `Fmt.percent` du core (« 60 % » en français, « 60% » en anglais ; `digits = 0` pour un
  avancement ou un seuil), jamais une concaténation.
- **Dates dans une phrase** : une date relative (« hier ») va dans une phrase faite pour elle (« Sauvegardé {1} ») ;
  une date absolue dans « le {1} ».
- **Données** : uniquement `useSnapshot()` / `useApi()` ; aucun écran ne lit un fichier de ressources (profils IA…) :
  ce dont il a besoin passe par le contrat.

## Vocabulaire

- Textes visibles : `t("clé")` uniquement. Les clés des écrans vont dans `locales/areas/<zone>.json`
  (`{ "en": {…}, "fr": {…} }`, mêmes clés et mêmes jetons `{N}`) ; `locales/en.json` et `fr.json` restent ceux de la
  0.8.0.
- Les mots de l'utilisateur, pas ceux des outils : jamais « rsync », « worker », « sparsebundle », « hdiutil »,
  « fetch » (« Comptage des fichiers », « image disque », « mettre à jour les branches distantes »). « Gone branches »
  devient « Branches à nettoyer ».
- Même casse pour les badges d'un même type ; « Cairn » est le seul nom propre écrit en dur.
- `test/core/ui-texts.test.ts` échoue sur un texte JSX en dur dans `src/renderer` (hors données de
  `gallery/sample-*.ts`), une clé `t("…")` absente d'une langue, ou un mot de jargon dans `locales/areas/`.

## Vérification visuelle

Chaque écran se vérifie sur des captures, en clair et en sombre, avant d'être considéré comme fini :

```bash
bun run shots                       # galerie : shots/gallery/<story>-<light|dark>.png + index.html
bun scripts/screen-shots.ts         # écrans d'exemple : shots/screens/<nom>-<light|dark>.png + index.html
bun scripts/screen-shots.ts git.    # filtre sur les noms
```

Les écrans s'affichent avec l'API d'exemple (`src/renderer/api/fixtures/`, scénarios `?scenario=`, instant figé
`&t=<s>&frozen=1`, `&lang=fr`) : aucune analyse ni sauvegarde réelle. Une nouvelle capture s'ajoute dans
`scripts/shots/<zone>.ts` (état vide, en cours, erreur, feuille ouverte via `before`, et au moins une en français).
Regarder : alignements, espacements, hiérarchie, troncatures, lisibilité du sombre.
