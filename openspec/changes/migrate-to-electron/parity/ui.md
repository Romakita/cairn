# Cairn → Electron : spécification de parité de l'interface et du design system

Source : worktree `electron-app` (commit 906f788, v0.8.0). Lecture seule. Fichiers clés :
`Cairn/Sources/CairnUI/Theme/*.swift` (jetons), `Cairn/Sources/CairnUI/Components/*.swift` (composants),
`Cairn/Sources/CairnUI/Gallery/*` (catalogue, `cairn --gallery`), `Cairn/Sources/Cairn/*View*.swift` (écrans),
`Cairn/DESIGN.md`, `tasks/lessons.md`.

**Captures de référence Codex : aucune dans le repo** (ni `docs/`, ni ailleurs ; `Resources/ai-tools/codex.json` est un
profil d'outil IA). DESIGN.md cite des valeurs « relevées sur une capture de Codex » non conservée. Les seules captures
sont `docs/images/*.png` (home, analysis-dark, cleanable, menubar, onboarding, + `-fr`) — et `home.png` est **obsolète**
(ancien accueil « What do you want to do? » avec barre de recherche, sans cartes de modules).

---

## 1. Jetons du design system (prêts pour des variables CSS)

### 1.1 Couleurs neutres (`Palette`, `Theme/Palette.swift`)

| Variable CSS proposée | Jeton Swift | Clair | Sombre | Usage |
|---|---|---|---|---|
| `--color-content` | `content` | `#FFFFFF` | `#181818` | fond des pages, cartes, champs, menus |
| `--color-sidebar` | `sidebar` | `#FCFCFC` | `#1F1F1F` | barre latérale, `CardTray` |
| `--color-rail` | `rail` | `#F3F3F3` | `#1B1B1B` | cadre fenêtre (barre du haut + rail) |
| `--color-rail-selected` | `railSelected` | `#FFFFFF` | `#2E2E2E` | fond du bouton « mise à jour » ouvert |
| `--color-row-selected` | `rowSelected` | `#EDEDED` | `#2C2C2C` | élément actif (rail, sidebar) |
| `--color-row-hover` | `rowHover` | `#F6F6F6` | `#222222` | survol d'une ligne ; fond du bloc workers |
| `--color-border` | `border` | `#E6E6E6` | `#2F2F2F` | cartes, séparateurs |
| `--color-field-border` | `fieldBorder` | `#DCDCDC` | `#3A3A3A` | champs, menus déroulants, bouton outline |
| `--color-field` | `field` | `#F2F2F2` | `#2A2A2A` | bouton secondaire, onglet choisi, piste de jauge |
| `--color-field-pressed` | `fieldPressed` | `#E6E6E6` | `#333333` | survol du bouton secondaire |
| `--color-text` | `text` | `#222529` | `#F2F2F2` | titres, texte principal |
| `--color-text-tertiary` | `tertiary` | `#3D3D3D` | `#D0D0D0` | texte courant secondaire, libellés PillPicker |
| `--color-text-secondary` | `secondary` | `#8F8F8F` | `#9B9B9B` | descriptions, méta |
| `--color-placeholder` | `placeholder` | `#9A9A9A` | `#6E6E6E` | placeholder (défini, peu utilisé) |
| `--color-accent` | `accent` | `#3B6FE0` | `#5B8DEF` | liens, focus, interrupteurs, barres de progression |
| `--color-primary` | `primaryButton` | `#0D0D0D` | `#F2F2F2` | bouton principal, infobulle, puce cochée |
| `--color-primary-text` | `primaryButtonText` | `#FFFFFF` | `#0D0D0D` | texte sur primaire |
| `--color-danger-solid` | (inline `Buttons.swift`) | `#DC2626` | `#B91C1C` | fond `.pillDanger` (texte blanc) |

### 1.2 Tons d'état (`Palette.Tone` : badges, bandeaux uniquement)

| Ton | Fond clair | Fond sombre | Texte clair | Texte sombre |
|---|---|---|---|---|
| `neutral` | `#F0F0F3` | `#2A2A30` | `#3F3F4A` | `#D4D4D8` |
| `success` | `#DCFCE7` | `#14302A` | `#166534` | `#86EFAC` |
| `warning` | `#FFF4ED` | `#3A2414` | `#7C2D12` | `#FDBA74` |
| `danger` | `#FEE2E2` | `#3F1D1D` | `#991B1B` | `#FCA5A5` |
| `info` | `#EFF6FF` | `#172554` | `#1E40AF` | `#93C5FD` |

→ `--tone-<t>-bg`, `--tone-<t>-fg`.

### 1.3 Couleurs de module (accueil seulement : tuile d'icône à 13 % d'opacité + mini-graphiques)

| Module | Clair | Sombre |
|---|---|---|
| `storage` (Stockage) | `#2563EB` | `#60A5FA` |
| `backup` (Sauvegarde) | `#0D9488` | `#2DD4BF` |
| `git` | `#EA580C` | `#FB923C` |
| `ai` (Outils IA) | `#7C3AED` | `#A78BFA` |
| `restore` (Restauration) | `#4F46E5` | `#818CF8` |

### 1.4 Couleurs de catégorie (graphiques de l'analyse ; identiques en clair et sombre)

`source #3B82F5` · `git #FA7317` · `deps #DB2678` · `build #F59E0A` · `ios #8C5CF5` · `python #0FBA82` ·
`cache #8C9EAD` · `trash #737373` (valeurs RGB flottantes converties). Étiquette `CategoryTag` : fond couleur à 18 %,
texte couleur. Filtre actif `FilterChip` : fond 22 %, bordure couleur.

### 1.5 Couleurs hors jetons utilisées dans le code (à normaliser, cf. §4)

`Color.orange` (système, ~`#FF9500`/`#FF9F0A`) : état « attention » de l'en-tête du hub, pastilles de versions abîmées,
pastille « en attente » de la sidebar Sauvegarde, volume « bas » ; `.red` : volume critique ; `Color.accentColor`,
`Color.gray.opacity(0.1)`, `.white`, `.regularMaterial`. Le statut du hub (`StatusColor`) : ok = success fg,
info = accent, attention = orange, error = danger fg, unknown = fieldBorder.

### 1.6 Typographie (police système SF Pro → `-apple-system, BlinkMacSystemFont, "SF Pro Text"`)

| Rôle | Taille / graisse | Où |
|---|---|---|
| Titre de page | 28 `medium` (500) | Réglages, titre du hub |
| Titre d'assistant | 28 `regular` (400), centré ; sous-texte 14.5 secondary, interligne +3 | Onboarding |
| Titre de page (variantes à unifier) | 26 medium (Restauration, Outils IA), 24 medium (« bientôt »), 22 semibold (destination), 22 medium (feuilles) | |
| Titre de sidebar | 17 semibold | en tête de chaque barre latérale |
| Titre de feuille Git | 17 semibold | |
| Titre de carte de progression | 16 semibold | |
| `SectionTitle` | 15 medium, marge haut 14 / bas 2 | au-dessus d'une carte |
| Titre de carte | 15 semibold | cartes de la page Sauvegarde, Outils IA |
| Valeur de stat | 20 semibold (cartes de stat, chiffre de module) ; 22 semibold (stats Git) ; 20 bold (anneau, menu barre) | |
| Libellé de ligne (`SettingsRow`) / `PillPicker` / popup menu | 14 regular | |
| Bouton, champ, ligne sidebar, `TabBar`, bandeau | 13.5 regular | |
| Description, infobulle | 13 regular secondary | |
| Petit détail | 12.5 | |
| Méta sidebar, `SidebarHeader` (12 medium) | 12 | |
| Détail worker | 11.5 monospace | |
| `Badge` | 11 semibold | |
| Chemins, fichiers, branches, versions | monospace (`ui-monospace, "SF Mono"`) 12–13.5 | |
| Chiffres | `monospacedDigit` → `font-variant-numeric: tabular-nums` | compteurs, tailles, % |

### 1.7 Rayons

| Élément | Rayon |
|---|---|
| Carte, popover de sauvegarde, `CardTray` (coins bas) | 16 |
| Corps de fenêtre flottant | 12 |
| Bandeau, `ChoiceTile`, popup menu, liste de suggestions, conteneur de tableau, tuile menu barre, tuile icône destination (48 pt) | 14 |
| Bloc des workers | 12 |
| Bouton `.pill*`, `RailButton`, `DropdownMenu`, `MoreIcon` | 10 |
| Ligne sidebar, ligne de menu, ligne de suggestion, élément de fil d'Ariane, `IconButton`, infobulle | 8 |
| Tuile d'icône de module (64 pt) | 18 |
| `IconTile` | 28 % de la taille (32 → 9) |
| Barre de répartition | 3 |
| Champ, `Badge`, `PillPicker`, `TabBar`, `ChoiceChip`, `FilterChip`, jauges | capsule (`9999px`) |

### 1.8 Espacements usuels

- Carte : padding 18 (stats Git 14, versions restore 6/4) ; `SettingsRow` 16 h / 13 v, gap 14 ; `SelectableRow` 16 h / 9 v ;
  `CardTray` 14 h / 12 v ; `Banner` 16 h / 11 v, gap 12 ; `RowDivider` en retrait de 16 de chaque côté.
- Grilles : gap 14 entre cartes ; pile verticale 18 (Sauvegarde), 30 (hub), 12 (Réglages), 16 (Outils IA).
- Marges de page : 32 h (Sauvegarde, Git, Outils, IA), 40 h (Accueil, Réglages, Restauration), 28 (feuilles), 48 (assistant).
- Largeurs max du contenu : 1040 (hub), 760 (Réglages), 680 (Restauration, assistant), 860 (stepper).
- Sidebar : padding 12 h ; ligne 8 h / 7 v, gap 10 ; en-tête 8 h, 14 haut / 4 bas.

### 1.9 Ombres (seuls les éléments flottants, + le corps de fenêtre)

| Élément | SwiftUI | CSS approx. |
|---|---|---|
| Corps de fenêtre | noir 10 %, r 10, y 2 | `0 2px 20px rgb(0 0 0 / .10)` |
| Segment choisi `PillPicker` | noir 8 %, r 4, y 1 + bordure 0.5 `border` | `0 1px 8px rgb(0 0 0 / .08)` |
| Liste de suggestions | noir 12 %, r 14, y 4 | `0 4px 28px rgb(0 0 0 / .12)` |
| Infobulle | noir 18 %, r 6, y 2 | `0 2px 12px rgb(0 0 0 / .18)` |
| Popup menu | ombre système de `NSPanel` | `0 8px 30px rgb(0 0 0 / .14)` + bordure `border` |

Les cartes n'ont **jamais** d'ombre.

### 1.10 Tailles fixes

- Fenêtre : min 1100×720, défaut 1280×800, barre de titre masquée (feux tricolores sur la barre du haut).
- Barre du haut 38 (DESIGN.md dit 44) ; rail 56 de large, boutons 40×40, gap 6 ; sidebar 248 ; marge du corps 6 (droite, bas).
- Bouton min 32 h, padding 14 h ; champ 34 h, padding 14 h ; `DropdownMenu` 32 h ; ligne de popup 34 h, largeur min 200
  (160 pour un dropdown), panneau padding 6 ; `FolderRow` 44 ; liste de dossiers : 5 lignes visibles max.
- Zone des `PillPicker` de page : 64 de haut ; segment min 32 h, padding 22 h ; piste padding 3.
- Jauges : `FillBar` 8, `SegmentBar` 8 (écart 2), barre de progression 6, anneau de sauvegarde 84 (trait 8),
  jauge du menu barre 118 (trait 12), mini-anneau sidebar 13 (trait 2.5).
- `StepNode` 28 (halo 38) ; `StatusDot` 32 ; bouton mise à jour 30 dans 40.
- Feuilles : Ajouter/Modifier une destination 760×720 ; Supprimer une destination 640×620 ; suppression Git 520 de large ;
  popover de mise à jour 400 ; panneau de barre des menus 360.

### 1.11 Icônes

Lucide 1.61.0 (ISC), SVG embarqués trait 1.6, teintés `currentColor` ; 66 fichiers ; table `LucideIcons.map` (symbole SF →
Lucide) dans `CairnCore/Icons.swift` — à reprendre telle quelle comme table de correspondance, ou mieux : utiliser
directement les noms Lucide dans le code React (`lucide-react`, `strokeWidth={1.6}`).
Tailles : rail 20 ; sidebar 16 ; popup menu 16 (boîte 18) ; `MoreIcon` 16 (boîte 32) ; `IconButton` 16 (28) ;
bouton 15 ; bandeau 17 ; worker 15 ; `IconTile` 52 % de sa boîte (32/30/28) ; tuile de module 32 (boîte 64) ;
en-tête du hub 34 (cercle 76, fond 12 %, bordure 50 % 1.5) ; état vide 39 ; chevrons 9–13.
Logo `CairnLogo` : trois ellipses empilées en trait (centres y 0.77/0.53/0.30, largeurs 0.62/0.45/0.27, hauteurs
0.22/0.19/0.16 de la taille, trait `max(1.2, size/14)`) → SVG à produire ; dans la barre du haut : 12 pt blanc sur
pastille noire 20 pt + « Cairn » 13.5 semibold.

### 1.12 Mouvement

- États (survol, focus, bascule) : `ease-out` 120–150 ms. Changement d'étape / segment : « snappy » 250–300 ms
  (`cubic-bezier(.2,.8,.2,1)`), transition d'étape de l'assistant : décalage x ±36 + fondu.
- Infobulle : apparition après 350 ms de survol, fondu 120 ms. Barre de progression : 200 ms ease-out.

---

## 2. Catalogue des composants

Galerie (`cairn --gallery`, fenêtre 1280×800 : sidebar 240 des stories groupées, canevas sur fond `rail` avec carte
`content` r12, panneau de contrôles 280 à droite ; barre d'outils : `PillPicker` Clair/Sombre + `DropdownMenu` largeur ;
export statique `cairn --gallery-export <dossier>`). 8 groupes, 43 stories :
`palette` (colors, tones, categories) · `buttons` (pill, pill_all, icon, more_icon, more_menu) · `navigation` (rail,
sidebar, sidebar_header, wizard_stepper, folder_breadcrumb, pill_picker, tab_bar) · `containers` (card, section_title,
settings, selectable_rows, folder_rows, row_divider, card_tray, banner) · `feedback` (badge, badge_tones, fill_bar,
segment_bar, message_bar, worker_rows, tooltip) · `fields` (text, dropdown, choice_chips, filter_chips, choice_tiles,
popup_menu, path) · `charts` (breakdown_bar, category_tags, breakdown_chart) · `brand` (logo, icons, icon_tile).
Contrôles de story : `text`, `toggle`, `number(range, step)`, `choice(options)` ; libellés `gallery.control.<clé>`,
`gallery.option.<option>`. → Équivalent Electron : Storybook (ou Ladle) avec les mêmes ids de story.

### 2.1 Boutons

| Composant | Rôle | Variantes / états | Règles |
|---|---|---|---|
| `PillButtonStyle` `.pillPrimary` | action principale | fond `primary`, texte `primary-text` ; survol opacité 85 % | une seule par zone ; noire même sur l'accueil coloré |
| `.pill` (secondaire) | action courante | fond `field`, survol `field-pressed` | défaut |
| `.pillOutline` | action d'une carte (bouton de module), « Restaurer plutôt » | fond `content`, bordure `field-border`, survol `row-hover` | |
| `.pillDanger` | confirmation d'une suppression dans une feuille | fond `#DC2626`/`#B91C1C`, texte blanc, survol 85 % | seulement au moment de confirmer |
| Commun | 13.5, min 32 h, r 10, padding 14 h | pressé opacité 0.8 ; **désactivé opacité 0.4 + raison en infobulle** (`.help`) | lessons : tout bouton dont l'action ne peut aboutir est désactivé avec sa raison (règle pure testée, ex. `BackupActions.unavailableReason`). Jamais `.bordered`/`.borderedProminent` |
| `MoreIcon` | déclencheur du menu « … » | icône 16 `secondary`, boîte 32 r10, survol fond `field` + texte | ordre d'en-tête de détail : « … », « Gérer/Modifier », action principale |
| `IconButton` | action discrète (corbeille) | 16 dans 28 r8, survol fond `field` ; libellé en infobulle + aria-label | |

### 2.2 Navigation

| Composant | Rôle | États |
|---|---|---|
| `RailButton` | section du rail | 40×40 r10 ; inactif `secondary` ; survol `row-hover` + texte ; actif `row-selected` (sans ombre) ; infobulle sombre à droite |
| `SidebarHeader` | titre de groupe | 12 medium secondary |
| `SidebarRow` | ligne de sidebar | pastille de couleur 8 **ou** icône 16, titre tronqué au milieu, méta à droite (12, chiffres tabulaires) ; `selected` → fond `row-selected` r8 ; `busy` → anneau 13 + « NN % », ou roue si % inconnu ; cliquable ou non |
| `PillPicker` | **onglets d'une page** (Analyse, Git, Outils CLI, galerie) | piste `field` capsule, bordure `border` 60 % ; segments de même largeur ; choisi : capsule `content` ombrée qui glisse (matchedGeometry) ; libellés `tertiary` → `text` |
| `TabBar` | **choix d'option dans une carte ou un tableau** (fréquence, rétention) | sans conteneur ; puce 12 h / 7 v ; choisi fond `field` ; survol `row-hover` ; texte `secondary` → `text` |
| `WizardStepper` | étapes d'assistant | pastilles 28 numérotées reliées par une ligne 2 (`border`, progression `text`) ; courante noire + halo 10 % ; faites noires cochées ; atteintes bordées `text` ; non atteintes `field-border` ; cliquable seulement si `canSelect` (pas grisé : `pointer-events:none`) ; survol scale 1.08 |
| `FolderBreadcrumb` | chemin d'un navigateur de dossiers | éléments style onglet (r8, courant fond `field` medium) séparés de chevrons 9 ; « … » non cliquable |

### 2.3 Conteneurs et lignes

| Composant | Rôle | Détails |
|---|---|---|
| `Card` | panneau | r16, bordure `border`, padding 18 (0 pour une liste de `SettingsRow`), option `fill` (même hauteur dans une rangée) |
| `SettingsRow` | ligne titre + description + contrôle à droite | icône `IconTile` optionnelle, titre 14 (mono possible), description 13 secondary |
| `RowDivider` | séparateur | 1 px `border`, retrait 16 |
| `SectionTitle` | titre au-dessus d'une carte | 15 medium |
| `CardTray` | plateau bas de carte pour ajouter | fond `sidebar`, trait haut `border`, coins bas 16 |
| `Banner` | information / alerte | icône 17 + texte 13.5 + action à droite ; fond/texte du ton ; r14 |
| `SelectableRow` | élément à cocher | `IconTile` 30, titre (grisé si décoché), interrupteur ; **toute la ligne bascule** ; survol `row-hover` |
| `FolderRow` | dossier à ouvrir | `IconTile` 28, nom, chevron ; 44 h ; toute la ligne ouvre ; survol |
| `WorkerRow` | tâche en cours | icône 15, titre 13 medium, détail 11.5 mono tronqué au milieu, roue ou coche verte |

### 2.4 Champs et choix

| Composant | Rôle | Détails |
|---|---|---|
| `cairnField(icon:prefix:)` | champ texte / mot de passe | capsule 34, fond `content`, bordure `field-border` 1 → `accent` 1.5 au focus (pas d'anneau natif), icône 15 ou préfixe mono (`~/`) ; état « refusé » : bordure danger 1.5 (mot de passe NAS) |
| `PathField` | chemin relatif au home avec complétion | préfixe `~/` ; suggestions **au-dessus** du champ (r14, ombre) : icône dossier/fichier + chemin mono ; ↑/↓ choisir, Tab/Entrée accepter, Échap fermer ; un dossier accepté garde la liste ouverte |
| `DropdownMenu` | liste déroulante | bouton bordé r10, valeur + chevron ; ouvre un `PopupMenu` avec coche sur la valeur |
| `PopupMenuButton` / `PopupMenuContent` | **tout menu** (« … », déroulants) | panneau `content` r14 bordé, ombré, padding 6, min 200 ; lignes 34 h r8 icône 16 + texte 14 ; colonne d'icônes dès qu'un élément en a une ; séparateurs ; destructif en rouge (`danger fg`), **en dernier** après un séparateur ; désactivé 0.4 + infobulle de raison ; aligné à droite du bouton (ou gauche), 6 px dessous, sinon au-dessus ; ferme sur clic dehors, Échap, perte de focus app |
| `ChoiceChip` | catégorie activable (outils IA, assistant) | capsule ; active noire avec coche ; inactive bordée, survol |
| `FilterChip` | filtre par catégorie (Nettoyable) | pastille + libellé + total ; actif teinté de la couleur |
| `ChoiceTile` | choix exclusif (type de destination, garder/supprimer) | icône tuile 32, rond coché en haut à droite, titre 14 medium + description ; choisie bordure `text` 1.5 ; survol `row-hover` |

### 2.5 Retour visuel

| Composant | Détails |
|---|---|
| `Badge` | capsule 11 semibold, 8 h / 3 v, ton |
| `FillBar` | jauge 8, piste `field`, remplissage couleur (min 4 px) |
| `SegmentBar` | barre empilée 8, segments séparés de 2, invisible si total nul |
| `MessageBar` | barre en bas du contenu : icône info, texte sélectionnable, croix ; trait haut |
| `HoverTooltip` (`.tooltip`) | bulle noire (`primary`) texte 13 blanc, r8, ombre, à **droite** de l'élément (décalage 48), délai 350 ms ; ne capte pas la souris |
| `ProgressView` | roue native (small/mini/regular) — à remplacer par un spinner maison |

### 2.6 Graphiques et marque

`BreakdownBar` (barre empilée par catégorie, 10 h, r3, largeur ∝ taille/échelle), `BreakdownChart` (anneau, rayon intérieur
60 %, inset 1°, total au centre + légende : pastille, nom, taille, %), `CategoryTag`, `ProjectBar`
(sources/.git/régénérable/worktrees externes), `Icon`, `IconTile`, `CairnLogo`.

### 2.7 Règles d'usage (DESIGN.md + lessons.md)

1. Un seul accent bleu ; noir pour l'action principale ; couleurs de ton réservées aux badges/bandeaux ; couleurs de
   catégorie aux graphiques ; couleurs de module à l'accueil seulement (l'état d'un module reste dit par un `Badge`).
2. Onglets d'une page → `PillPicker` ; choix dans une carte/un tableau → `TabBar`. Aucun contrôle segmenté natif.
3. Tout menu → `PopupMenuButton` (aucun menu natif, y compris clic droit) ; destructif rouge, en dernier.
4. Boutons uniquement `.pill*`. Tout bouton désactivé porte sa raison en infobulle.
5. Toute ligne cliquable a un survol ; toute la ligne bascule l'interrupteur.
6. Cartes sans ombre ; seuls les flottants ombrés.
7. Tout texte visible traduit (en + fr) ; tout nouvel écran réutilise les composants (pas de style local).
8. Destructif : explicite, confirmé, mode simulation, corbeille proposée par défaut.
9. Une référence visuelle (accueil type Avast) : grandes icônes colorées par module ; le neutre reste pour la structure.
10. Vérifier chaque écran en clair et en sombre (`Cairn --snapshot`) → en Electron : tests visuels Playwright × 2 thèmes.

---

## 3. Écrans

### 3.0 Cadre (`MainShell`)

- Cadre gris `rail` : barre du haut 38 (logo + « Cairn » centrés ; feux tricolores à gauche) et rail 56 à gauche.
- Corps flottant (r12, bordure, ombre, marge 6 droite/bas) = sidebar 248 (fond `sidebar`, trait droit) + contenu
  (`content`) + `MessageBar` en bas si `lastMessage`.
- Rail (haut) : Accueil `house`, Analyse `chart.pie`, Sauvegardes `icloud.and.arrow.up`, Outils IA `sparkles`,
  Outils CLI `terminal`, Git `arrow.triangle.branch`, Restauration `arrow.counterclockwise` ; (bas) bouton
  **Mise à jour** (rond accent 30, visible seulement si release dispo → popover), Réglages `slider.horizontal.3`,
  **StatusDot** (cercle 32 : coche/triangle/croix sur fond du ton ; roue sur fond `field` pendant une sauvegarde ;
  clic → section de la cause : sauvegarde en cours/backup, config invalide → Réglages…).
- Sidebar visible pour Accueil, Analyse, Réglages, Sauvegardes, Outils CLI (si inventaire) ; masquée pour Git, IA,
  Restauration.
- Raccourcis : ⌘O choisir un dossier, ⌘R relancer l'analyse, ⌘, Réglages, « Rechercher les mises à jour » sous « À propos »,
  ⌘↑ dossier parent (Explorateur).
- Racine : assistant si premier lancement, sinon cadre ; la langue change → tout est reconstruit.
- Fenêtre fermée + tâche de fond acceptée → l'app reste en barre des menus (pas de Dock).

### 3.1 Accueil (hub)

- **Sidebar** : titre « Accueil » ; Dossiers suivis (icône dossier ou `folder-x` si indisponible, taille analysée ou
  « indisponible » ; clic → Analyse du dossier) ; « Total » si plusieurs ; Destinations (pastille grise + « non vérifiée »,
  clic → Sauvegardes) ou « Ajouter une destination » ; Plus gros projets (6 premiers dossiers, clic → Explorateur).
- **En-tête** centré : cercle d'état 76 (coche/triangle/croix, couleur `StatusColor`) ; titre 28 medium
  (« Tout est en ordre » / « N choses à regarder » / « N à corriger ») ; jusqu'à 3 causes + « et N autres » ; « Vérifié il y a … » /
  « Jamais vérifié » ; bouton primaire « Tout vérifier » (icône `shield-check`, infobulle « lecture seule : rien n'est
  supprimé… ») ; pendant la vérification : roue + « Vérification… » + « Arrêter ».
- **5 cartes de module** (une ligne si ≥ 5×190 de large, sinon grille 3 colonnes ; min 260 h) : tuile d'icône 64 couleur
  de module ; nom (13 medium secondary) ; chiffre (20 semibold, 2 lignes) ; détail (12.5) ou « Vérification… » /
  « Échec » (rouge) ; mini-graphique 10 h ; bouton `.pillOutline` pleine largeur ; badge de ton en haut à droite
  (fr « À jour », « À optimiser », « À regarder », « À corriger » ; en « Up to date », « Can improve », « Needs a look », « Needs fixing ») ou roue pendant la vérification.
  - Stockage : chiffre « X libres » / « Pas analysé » ; détail « X récupérables » ; `FillBar` d'occupation du volume
    principal ; action Nettoyer / Analyser.
  - Sauvegarde : dernière sauvegarde (relative) / « Jamais » / « Sauvegarde en cours » / échec / injoignable / pas de
    destination ; détail prochaine sauvegarde (aujourd'hui HH:MM ou date) / « due » / « manuelle » ; 7 pastilles 9 pt
    (7 derniers jours : couleur module = réussi, rouge = échec, `field` = rien) ; action Sauvegarder maintenant
    (désactivée pendant une sauvegarde ou config invalide) / Ajouter une destination / Voir.
  - Git : « N candidats » / « Propre » ; détail récupérable ; `SegmentBar` branches (100 %) / worktrees (45 %) ;
    action Analyser / Optimiser.
  - Outils IA : « N outils » / « Aucun » ; dernière sauvegarde ; `SegmentBar` des tailles (opacités 1/.65/.4/.25) ; Voir.
  - Restauration : « N versions » / dernière version / « Aucune » ; détail destinations / abîmées / dernière version ;
    pas de graphique ; Restaurer.
- **Activité récente** (`SectionTitle` + carte) : 10 derniers événements (icône, texte, date à droite) ; vide : texte.
  Types : sauvegarde réussie/échouée, nettoyage (octets), nettoyage git (N), alerte disque (bas/critique), vérification
  (ok / N problèmes). Relue au retour au premier plan (événements écrits par la CLI).
- **Problème prioritaire** collé en bas (fond `content`, trait haut) : `Banner` danger (config, échec, disque critique)
  ou warning + bouton primaire « Résoudre » (navigue sans rien exécuter).

### 3.2 Analyse

- **Sidebar** : titre ; dossiers suivis (sélection = dossier affiché) ; « Total » ; « Ajouter un dossier » ;
  « Par type » (pastille de catégorie + taille, non cliquable) ; « N fichiers ».
- **Onglets** `PillPicker` (désactivés sans analyse ou pendant) : Explorateur · Nettoyable · Projets · Gros objets.
- **Vide** : icône disque 39, « Rien d'analysé », chemin, bouton primaire « Analyser ».
- **Analyse en cours** (`ScanningView`) : grande roue, « Analyse de <chemin> », « N fichiers · X », chemin courant tronqué,
  bouton « Arrêter ».
- **Suppression en cours** : surcouche « Suppression… » (matériau flouté).
- **Explorateur** : fil d'Ariane maison (chevron retour ⌘↑, éléments, « N éléments · X » à droite) ; liste à
  rangées alternées (icône catégorie/dépôt git, nom, `CategoryTag`, « dont X régénérable », `BreakdownBar` ∝ plus grand
  enfant, taille, %, chevron si dossier ouvrable) + ligne « N petits fichiers » ; sélection multiple ; double-clic : ouvrir
  ou révéler ; clic droit : Ouvrir, Afficher dans le Finder, Copier le chemin, Mettre à la corbeille…, Supprimer…
  (rouge) ; panneau droit 280–340 : chemin, tag, anneau `BreakdownChart`, note régénérable, « Afficher dans le Finder »,
  « Mettre à la corbeille ». Confirmation : titre « Mettre N éléments (X) à la corbeille ? » / « Supprimer
  définitivement… », 6 chemins + « et N autres », note (corbeille / irréversible).
- **Nettoyable** : puces de filtre (Tous + catégories régénérables avec total), champ de recherche ; tableau triable
  (Type, Chemin, Fichiers, Taille) multi-sélection ; pied : Tout sélectionner, Désélectionner, « N dossiers · X » /
  « N sélectionnés · X », « Supprimer… » (secondaire), « Mettre à la corbeille… » (primaire). Arrivée depuis une
  alerte : plus gros dossiers présélectionnés.
- **Projets** : « N projets », bouton « Maintenance git » si sélection = dépôt, recherche ; tableau (Projet + dossier
  parent, Répartition `ProjectBar`, Sources, .git, Régénérable, Worktrees « N · X », Total gras) ; clic droit :
  Ouvrir dans l'explorateur, Maintenance git, Finder, Copier.
- **Gros objets** : résumé « N fichiers > X, N dossiers > Y » ; tableau (Nom, Type, Emplacement, Dans [tag], Taille).

### 3.3 Sauvegardes

- **Sidebar** : titre ; Destinations (pastille : gris = non vérifiée, vert = joignable, orange = en attente ; méta
  « non vérifiée » / « en attente » ; **pendant une sauvegarde : anneau + %, ou roue** ; sélection) ; « Ajouter une
  destination » ; Contenu : dossiers sauvegardés, Home (N), Outils IA (N), Outils CLI (non cliquables).
- **Vide** : icône 39, « Aucune destination », bouton primaire « Ajouter une destination ».
- **En-tête de destination** : tuile 48 (`server`/`hard-drive`), nom 22 semibold, badges (non vérifiée / en attente /
  joignable ; chiffrée / non chiffrée [warning]), adresse ; à droite : menu « … » (Simuler [désactivé + raison],
  Copier l'adresse, ─, Supprimer la destination… [rouge]) ; « Modifier » ; puis **« Sauvegarder maintenant »** (primaire,
  désactivé + raison) ou, si cette destination est en cours, « Arrêter » / « Arrêt… » (désactivé).
- **Bandeaux** : info « une opération lancée par la commande cairn est en cours » ; info « sauvegarde en cours vers
  <autres> » ; warning « destination non chiffrée et ~/.ssh ou ~/.aws sauvegardés ».
- **Carte de progression** (`BackupProgressCard`, une par destination ; la sauvegarde traite les destinations en série
  pour la copie, la finalisation de l'une chevauche la copie de la suivante) :
  - Disposition : anneau 84 à gauche (trait 8, accent ; % centré 20 bold ; roue si % inconnu) ; à droite titre 16
    semibold, barre 6 accent, ligne de résumé 13 (chiffres tabulaires), ligne de détail 12.5 (tronquée au milieu).
  - **Phase 0 — en file** (destination visée mais pas encore de progression) : titre « Préparation de la sauvegarde… »,
    résumé « En attente : copie vers « <autre> » en cours. » ou « Préparation de la sauvegarde… » ; roue.
  - **Phase 1 — préparation** (`preparing`, commune à toutes les destinations visées) : titre « Préparation de la
    sauvegarde… » ; résumé = étape : « Liste de ce qu'il faut sauvegarder (dossiers, inventaire des outils, outils IA)… »,
    « Recherche des dossiers régénérables : <dossier> », « Inventaire des outils installés (Homebrew, npm…)… »,
    « Copie des données des outils IA… », puis par destination « Connexion à la destination et ouverture de l'image
    disque… » ; anneau = roue, barre vide, pas de workers.
  - **Phase 2 — copie** (titre « Sauvegarde en cours ») :
    - % = fichiers examinés / attendus, **plafonné à 99 %**. Attendus = décompte de la sauvegarde précédente ; sinon
      comptage parallèle pendant la copie → tant qu'il tourne, pas de % (roue), résumé « X fichiers sauvegardés ·
      comptage : Y trouvés » ; ensuite « X sur Y fichiers · Z copiés ». Ligne de détail : « Partie : <partie> ».
    - Bloc gris (`row-hover`, r12, padding 14 h) de `WorkerRow` séparées par des traits :
      - ligne **Copie** (icône `arrow.up.doc`, roue) : titre « Copie » ou « Copie · dossier n sur N : <dossier> »
        (« fichiers à la racine » si sans nom) ; détail = fichier courant (mono), sinon « rsync dresse la liste des fichiers
        (<durée>) — long pour un gros dossier, rien d'anormal » (durée rafraîchie chaque seconde) ou
        « rsync dresse la liste des fichiers… ».
      - **workers de comptage** (4 au plus, `BackupEngine.countWorkers`, affichés seulement tant que le total est
        inconnu) : icône `cpu`, titre « Worker i · <dossier> · N fichiers » (ou sans dossier), détail = dernier chemin vu /
        « rsync dresse la liste… » ; « Terminé » + coche verte quand fini.
    - Progression renvoyée au moins chaque seconde (pulsation).
  - **Phase 3 — finalisation** (`finishing`, titre « Finalisation de la sauvegarde… », pas de bloc workers ; anneau et
    barre = avancement de l'étape s'il est connu, sinon roue ; détail = fichier courant en mono 12) : « Liste des
    fichiers copiés… » → « Empreintes des nouveaux fichiers : X sur Y (relus sur la destination) » (avec %) →
    « Enregistrement de la version et application de la rétention… » → (mensuel) « Contrôle d'un échantillon des fichiers
    copiés… » → « Vérification de l'image disque (hdiutil verify)… » → « Fermeture et compactage de l'image disque
    (plusieurs minutes sur un NAS)… » (après réussite) ou « Fermeture de l'image disque… ».
  - **Fin** : la carte et l'indicateur sidebar de cette destination disparaissent ; les autres continuent.
  - Barre des menus pendant ce temps : icône animée, « Sauvegarde… NN % » / « Sauvegarde de <partie> » / « Préparation… ».
- **Carte de résultat** (dernière sauvegarde ou simulation) : titre « Sauvegarde » / « Simulation », « Voir le journal »,
  « Masquer » ; octets par partie (mono), trait, « Total sur <dest> » + « X · N fichiers » ; avertissements ;
  fichiers abîmés ; échec du contrôle d'image ; ou message d'erreur (secondaire si « en attente »). Échec avant toute
  destination : seul bouton « Voir le journal ».
- **Carte de vérification complète** : titre, roue « Vérification de toutes les versions… », puis par version : pastille,
  nom mono, « N fichiers contrôlés, M abîmés » / « empreintes en attente » ; jusqu'à 10 fichiers « ✗ » ; « Masquer ».
- **Rangée de 3 cartes de stat** (même hauteur) : Dernière sauvegarde (date / « Jamais » ; détail « X transférés en D »
  ou erreur) ; Prochaine (date / « Manuelle » ; « en attente depuis … » ou fréquence) ; Intégrité (« Aucune erreur » /
  « N versions abîmées » ; « vérifiée le … » / « jamais vérifiée ») + boutons « Vérifier » et « Tout vérifier »
  (désactivés + raison).
- **Historique** (carte large) + colonne 370 : **Rétention** (`TabBar` Recommandée / Nombre / Personnalisée ; steppers
  versions 1–520, jours 0–3650, semaines 0–520 ; « 30 jours en quotidien, puis 1 an en hebdo » ; couverture
  « ≈ X ans/jours, N versions max ») et **Planification** (fréquence · heure, interrupteur tâche de fond, batterie min,
  « Cairn ne réveille jamais le Mac »). Historique : « N versions », roue, « Actualiser » ; 12 dernières (pastille verte /
  orange, date, badge « abîmée », nom mono) + « et N autres » ; vides : chargement, « sauvegarde en cours : l'historique
  s'affichera à la fin », erreur, injoignable, aucune sauvegarde. Lu automatiquement à l'ouverture.
- **Dialogues** : rétention plus courte → « Supprimer N versions (X) ? » + liste (10) ; mot de passe d'image créé
  (alerte : Copier / C'est noté) ; feuilles Ajouter / Modifier / Supprimer (3.4).

### 3.4 Destination : formulaire et feuilles

- **Formulaire** (`DestinationForm`, partagé assistant/app ; rien d'enregistré avant vérification) :
  1. Tuiles de type (`ChoiceTile`, masquées en modification) : Plus tard (assistant seulement), Disque local, NAS (SMB).
  2. Local : `SettingsRow` « Dossier » (champ icône dossier, placeholder `/Volumes/Backup`, Entrée valide) + « Parcourir… ».
     SMB : Adresse (`smb://nas.local`, aide « hôte seul = liste des partages »), Utilisateur, Mot de passe (bordure rouge
     si refusé ; aide Trousseau) + plateau : « Se connecter » / « Se reconnecter » (primaire, désactivé sans hôte ou
     pendant la vérif) + adresse finale mono ou aide.
  3. Choix du partage (hôte seul) : carte « Dossiers partagés » + `FolderRow` ; clic = montage + dossier `cairn`.
  4. Navigateur (`FolderBrowser`) : fil d'Ariane (« Emplacements » › volume › …) + badges d'images trouvées (« ce Mac »,
     « sauvegarde de <machine> ») ; liste de `FolderRow` (5 visibles) ; vide « Dossier vide » / « Aucun emplacement » ;
     accès refusé (cadenas + motif + « Remonter ») ; plateau « Nouveau dossier » + « Créer » + erreur.
  5. État de vérification : non vérifié (aide + « Vérifier ») ; vérification/connexion (roue + « Annuler ») ; vérifié
     (bandeau success « Dossier accessible, X libres » + bandeaux info d'images : ce Mac, autre machine + « Restaurer
     cette sauvegarde » dans l'assistant) ; échec (bandeau danger motif + conseil + « Réessayer »).
  6. Chiffrement : `SettingsRow` interrupteur (décocher → confirmation « Désactiver le chiffrement ? ») ; figé en
     modification (note) ; bandeau info « dossier changé : les sauvegardes faites restent à l'ancien » ; bandeau warning si
     non chiffré.
  - Invalidation automatique : toute modification d'adresse/identifiant/mot de passe/dossier, ou démontage du volume.
- **Feuille Ajouter / Modifier** (760×720) : en-tête (22 medium + texte), trait, formulaire défilant, trait, pied 60 :
  « ! Vérifiez la destination pour continuer » ; Annuler (Échap) ; « + Ajouter » / « ✓ Enregistrer » (primaire,
  désactivé tant que non vérifié). Fermeture : démonte ce que Cairn a monté.
- **Feuille Supprimer la destination** (640×620) : deux `ChoiceTile` « Garder les sauvegardes » (défaut) / « Supprimer aussi
  les sauvegardes » ; aperçu « Ce qui sera retiré » (configuration, état, sauvegardes X + chemin) ; simulation requise
  pour supprimer les sauvegardes (« Simuler », roue « Simulation… ») ; erreurs en bandeau ; pied : note, Annuler,
  Simuler, bouton `.pillDanger` « Supprimer la destination » / « Supprimer la destination et X » (désactivé pendant une
  sauvegarde, + raison). Restaure la config si la suppression échoue.

### 3.5 Git (sans sidebar)

- En-tête 64 : `PillPicker` Dépôts · Branches · Worktrees (onglet par défaut : Worktrees) ; à droite « Exporter… »
  (onglet Branches, TSV) et « Analyser à nouveau » (infobulle « l'analyse est en lecture seule »).
- Vide : icône 39, intro, « Analyser ». Analyse sans résultat encore : roue + « Recherche des dépôts… » / « N sur M dépôts ».
- Résultats (affichés au fil de l'eau) : filtre « Dépôt : <chemin> » + « Tous les dépôts » ; 7 cartes de stat (Dépôts,
  Taille .git, Branches, Worktrees, Obsolètes, À risque [warning], Récupérable) ; tableau dans un conteneur r14 ; pendant
  l'analyse : barre linéaire 160 + « N sur M » (suppressions désactivées « attendez la fin de l'analyse »).
  - Dépôts : Dépôt, Dernière activité, .git, Objets non compactés, Branches, Worktrees, Récupérable (triables) ; « … » :
    Afficher dans le Finder, Copier le chemin, Analyser ce dépôt seulement, Compacter…, ─, Mettre le dépôt à la corbeille… (rouge).
  - Branches : Dépôt, Branche (mono + « extraite dans <worktree> »), Statut (badge fusionnée/squashée = success, non
    fusionnée = warning), Dernier commit, Sujet ; « … » : Copier le nom, ─, Supprimer la branche… (désactivé si extraite).
  - Worktrees : Worktree (+ dépôt), Branche, Statut (risque = warning, actif = info, orphelin = neutre, sinon success ; +
    « N fichiers modifiés, M commits non poussés »), Modifié, Taille ; « … » : Finder, Copier, ─, Supprimer le worktree….
  - Vides : « Aucune branche à nettoyer » etc. ; roue pendant l'analyse.
- **Feuille de confirmation** (520) : titre 17 semibold, détail, case « supprimer aussi la branche <b> (statut) », avertissement
  rouge du travail perdu + case « Je comprends que ce travail sera perdu » (requise), note journal ; compactage : case
  « libérer tout de suite (prune now) » + explication ; boutons Annuler / Supprimer · Mettre à la corbeille · Compacter.
- Après action : message « N branches, M worktrees supprimés » / « <dépôt> compacté : X → Y » ; seul le dépôt est remesuré.

### 3.6 Outils IA (sans sidebar)

Titre 26 ; bandeau (lock « identifiants sauvegardés car toutes les destinations sont chiffrées » info / lock-open
« identifiants ignorés : destination non chiffrée » warning) ; mesure en cours (roue + « Mesure… ») ; grille 3 colonnes de
cartes par outil : nom, taille sauvegardée (infobulle), badge « non détecté » ; racine mono ; dernière sauvegarde ;
conversations (N, dernière) ; trait ; une case par catégorie avec taille ; avertissements (identifiants ignorés,
identifiants dans le Trousseau) ; « X jamais copiés » ; exclusions. Pied : note SQLite, « Simuler », « Sauvegarder les
outils IA » (primaire, désactivé sans destination / pendant une sauvegarde).

### 3.7 Outils CLI

Sidebar (si inventaire) : Sources (Homebrew, npm… + nombre) ; Statut (utilisé, inutilisé, manquant + nombres).
`PillPicker` filtre Tous / Utilisés / Inutilisés / Manquants ; collecte : roue + « Inventaire en cours… ». Recherche +
note « applications non listées » ; tableau triable : Garder (case), Outil (mono), Source, Version (mono), Pourquoi,
Statut (badge success/neutral/danger) ; pied : « N retenus sur M » (semibold), note d'export, « Actualiser », « Exporter… »
(primaire, choix d'un dossier).

### 3.8 Restauration (sans sidebar)

Assistant en 4 étapes sans stepper visible : titre 26 (« D'où restaurer ? », « Quelle version ? », « Quoi restaurer ? »,
« Récapitulatif ») ; bandeaux erreur / « quittez <outil> pour continuer » ; roue si occupé ; « Retour » / « Continuer » /
« Restaurer » (confirmation native « Restaurer ? … »).
1. Source : texte ; un bouton pill par destination configurée ; « Choisir un dossier… » ; carte mot de passe (partage ou
   image, champ + « Valider ») si demandé ; carte « NAS non configuré » (adresse smb://, utilisateur, « Se connecter »).
2. Version : liste (date, « partielle », machine) ; « Aucune version ».
3. Parties : cases Outils CLI (inventaire), Home, chaque outil IA, « Remplacer les bases de données », chaque dossier +
   cible (« Vers : … » + « Changer… ») + bandeau « volume absent » (+ « Créer le volume workspaces »).
4. Récapitulatif : tailles par partie + total, note « une copie de sécurité est faite avant » ; après exécution : liste
   des étapes (coche / croix rouge + détail) + bandeau info « actions manuelles restantes ».
Colonne droite 320 « Sauvegarde choisie » : date, machine, architecture (⚠︎ + avertissement si différente), format
(Cairn / backup.sh), note Terminal ; « Vérifier » les outils (présents/manquants). Les commandes admin s'ouvrent dans le
Terminal ; l'app attend la fermeture des outils IA.

### 3.9 Réglages

Sidebar : titre ; « Fichier » › `config.toml` (révéler) ; aide « éditable à la main, commentaires conservés ».
Page (max 760, titre 28) : bandeau danger si config invalide (tout le reste désactivé, sauf Fichier).
- Général : Langue (`DropdownMenu` Automatique / English (US) / Français) ; Mises à jour (« version X » ; « Rechercher » +
  interrupteur vérification auto).
- Dossiers suivis : ligne par dossier (icône / indisponible + badge, chemin abrégé, « Sauvegarder » + interrupteur,
  corbeille) ; plateau « Ajouter un dossier ».
- Home : une ligne par élément du home (déjà inclus + trouvés), tri alphabétique, interrupteur ; plateau `PathField` +
  « Ajouter » (primaire).
- Planification : Fréquence `TabBar` (Quotidienne / Hebdomadaire / Manuelle) ; Heure (HH:MM, valeur invalide ignorée) ;
  Jour (`DropdownMenu`, hebdo) ; tâche de fond ; batterie min (stepper pas 5).
- Alertes de stockage : seuils bas / critique (steppers, libellés avec % et Go).
- Maintenance : rétention des journaux (pas 15 j), worktree obsolète après N jours, `git gc` après nettoyage.
- Fichier de configuration : chemin mono + « Afficher dans le Finder ».

### 3.10 Assistant de premier lancement (`OnboardingView`)

Plein écran sans cadre. En-tête 56 : logo 22 + « Bienvenue dans Cairn » ; « Restaurer plutôt » (`.pillOutline`). Stepper
6 étapes (Dossiers, Home, Outils IA, Destination, Planification, Notifications ; retour libre, avance jusqu'à atteinte+1 si
étapes valides). Page centrée max 680 : titre 28 regular + texte. Pied 60 : « ‹ Retour », « Étape n sur 6 », problème de
validation (warning), « Continuer → » (primaire, désactivé si invalide) / « ✓ Terminer » (renvoie à la 1re étape invalide).
- Dossiers : en-tête « N sur M sélectionnés » + « Tout sélectionner/désélectionner » (lien accent) ; `SelectableRow` ;
  plateau « Ajouter un dossier ». Requis : ≥ 1.
- Home : idem avec chemins `~/…` mono, icône déduite (historique, ssh, aws, docker, git, shell, npm, netrc…) ; vide :
  « rien trouvé » ; plateau `PathField` + « Ajouter ».
- Outils IA : carte par outil (badge détecté / non détecté, opacité 0.6 si absent), `ChoiceChip` par catégorie ; note
  « identifiants seulement si chiffré ».
- Destination : `DestinationForm` avec « Plus tard » ; validations (chemin, adresse SMB, vérification).
- Planification : carte de 3 points (barre des menus, ouverture à la connexion, jamais de réveil) ; fréquence `TabBar`,
  heure (validée HH:MM), jour, tâche de fond.
- Notifications : interrupteur ; « Récapitulatif » (dossiers N, home N, IA N, destination) avec coche/tiret et « Modifier ».
Rien n'est écrit avant « Terminer ».

### 3.11 Barre des menus (`MenuBarExtra`, panneau 360, padding 16)

Icône : `layers` (ok) / triangle / octogone ; animée pendant une sauvegarde. Panneau : logo + « Cairn » + badge d'état
(si pas ok) + icône Réglages ; jauge anneau 118 du volume principal (libre au centre, « X utilisés sur Y » ; couleur
accent / orange bas / rouge critique) + autres volumes en `FillBar` ; tuile « Récupérable » (X, barre par catégorie,
détail par type, worktrees obsolètes + corbeille) ; tuile sauvegarde (icône, « Sauvegardé le … » / progression / « Aucune
sauvegarde », « en attente de <dest> » / « aucune destination », prochaine sauvegarde / « due » / « manuelle ») ; tuile
« Analyse ancienne/absente » + « Analyser » ; tuiles d'alerte disque ; bouton primaire pleine largeur « Nettoyer X » ;
« Sauvegarder maintenant » (pill, désactivé) + menu « … » (Analyser, Ouvrir Cairn, Réglages, ─, Quitter Cairn) ; pied
« Analysé le … ». Tuiles : fond `field` r14 padding 12.
Notifications système : disque bas/critique (actions « Nettoyer », « Plus tard »), sauvegarde en retard, échec, fichiers
abîmés, échec de l'image (avec ouverture du journal).

### 3.12 Mise à jour

Bouton du rail (accent) → popover 400 : « Cairn X disponible », « actuelle → X » mono, notes du CHANGELOG (titres gras,
puces •, liens Markdown, défilement 220 max) ; échec : bandeau danger ; blocage : texte (« sauvegarde en cours » / « app
non installable ») ; « Plus tard », « Page de la release », « Installer » (primaire, désactivé + blocage) ou roue
« Téléchargement… ». Installation : télécharge, vérifie, remplace le bundle, relance. Réglages : vérification auto + bouton.

---

## 4. Problèmes d'UI à corriger dans la nouvelle version

**Écarts avec DESIGN.md / lessons**
1. Menus natifs restants malgré « aucun menu natif » : clics droits (Explorateur, Nettoyable, Projets, Gros objets).
   → `PopupMenu` contextuel + menu « … » par ligne (comme Git).
2. Dialogues natifs (`confirmationDialog`, `alert`) : suppression Explorateur/Nettoyable, rétention, chiffrement,
   Restaurer, mot de passe d'image. → une feuille de confirmation maison (en-tête, aperçu, pied, `.pillDanger`).
3. Contrôles natifs : `Stepper` (rétention, Réglages), cases `.checkbox` (feuille Git, parties Restauration, cartes IA,
   colonne Garder), `Table`/`List`/`HSplitView`, `Divider()`, barre linéaire (Git), `ProgressView`, popover de mise à jour.
   → composants `NumberStepper`, `Checkbox`, `DataTable` (tri, sélection, survol, menu « … ») à ajouter au design system.
4. Boutons sans style `.pill*` : feuille Git (Annuler/Supprimer natifs), Tout sélectionner/Désélectionner (Nettoyable),
   « Maintenance git » (Projets), « Arrêter » de l'analyse, chevron du fil d'Ariane de l'Explorateur, icône Réglages du menu barre (sans survol).
5. Couleurs hors jetons : `orange`, `red`, `accentColor`, `gray`, `white`, `.regularMaterial` ; styles de texte système
   (`.callout`, `.caption`, `.headline`, `.title3`, `.secondary`/`.tertiary`) dans Explorateur, listes, graphiques,
   `ScanningView`, `FilterChip`, `MessageBar`. → ajouter un ton « attention » (orange) dans les jetons, tout passer par les variables.
6. Icônes mixtes : `Label(systemImage:)`/`Image(systemName:)` contournent `Icon` (Modifier `gearshape`, `network`,
   `arrow.clockwise`, `plus`, chevrons/coche de l'assistant, `arrow.down.to.line`, `exclamationmark.circle`, `arrow.up`,
   coches de `ChoiceTile`/`ChoiceChip`/`StepNode`, `CategoryTag`) ; noms absents de la table → repli SF (`arrow.up.doc`,
   `cpu`, `play.circle`, `link`, `macwindow`, `power`, `moon`, `externaldrive.badge.checkmark`…). L'assistant est encore
   en SF. → 100 % Lucide en Electron.
7. Barre du haut : 38 pt dans le code, 44 dans DESIGN.md ; DESIGN parle d'une bascule de sidebar et d'un logo seul en
   pastille, le code n'a pas de bascule et ajoute « Cairn ». DESIGN dit `PillPicker` « réservée à l'accueil » alors qu'il sert
   aux onglets de page (et l'accueil n'en a plus). Menu « … » décrit « rond gris » : c'est un carré r10 sans fond.
8. Deux systèmes d'infobulle : `.tooltip` maison (rail, hub) et `.help` natif (raisons de désactivation, chemins). Le
   `.tooltip` s'affiche toujours à droite (décalage 48, pensé pour le rail) : mal placé sur le bouton centré « Tout vérifier ».
   → un seul `Tooltip` positionné (haut/droite), qui marche aussi sur un bouton désactivé (enveloppe).
9. Échelle de titres incohérente : 28 / 26 / 24 / 22 semibold / 22 medium / 17 ; titres de carte 15 semibold vs
   `SectionTitle` 15 medium. Pages sans titre (Analyse, Git, Outils CLI) et pages avec (Réglages, IA, Restauration).
   → `PageHeader` unique (titre 28 medium + actions à droite, onglets en dessous).
10. Fil d'Ariane de l'Explorateur maison (≠ `FolderBreadcrumb`) ; Explorateur à rangées alternées (style natif).
11. `IconTile`/`FolderRow` utilisent un chevron SF ; `FilterChip` n'a pas de survol ; `SidebarRow` cliquable sans survol
    (règle « toute ligne cliquable a un survol »).
12. Même concept, deux composants : catégories IA en `ChoiceChip` (assistant) et en cases (page Outils IA).

**Bugs / navigation**
13. Sidebar Accueil « Ajouter une destination » mène aux **Réglages**, qui n'ont pas de section Destinations.
14. Sidebar Accueil : destinations toujours « non vérifiée » (n'utilise pas `destinationWaiting`) ; libellé brut `d.id`
    sauf pour la destination de l'assistant.
15. Lignes de sidebar non cliquables qui ressemblent à des filtres : « Par type » (Analyse), Sources/Statut (Outils CLI,
    doublon du `PillPicker`), Contenu (Sauvegardes).
16. Git : onglet par défaut Worktrees alors qu'il est le 3e ; 7 cartes de stat sur une ligne (serré à 1100 px).
17. Restauration : 4 étapes sans `WizardStepper` ; liste de versions sans survol ; pas de progression pendant
    l'exécution (petite roue) ; glyphes texte « ⚠︎ », « ✗ ».
18. `ComingSoonView` / `placeholder.soon` : inatteignable (toutes les sections existent) → à supprimer.
19. Page Sauvegardes : carte Planification en lecture seule sauf un interrupteur (doublon des Réglages) ; historique limité
    à 12 sans « tout voir ».
20. Réglages : heure invalide ignorée sans retour ; suppression d'un dossier suivi sans confirmation ni annulation.
21. Messages : `MessageBar` unique, écrasée par le suivant ; erreurs techniques brutes (`String(describing: error)`) et
    concaténation « titre — corps » → toasts empilés + texte d'erreur lisible + lien vers le journal.

**Textes peu clairs**
22. Badges en minuscules (« non vérifiée », « en attente », « non chiffrée ») vs badges du hub capitalisés.
23. « Worker 1 · … » (jargon) → « Comptage 1 · … » ; « rsync dresse la liste… » (jargon technique visible).
24. « Vérifier » / « Tout vérifier » (intégrité) homonymes du « Tout vérifier » du hub (lecture seule de tout) ;
    « Masquer » pour fermer un résultat ; « Optimiser » (Git) vague ; « Can improve » / « À optimiser » (badge info, flou).
25. `docs/images/home.png` (+ `-fr`) obsolète ; captures du README à refaire.

---

## 5. Traductions

- **934 clés** dans `en.lproj/Localizable.strings` et autant dans `fr.lproj` (mêmes clés, aucun écart, aucun doublon),
  + **18 entrées de pluriel** dans `Localizable.stringsdict` (en et fr) : `cli.git.summary`, `cli.git.repo_line`,
  `cli.git.confirm`, `git.done`, `list.repos`, `onboarding.summary.{folders,home,ai}`, `hub.title.{attention,error}`,
  `hub.more_causes`, `hub.figure.{git_candidates,ai_tools,versions}`, `hub.detail.{destinations,damaged}`,
  `hub.activity.{git_cleanup,check_issues}`.
- Répartition par préfixe : backup 110, gallery 105, cli 72, git 71, onboarding 65, hub 64, probe 48, restore 45,
  destination 39, action 32, ai 26, settings 23, toml 21, col 21, config 20, category 16, update 15, inventory 15, menu 13,
  sidebar 10, source 8, section 8, weekday 7, list 7, alerts 7, tab 6, home 6, explorer 6, worktree 5, confirm 5, …
  (`cli.*` et `toml.*` = 93 clés de la ligne de commande et du parseur ; `gallery.*` = catalogue).
- **Convention** : identifiants anglais stables, segments en minuscules `snake_case` séparés par des points,
  `<domaine>.<sous-partie>.<élément>` (`backup.progress.finishing_title`, `onboarding.destination.disable_encryption.confirm`) ;
  actions génériques sous `action.*` (`action.backup_now`, `action.trash_ellipsis` = libellé avec « … ») ; colonnes
  `col.*` ; sections `section.<id>` ; infobulles en suffixe `.help` ; textes d'aide `.text`/`.hint`/`_note`.
- **Clés construites à l'exécution** (à préserver, non détectables statiquement) : `section.<id>`, `frequency.<f>`,
  `weekday.<j>`, `status.<s>`, `branch.status.<s>`, `worktree.status.<s>`, `inventory.status.<s>`, `inventory.badge.<s>`,
  `source.<s>`, `ai.category.<c>`, `kind.<k>`, `hub.module.<m>`, `onboarding.<étape>.{title,heading,text}`,
  `onboarding.schedule.point_*.{title,text}`, `restore.step.<étape>.heading`, `gallery.group.<g>`, `gallery.control.<k>`,
  `gallery.option.<o>`.
- **Format** : printf Apple (`%@`, `%lld`, positionnels `%1$@`, `%%`) ; les nombres sont pré-formatés (`Fmt.bytes`,
  `Fmt.count`, `Fmt.date`, `Fmt.duration`) et passés en `%@`. Dates relatives via `RelativeDateTimeFormatter`
  (→ `Intl.RelativeTimeFormat`, majuscule en début de phrase). Langues : `en-US`, `fr-FR`, `auto` = système (fr si
  première langue fr, sinon en). Garder les clés telles quelles ; convertir les `.strings`/`.stringsdict` en JSON
  (printf conservé via un `sprintf`, ou ICU MessageFormat généré) ; reprendre le test « aucun texte non traduit ».

---

## Résumé

1. Jetons complets (neutres, 5 tons, 5 couleurs de module, 8 de catégorie, clair/sombre) prêts en variables CSS (§1).
2. Typo SF Pro 11–28, rayons 8/10/12/14/16 + capsules, ombres réservées aux flottants + corps de fenêtre.
3. 30 composants CairnUI (43 stories en 8 groupes) avec états ; règles : PillPicker = onglets de page, TabBar = choix
   dans une carte, PopupMenu partout, boutons `.pill*`, désactivé + raison.
4. 12 écrans/panneaux décrits, dont la progression de sauvegarde en 4 phases (préparation, copie + ≤ 4 workers de
   comptage, finalisation en 7 étapes, fin par destination).
5. 25 problèmes : contrôles/menus/dialogues natifs restants, couleurs et icônes hors système, titres incohérents,
   lien « Ajouter une destination » cassé, jargon (« Worker », rsync), captures obsolètes.
6. Aucune capture Codex de référence dans le repo.
7. 934 clés × 2 langues + 18 pluriels ; convention `domaine.sous_partie.élément`, clés dynamiques à préserver.

Fichier : `/private/tmp/claude-501/-Users-romainlenzotti--claude-spares-spare-fLVdGi/3ab24817-00e6-4eb1-9b80-03320e572738/scratchpad/inventory-ui.md`
