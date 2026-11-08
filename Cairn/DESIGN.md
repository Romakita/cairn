# Design system de Cairn

Repris des écrans de réglages de Codex (app de bureau ChatGPT) : neutre, aéré, un seul accent bleu, le noir pour
l'action principale. Les jetons sont dans `Sources/Cairn/Theme.swift`, les composants dans
`Sources/Cairn/Components.swift`. Tout nouvel écran les réutilise plutôt que de recréer un style local.

## Couleurs (`Palette`)

| Jeton | Clair | Sombre | Usage |
|---|---|---|---|
| `content` | `#FFFFFF` | `#181818` | fond des pages et des cartes (corps) |
| `sidebar` | `#FCFCFC` | `#1F1F1F` | barre latérale, plateau bas de carte (`CardTray`) |
| `rail` | `#F3F3F3` | `#1B1B1B` | cadre de la fenêtre : barre du haut et rail d'icônes |
| `field` | `#F2F2F2` | `#2A2A2A` | bouton secondaire, onglet choisi, piste de jauge |
| `rowSelected` / `rowHover` | `#EDEDED` / `#F6F6F6` | `#2C2C2C` / `#222222` | élément actif / survolé |
| `border` / `fieldBorder` | `#E6E6E6` / `#DCDCDC` | `#2F2F2F` / `#3A3A3A` | cartes / champs et menus |
| `text` / `tertiary` / `secondary` | `#222529` / `#3D3D3D` / `#8F8F8F` | `#F2F2F2` / `#D0D0D0` / `#9B9B9B` | titres / texte / descriptions |
| `accent` | `#3B6FE0` | `#5B8DEF` | liens, interrupteurs, focus |
| `primaryButton` | `#0D0D0D` | `#F2F2F2` | action principale, infobulle |

Les tons `success`, `warning`, `danger`, `info` restent réservés aux badges et bandeaux ; les couleurs de
catégories aux graphiques.

Couleurs de module (`Palette.module`, accueil seulement) : Stockage bleu `#2563EB`, Sauvegarde vert d'eau `#0D9488`,
Git orange `#EA580C`, Outils IA violet `#7C3AED`, Restauration indigo `#4F46E5` (variantes claires en sombre). Elles
teintent la grande tuile d'icône des cartes (64 pt, fond à 13 %) et leurs mini-graphiques ; l'état d'un module
reste dit par un `Badge` de ton (« À jour », « À regarder »…), et l'action principale reste noire.

## Fenêtre (`MainShell`)

Comme Codex : un cadre gris uni (`rail`, `#F3F3F3`, relevé sur une capture de Codex) porte la
barre du haut (44 pt : boutons de fenêtre, bascule de la barre latérale, logo de Cairn centré en pastille noire) et le
rail d'icônes. La barre latérale (fond `sidebar`, gris clair distinct du cadre) et le contenu (blanc) partagent un corps qui flotte dans ce cadre : rayon 12, bordure
1 pt `border`, ombre douce (noir 10 %, rayon 10, y 2), marge de 6 pt à droite et en bas. C'est la seule ombre d'un
élément non flottant.

## Typographie

Police système (SF Pro), graisses légères :

- titre de page 28 pt `medium` (« Réglages ») ; titre d'assistant 28 pt `regular`, centré ;
- titre de section au-dessus d'une carte 15 pt `medium` (`SectionTitle`) ;
- titre de ligne 14 pt `regular`, description 13 pt `secondary` ;
- chemins et fichiers en `monospaced`.

## Formes

- Carte : rayon 16, bordure 1 pt `border`, **sans ombre**.
- Bouton : rayon 10, hauteur 32.
- Champ : capsule, hauteur 34, bordure `fieldBorder`, bordure `accent` 1,5 pt au focus.
- Seuls les éléments flottants ont une ombre (segment choisi, liste de suggestions, infobulle).

## Composants

| Composant | Rôle | Équivalent Codex |
|---|---|---|
| `Card` + `SettingsRow` + `RowDivider` | panneau de réglages : titre, description, contrôle à droite | « Autorisations », « Général » |
| `SectionTitle` | titre au-dessus d'une carte | « Autorisations » |
| `CardTray` | plateau gris en bas de carte pour ajouter un élément | barre sous la zone de saisie |
| `.buttonStyle(.pillPrimary / .pill / .pillOutline / .pillDanger)` | noir / gris plein / bordé / rouge | « Ajouter », « Gérer », « Parcourir le répertoire », confirmation d'une suppression |
| `PillPicker` | bascule segmentée en capsule (réservée à l'accueil) | « Chat / Work » |
| `TabBar` | groupe de boutons : texte gris, choix courant dans une pilule grise, sans conteneur ; onglets de page et choix d'option (rétention, fréquence) | « Public  Personnel » |
| Menu « … » | bouton rond gris avant « Gérer » ; action destructive en rouge, en dernier | « Copier le lien / Désinstaller » |
| `DropdownMenu` | menu déroulant bordé avec chevron | « Terminal ⌄ » |
| `.cairnField(icon:prefix:)` | champ capsule (remplace `.roundedBorder`) | « Rechercher des dépôts » |
| `PathField` | champ `~/` avec complétion (↑ ↓, Tab, Entrée, Échap) | menu « Choisir un projet » |
| `IconTile` | icône dans une tuile bordée | icônes de plugins |
| `IconButton` | icône discrète (corbeille) | corbeille des chats archivés |
| `RailButton` + `.tooltip()` | rail d'icônes, actif sur fond gris sans ombre, infobulle sombre | rail de gauche |
| `Badge`, `Banner`, `FillBar` | étiquette, bandeau, jauge | « 100 % restants » |
| `DestinationForm` (+ `FolderBrowser`, `VerificationStatus`) | ajout d'une destination : type, connexion, navigateur à fil d'Ariane, état de vérification ; assistant et feuille de l'app | « Parcourir le répertoire » |

## Iconographie

Icônes [Lucide](https://lucide.dev) 1.61.0 (licence ISC, `Resources/Icons/LUCIDE-LICENSE.txt`), embarquées en SVG
(`lucide-<nom>.svg`, trait ramené à 1,6) et affichées par `Icon(nom, size:)`, teintées comme le texte. Le code garde
les noms de symboles SF comme identifiants ; `LucideIcons.map` (CairnCore) donne l'icône Lucide de chacun, et un
nom absent reste un symbole SF. Pour une nouvelle icône : télécharger le SVG de la même version, le passer à 1,6,
l'ajouter à la table (le test `Icons.every_mapped_lucide_icon_is_bundled` vérifie la présence). Restent en symboles
SF : l'icône de la barre des menus, la coche des menus natifs et l'assistant (`OnboardingView`, à migrer).

## Interaction

- Toute ligne cliquable a un état de survol (`rowHover`) ; toute la ligne bascule l'interrupteur.
- Animations courtes : `.easeOut(0.12–0.15)` pour les états, `.snappy(0.25–0.3)` pour les changements d'étape.
- Les actions destructrices restent explicites et confirmées (voir AGENTS.md).
