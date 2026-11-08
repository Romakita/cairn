# Design

## Context

Voir proposal.md pour la motivation. Points de départ dans le code :

- `DestinationFormModel` / `DestinationForm` (app) portent déjà la saisie, la connexion, le navigateur de dossiers
  et la vérification ; `saveNewDestination` enregistre le mot de passe du NAS comme mot de passe Internet du
  Trousseau (hôte + identifiant), puis ajoute la destination à `config.toml`.
- Le mot de passe de l'image chiffrée est rangé sous `fr.lenzotti.cairn.image.<id>` : il dépend de l'identifiant de
  la destination, comme l'état `runs.json` et le choix de rétention.
- Une destination contient, pour ce Mac : l'image `cairn-<machine>.sparsebundle` (NAS ou destination chiffrée), ou
  le dossier `cairn/<machine>` (dossier local non chiffré). D'autres Mac peuvent y avoir leurs propres images.
- Sans mot de passe saisi, `ProbeSession.connect` se rabat sur le Trousseau (`SMBProvider`).

## Goals / Non-Goals

**Goals:**
- Corriger la connexion d'une destination sans toucher à son historique.
- Supprimer une destination de façon explicite, simulable, et sans jamais toucher aux sauvegardes d'autres Mac.
- Historique chargé seul, sans bloquer l'interface ni laisser de partage monté.

**Non-Goals:**
- Changer le type (local ↔ NAS) ou le chiffrement d'une destination existante : cela revient à créer une nouvelle
  image ; l'utilisateur ajoute une nouvelle destination.
- Déplacer les sauvegardes existantes quand le dossier change.
- Commande CLI de suppression (l'app suffit ici ; la simulation fait partie du dialogue).

## Decisions

1. **Identifiant conservé à la modification.** `CairnConfig.Destination.updatingConnection(from:)` (CairnCore,
   testable) recopie seulement `path`, `url` et `username` de la destination vérifiée sur l'originale. Alternative
   écartée : remplacer la destination entière (perdrait la rétention, et un nouvel identifiant rendrait le mot de
   passe de l'image introuvable).
2. **Formulaire réutilisé, type et chiffrement figés.** `DestinationFormModel(editing:)` préremplit le formulaire ;
   `DestinationForm` reçoit un mode `editing` qui masque les tuiles de type et montre le chiffrement en lecture
   seule. Mot de passe vide = celui du Trousseau ; le Trousseau n'est écrit que si un mot de passe a été saisi.
   Pour un NAS, le formulaire s'ouvre sans se connecter (pas de montage surprise) ; l'utilisateur clique
   « Se connecter ».
3. **Plan de suppression dans CairnCore.** `DestinationRemoval.plan(destination:includeBackups:paths:machine:)`
   rend une liste d'éléments (`config`, `state`, `imagePassword`, `backups` avec chemin et taille) ; c'est la
   simulation. `execute(plan)` prend le verrou d'opération (`OperationLock`), supprime les sauvegardes d'abord,
   puis le mot de passe de l'image, l'état et enfin la configuration (via l'appelant). Si la suppression sur la
   destination échoue, rien d'autre n'est retiré. Les sauvegardes sont supprimées définitivement : la corbeille
   n'existe pas sur un partage SMB, ce que le dialogue dit en clair. La taille est calculée avec `du -sk`-équivalent
   (`BackupEngine.uniqueBytes` pour un dossier, taille allouée du sparsebundle).
4. **Feuille plutôt qu'un `confirmationDialog`.** La suppression a besoin d'un choix (garder / supprimer les
   sauvegardes), d'une simulation et d'une liste : une feuille (`DeleteDestinationSheet`) avec un bouton
   « Simuler » puis « Supprimer » (destructif) qui n'apparaît qu'après la simulation quand on supprime les
   sauvegardes. Garder les sauvegardes ne demande pas de simulation (rien n'est effacé sur la destination) mais
   montre la liste des éléments retirés de Cairn.
5. **Historique chargé à l'apparition.** `.task(id:)` sur l'identifiant de destination et l'état « joignable »
   appelle `loadVersions` si la liste n'est pas déjà chargée et qu'aucune sauvegarde n'est en cours ; un état
   `versionsLoading` évite les doubles chargements. `loadVersions` ferme toujours la session (démontage), y compris
   en cas d'erreur. Après une sauvegarde, la liste est invalidée puis rechargée. En mode `--snapshot`, aucun
   chargement réseau : la liste est posée par le rendu.
6. **Boutons désactivés avec raison.** Une fonction pure `BackupActions.availability(...)` (CairnCore) rend, pour
   chaque action, `nil` (disponible) ou la clé de la raison ; testable sans interface. « Joignable » inconnu (pas
   encore sondé) ne bloque pas.
7. **Hauteurs égales.** Les cartes d'une rangée prennent `maxHeight: .infinity` dans une `HStack` en
   `fixedSize(horizontal: false, vertical: true)` : la rangée prend la hauteur de la plus haute carte. `Card` gagne
   un paramètre `fill` pour s'étirer en hauteur sans changer les autres écrans.

## Risks / Trade-offs

- [Le dossier change et une image existe déjà à l'ancien endroit] → les anciennes sauvegardes restent où elles sont ;
  la vérification signale l'image de ce Mac si elle existe au nouvel endroit, sinon la prochaine sauvegarde en crée
  une nouvelle. Message explicatif dans la feuille de modification.
- [Suppression définitive sur NAS] → simulation obligatoire avant le bouton destructif, taille affichée, sauvegardes
  des autres Mac exclues par construction (seul le chemin de ce Mac est visé).
- [Chargement de l'historique pendant une sauvegarde planifiée] → pas de chargement si une sauvegarde tourne ;
  rechargement à la fin.
- [Mot de passe de l'image gardé après suppression sans les sauvegardes] → voulu : il sert à restaurer ces
  sauvegardes plus tard.

## Écarts apportés pendant l'implémentation

- Retours de l'utilisateur en cours de route : en-tête à la Codex (menu « … » rond avec l'action destructive en rouge,
  « Gérer » gris, action principale noire). « Simuler » passe dans le menu « … » (désactivé quand il ne peut pas
  aboutir, sans bulle d'aide : un menu macOS n'en affiche pas) ; « Vérifier » et « Tout vérifier » passent dans la
  carte Intégrité, avec bulle d'aide.
- Tous les `Picker(.segmented)` et `PillPicker` hors page d'accueil deviennent des `TabBar` en pilule (style
  « Public  Personnel » de Codex).
- La feuille de modification réutilise `AddDestinationSheet(editing:)` au lieu d'une feuille séparée.
- Le rendu `--snapshot` ne démarre plus le planificateur ni la surveillance (il pouvait lancer une vraie sauvegarde).
