# Design

## Context

Voir proposal.md (Why). État actuel :

- `SparseImage.create(password:)` accepte déjà un mot de passe fourni et reprend celui du Trousseau s'il existe (service `fr.lenzotti.cairn.image.<destination>`, compte = nom de la machine). Sans mot de passe fourni, il en génère un (`generatePassword`).
- L'image n'est créée qu'à la première sauvegarde, pas à l'ajout de la destination. Le mot de passe généré remonte par `Result.newImagePassword` jusqu'à la fenêtre « Image chiffrée créée » de `BackupView`, seul endroit où il est visible.
- Le Trousseau utilisé est le Trousseau de session (fichier), non synchronisable, à cause de la signature ad hoc.
- Les opérations sur une destination passent par `OperationLock` et `DestinationSession` (montage SMB puis image).

## Goals / Non-Goals

**Goals:**
- Le mot de passe d'une image est toujours retrouvable depuis l'app tant que ce Mac existe, et l'utilisateur est poussé à le ranger ailleurs.
- Un changement de mot de passe ne peut jamais rendre l'image illisible ni désynchroniser l'image et le Trousseau sans le dire.

**Non-Goals:**
- Pas de synchronisation iCloud (second changement, avec signature).
- Pas de copie du mot de passe sur la destination, même chiffrée par un autre secret.
- Pas de commande `cairn` pour afficher ou changer le mot de passe.

## Decisions

### Mot de passe choisi dès l'ajout de la destination, rangé dans le Trousseau à l'enregistrement
Le formulaire d'une nouvelle destination chiffrée affiche un mot de passe généré (même alphabet que `generatePassword`), avec un bouton pour le remplacer et un champ de confirmation. À l'enregistrement, il est écrit dans le Trousseau sous la clé de l'image. La première sauvegarde le reprend sans changement, puisque `create()` reprend déjà le mot de passe existant.
- Alternative : demander le mot de passe à la première sauvegarde. Rejetée, car la sauvegarde planifiée tourne souvent sans l'utilisateur.
- Si la destination pointe sur une image existante de ce Mac (« Sauvegarde de ce Mac trouvée »), le champ demande le mot de passe actuel et le vérifie en ouvrant l'image avant d'enregistrer, au lieu d'en proposer un nouveau.
- En modification d'une destination, rien ne change : le mot de passe se gère depuis la page de la destination.

### Afficher : authentification locale avant lecture
`LAContext.evaluatePolicy(.deviceOwnerAuthentication)` (Touch ID ou mot de passe de session) avant de lire le Trousseau. Ce framework ne demande aucun droit particulier et fonctionne avec la signature ad hoc. Le mot de passe est gardé dans l'état de la vue seulement, effacé quand on quitte la page. La copie passe par le presse-papiers, avec la marque `org.nspasteboard.ConcealedType` pour que les gestionnaires d'historique ne le gardent pas.
- Alternative : pas d'authentification, puisque le Trousseau est déjà ouvert. Rejetée : quelqu'un devant une session déverrouillée récupérerait la clé de toutes les sauvegardes.

### Changer : `hdiutil chpass` sous verrou, avec copie de l'en-tête et vérification
Nouvelle opération de cœur `SparseImage.changePassword(old:new:)` :
1. prendre `OperationLock` (« image-password »), ouvrir la destination sans attacher l'image ;
2. vérifier que l'ancien mot de passe ouvre l'image (`hdiutil verify` existant, qui compte « has no checksum » comme réussi) ;
3. copier le fichier d'en-tête de clés du sparsebundle (`token`) dans un dossier temporaire local ;
4. `hdiutil chpass -oldstdinpass -newstdinpass`, les deux mots de passe envoyés par l'entrée standard, chacun terminé par un octet nul ;
5. vérifier que le nouveau mot de passe ouvre l'image. En cas d'échec, remettre la copie de `token` et revérifier avec l'ancien ;
6. seulement alors, écrire le nouveau mot de passe dans le Trousseau, puis effacer la confirmation « rangé » et supprimer la copie temporaire.

Si l'écriture dans le Trousseau échoue après un changement réussi, Cairn affiche le nouveau mot de passe une fois et le signale en erreur. L'image est la source de vérité.
- Alternative : recréer l'image avec un nouveau mot de passe et tout recopier. Rejetée, car c'est des heures de transfert sur le NAS.
- La copie de `token` contient la clé de l'image chiffrée par l'ancien mot de passe, pas le mot de passe lui-même. Elle reste dans le dossier temporaire de l'app, droits 600, et est supprimée en fin d'opération.

### Confirmation « rangé hors de ce Mac » dans `runs.json`
Nouveau champ `DestinationState.imagePasswordStoredAt: Date?`. C'est un état local à ce Mac, pas de la configuration, donc il ne va pas dans `config.toml`. Une destination chiffrée dont l'image existe et sans ce champ est « à ranger ». Un changement de mot de passe le remet à `nil`. Le calcul (`needsPasswordStorage`) est une fonction pure de `CairnCore`, testable et partagée par la page, l'accueil et la barre de menus.

### Textes
Fenêtre de création : « Copier » et « Je l'ai rangé hors de ce Mac » (confirme), « Plus tard » (ferme sans confirmer). Le texte conseille l'app Mots de passe d'Apple, synchronisée par iCloud.

## Risks / Trade-offs

- [Coupure réseau pendant `chpass` sur le NAS, en-tête à moitié écrit] → copie locale de `token` restaurée, puis vérification ; l'erreur affichée dit lequel des deux mots de passe ouvre l'image.
- [Format interne du sparsebundle chiffré (`token`) non documenté] → test d'aller-retour sur une vraie image locale chiffrée dans `CairnSelfTest`, avec la coupure simulée en corrompant `token` ; si `token` est absent, refuser le changement plutôt que de le faire sans filet.
- [Autre Mac qui sauvegarde sur la même destination] → chaque Mac a sa propre image et sa propre clé du Trousseau, donc le changement ne touche que l'image de ce Mac.
- [L'utilisateur confirme sans avoir rangé le mot de passe] → impossible à vérifier ; l'avertissement n'est qu'une incitation.
- [Mot de passe dans le presse-papiers] → marque « concealed », et effacement du presse-papiers après 90 s s'il contient encore ce mot de passe.

## Migration Plan

Aucune migration de données. Les images existantes gardent leur mot de passe. Au premier lancement, les destinations chiffrées dont l'image existe affichent l'avertissement jusqu'à confirmation. Retour arrière : le champ ajouté à `runs.json` est ignoré par une version antérieure.
