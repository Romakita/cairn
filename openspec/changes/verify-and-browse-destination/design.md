# Design

## Context

- Les fournisseurs existent déjà dans `CairnCore/Providers.swift` : `LocalProvider` (dossier, volume monté) et
  `SMBProvider` (sonde TCP 445 via `Reachability.tcp`, montage `NetFSMountURLSync` sans interface, mot de passe
  du Trousseau ou saisi pour la session via `password`, démontage dans `finish()` de ce qu'il a monté).
- `SparseImage.images(at:)` liste les images `cairn-<machine>.sparsebundle` d'un dossier.
- L'assistant (`OnboardingView`) garde la destination dans un brouillon et n'écrit rien avant « Terminer »
  (`AppModel.finishOnboarding` enregistre alors le mot de passe dans le Trousseau).
- `AppModel.addDestination()` renvoie vers les réglages, qui n'ont pas de section destinations.
- Pas d'Xcode : tests dans `CairnSelfTest`, pas d'XCTest. L'UI suit `Cairn/DESIGN.md`.

## Goals / Non-Goals

**Goals:**
- Une seule logique de vérification et de parcours, dans `CairnCore`, testable sans réseau.
- Un seul formulaire de destination réutilisé par l'assistant et par l'app.
- Aucun effet de bord durable : montage temporaire, fichier témoin supprimé, rien dans le Trousseau avant validation.

**Non-Goals:**
- Lister les partages d'un serveur SMB (l'utilisateur saisit `smb://hôte/partage`, voir Décisions).
- Découverte automatique des NAS du réseau (Bonjour) : changement ultérieur.
- Modifier une destination existante (adresse, dossier) : seul l'ajout est couvert.
- Nouveaux fournisseurs (drive en ligne).

## Decisions

### 1. `DestinationProbe` dans `CairnCore`
Une nouvelle API, au-dessus des fournisseurs :

- `check(_ destination, password:) async -> ProbeResult` : étapes séquentielles avec un résultat typé
  `ok(freeBytes, existingImages)` ou `failed(ProbeFailure)` où `ProbeFailure` = `unreachable(host)`,
  `authenticationFailed`, `mountFailed(code)`, `notFound(path)`, `readOnly(path)`, `volumeMissing(volume)`.
- `listFolders(at:) -> Result<[FolderEntry], ProbeFailure>` pour le navigateur (dossiers seulement, cachés exclus,
  tri naturel) et `createFolder(named:in:)` qui refuse un nom vide, contenant `/` ou `:`, ou déjà existant.
- Une `ProbeSession` garde le montage ouvert entre la vérification et le parcours, et le démonte à `close()`.

Le test d'écriture crée `.cairn-write-test-<uuid>` puis le supprime ; l'espace libre vient de
`URLResourceKey.volumeAvailableCapacityForImportantUsageKey` (repli sur `statfs`).

*Alternative écartée* : vérifier dans la vue avec les fournisseurs directement. La logique serait intestable et
dupliquée entre assistant et app.

### 2. Codes d'erreur SMB traduits en causes
`NetFSMountURLSync` renvoie un code : `EAUTH` (80) et `kNetAuthErrorAuthenticationFailure` → identifiants refusés ;
`ENOENT` (2) ou partage inconnu → `notFound` ; autre → `mountFailed(code)` avec le code affiché. L'ordre des étapes
(sonde TCP, puis montage, puis dossier, puis écriture) donne la première cause utile.

### 3. Parcours limité au partage saisi
L'utilisateur saisit `smb://hôte/partage` ; le navigateur part de la racine du partage monté. Lister les partages
d'un serveur demande `smbutil view` avec le mot de passe en argument (visible dans `ps`) ou une interface système :
écarté pour ne jamais exposer le mot de passe. Le chemin choisi dans le partage est ajouté à l'URL
(`smb://hôte/partage/sous/dossier`), format déjà compris par `SMBProvider.prepare`.

### 4. Navigateur local : volumes et home comme racines
Racines proposées : chaque volume de `/Volumes` (sauf le disque système) et le home. On parcourt ensuite les
sous-dossiers ; `NSOpenPanel` reste disponible via « Parcourir… » pour les cas particuliers.

### 5. Composants UI partagés
- `DestinationForm` (type, connexion, navigateur, vérification, chiffrement) : vue commune, état dans un
  `DestinationFormModel` (ObservableObject, pas `@Observable`, absent sans Xcode).
- `FolderBrowser` : fil d'Ariane en `TabBar`-like, lignes `SettingsRow` avec `IconTile("folder")`, ligne
  « Nouveau dossier » dans un `CardTray`, badge pour une sauvegarde Cairn trouvée.
- `VerificationStatus` : ligne d'état (spinner, coche verte avec espace libre, ou bandeau d'erreur et action).
- Dans l'assistant, l'étape Destination intègre le formulaire ; « Continuer » exige `ok` (ou « Plus tard »).
  Dans l'app, « Ajouter une destination » ouvre une feuille avec le même formulaire et un bouton « Ajouter ».

### 6. Invalidation
Toute modification de l'adresse, de l'utilisateur, du mot de passe ou du dossier remet l'état à « non vérifié ».
La disparition du volume choisi (notification `NSWorkspace.didUnmountNotification`) fait de même.

### 7. Sauvegardes existantes
`SparseImage.images(at:)` sur le dossier choisi : une image d'une autre machine affiche le badge et, dans
l'assistant, le bouton « Restaurer cette sauvegarde » (passe à la restauration avec cette destination présélectionnée
via `restoreInsteadOfOnboarding`). L'image de cette machine affiche « les sauvegardes continueront cette image ».

## Risks / Trade-offs

- [Le montage SMB peut bloquer plusieurs secondes] → vérification hors du fil principal, annulable, délai de 3 s pour
  la sonde TCP et indicateur de progression ; le bouton reste réactif.
- [Le fichier témoin peut rester en cas de plantage] → nom préfixé `.cairn-write-test-` reconnu et supprimé à la
  prochaine vérification du même dossier.
- [Un partage monté par Cairn reste monté si l'app est tuée] → même comportement que les sauvegardes actuelles ;
  le montage est « soft » et sans interface Finder.
- [Bloquer « Continuer » gêne qui configure un NAS hors du réseau] → « Plus tard » reste disponible, et la
  destination peut être ajoutée depuis l'app ensuite.
- [La capacité `backup` n'existe que dans `cairn-integration-scripts`] → archiver ce changement avant celui-ci.

## Open Questions

- Libellé exact des messages d'erreur pour les codes SMB rares (affichés avec leur code en attendant).
