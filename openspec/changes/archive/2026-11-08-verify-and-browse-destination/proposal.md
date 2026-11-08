# Proposal

## Why

Aujourd'hui, l'assistant accepte n'importe quelle adresse de NAS ou chemin de dossier sans rien vérifier : une faute
de frappe, un mauvais mot de passe ou un partage inaccessible ne se découvre qu'au premier échec de sauvegarde,
parfois des jours plus tard. Le dossier de destination doit en plus être tapé à la main (`smb://nas.local/backups`),
sans voir ce que contient le partage. Enfin, le bouton « Ajouter une destination » de l'app renvoie vers les réglages,
qui n'ont pas de section destinations : il n'existe aucun moyen d'ajouter une destination après l'assistant.

## What Changes

- Une destination (NAS SMB ou dossier / disque) est **vérifiée avant d'être enregistrée** : serveur joignable,
  identifiants acceptés, dossier accessible en écriture. Le résultat s'affiche dans l'assistant (en cours, réussi avec
  l'espace libre, ou échec avec la cause et l'action à faire), et « Continuer » reste bloqué tant que la vérification
  n'a pas réussi. L'option « Plus tard » reste disponible pour avancer sans destination.
- Un **navigateur de dossiers sur la destination** permet de choisir le dossier de sauvegarde : fil d'Ariane, liste
  des sous-dossiers, création d'un nouveau dossier. Pour un NAS, il parcourt le partage après connexion ; pour un
  dossier local, il part des volumes montés et du home.
- Le navigateur signale un dossier qui contient déjà des sauvegardes Cairn (images `cairn-<machine>.sparsebundle`)
  et propose de restaurer plutôt que de repartir de zéro.
- Le même formulaire « Ajouter une destination » (type, connexion, dossier, vérification, chiffrement) sert dans
  l'assistant et dans l'app : le bouton « Ajouter une destination » l'ouvre au lieu de renvoyer vers les réglages.
- Ce que Cairn a monté pour vérifier ou parcourir est démonté à la fermeture du formulaire. Le seul fichier écrit sur
  la destination est un fichier témoin, supprimé aussitôt.

## Capabilities

### New Capabilities

Aucune.

### Modified Capabilities

- `backup` : ajout des exigences « Ajout d'une destination vérifiée » et « Choix du dossier sur la destination »
  (la capacité est créée par le changement `cairn-integration-scripts`, à archiver avant celui-ci).

## Impact

- `CairnCore` : nouveau module de vérification et de parcours de destination (au-dessus de `LocalProvider`,
  `SMBProvider`, `Reachability`, `SparseImage.images(at:)`), avec tests dans `CairnSelfTest`.
- App : composant de formulaire de destination et navigateur de dossiers (`OnboardingView`, nouvelle feuille
  d'ajout depuis `BackupView` et la barre latérale), en reprenant le design system (`DESIGN.md`).
- Traductions en-US et fr-FR des états de vérification, des erreurs et du navigateur.
- Réseau : connexion TCP au port 445 et montage SMB du partage pendant la vérification (déjà utilisés par les
  sauvegardes) ; aucun mot de passe n'est enregistré avant « Terminer » ou « Ajouter ».
