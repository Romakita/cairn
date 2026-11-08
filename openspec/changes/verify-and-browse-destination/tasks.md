# Tasks

## 1. Vérification dans CairnCore

- [ ] 1.1 Créer `DestinationProbe.swift` : types `ProbeResult`, `ProbeFailure`, `FolderEntry` et `ProbeSession` (montage ouvert jusqu'à `close()`)
- [ ] 1.2 Implémenter la vérification d'un dossier local : volume monté, dossier existant, écriture du fichier témoin `.cairn-write-test-<uuid>` puis suppression, espace libre
- [ ] 1.3 Implémenter la vérification SMB : sonde TCP 445 (3 s), montage avec le mot de passe de session, traduction des codes `NetFSMountURLSync` (identifiants refusés, partage introuvable, autre code), puis contrôle du dossier et de l'écriture
- [ ] 1.4 Démontage à `close()` uniquement de ce que la session a monté ; partage déjà monté réutilisé sans démontage
- [ ] 1.5 Supprimer les fichiers témoins `.cairn-write-test-*` restés d'une vérification précédente du même dossier
- [ ] 1.6 Détecter les images Cairn du dossier choisi (`SparseImage.images(at:)`) et distinguer celle de ce Mac

## 2. Parcours et création de dossiers

- [ ] 2.1 `listFolders(at:)` : dossiers seulement, cachés exclus, tri naturel, erreur « accès refusé » typée
- [ ] 2.2 `createFolder(named:in:)` : refus d'un nom vide, contenant `/` ou `:`, ou déjà existant ; aucune écriture en cas de refus
- [ ] 2.3 Racines du navigateur local : volumes de `/Volumes` hors disque système, puis le home
- [ ] 2.4 Construction de l'adresse SMB finale `smb://hôte/partage/sous/dossier` à partir du dossier choisi

## 3. Tests (CairnSelfTest)

- [ ] 3.1 Suite `DestinationProbe` enregistrée dans `main.swift` : vérification locale réussie, dossier absent, dossier en lecture seule, fichier témoin supprimé
- [ ] 3.2 Tests du parcours : listing filtré et trié, accès refusé, création valide et noms refusés
- [ ] 3.3 Tests de la traduction des codes SMB et de la construction de l'adresse finale (sans réseau)
- [ ] 3.4 Test de détection des sauvegardes existantes (image d'une autre machine, image de ce Mac)

## 4. Interface

- [ ] 4.1 `DestinationFormModel` (ObservableObject) : champs, état de vérification, invalidation à chaque modification et au démontage du volume (`NSWorkspace.didUnmountNotification`)
- [ ] 4.2 Composant `FolderBrowser` : fil d'Ariane, lignes de dossiers, « Nouveau dossier » dans un plateau, badge de sauvegarde trouvée, état « accès refusé »
- [ ] 4.3 Composant `VerificationStatus` : en cours (annulable), réussi avec espace libre, échec avec cause et action
- [ ] 4.4 Composant `DestinationForm` réunissant type, connexion, navigateur, vérification et chiffrement, selon `Cairn/DESIGN.md`
- [ ] 4.5 Assistant : intégrer le formulaire à l'étape Destination, bloquer « Continuer » tant que la vérification n'a pas réussi (sauf « Plus tard »), proposer « Restaurer cette sauvegarde » si une image d'une autre machine est trouvée
- [ ] 4.6 App : remplacer `AppModel.addDestination()` par une feuille « Ajouter une destination » utilisant le même formulaire ; enregistrer dans `config.toml` et le Trousseau seulement à l'ajout
- [ ] 4.7 Fermer la `ProbeSession` à la fermeture du formulaire, de la feuille ou de l'assistant
- [ ] 4.8 Traductions en-US et fr-FR de tous les textes (états, erreurs, navigateur, boutons)

## 5. Vérification

- [ ] 5.1 `just test` passe, dont `L10n.no_untranslated_ui_strings`
- [ ] 5.2 Captures `Cairn --snapshot` de l'étape Destination (dossier local, NAS, erreur) en clair et en sombre
- [ ] 5.3 Essai réel : dossier local valide, disque débranché pendant la saisie, NAS avec bon puis mauvais mot de passe ; vérifier qu'aucun fichier ne reste et que le partage est démonté
- [ ] 5.4 `just storage-install` puis ajout d'une destination depuis l'app
- [ ] 5.5 `openspec validate verify-and-browse-destination` puis `/opsx:verify`

## Workflow follow-up

- Archiver `cairn-integration-scripts` avant celui-ci (la capacité `backup` y est créée).
