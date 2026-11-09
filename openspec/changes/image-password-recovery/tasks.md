# Tasks

## 1. Cœur : état « mot de passe rangé »

- [ ] 1.1 Ajouter `imagePasswordStoredAt: Date?` à l'état par destination de `runs.json` (`Retention.swift`), décodé sans erreur depuis un `runs.json` existant qui ne l'a pas ; vérifier par un test `CairnSelfTest` de décodage d'un ancien fichier.
- [ ] 1.2 Ajouter la fonction pure `needsPasswordStorage(destination:state:imageExists:)` (vrai pour une destination chiffrée dont l'image existe et sans confirmation), et l'intégrer à `Health` (niveau « attention ») et à `HubState` ; vérifier par des tests couvrant destination non chiffrée, image absente, confirmée, non confirmée.
- [ ] 1.3 Ajouter une validation de mot de passe partagée (au moins 12 caractères, deux saisies identiques) avec la raison localisée ; vérifier par un test des trois cas.

## 2. Cœur : changement du mot de passe de l'image

- [ ] 2.1 Implémenter `SparseImage.changePassword(old:new:)` : vérification de l'ancien, copie temporaire de `token` (droits 600), `hdiutil chpass -oldstdinpass -newstdinpass`, vérification du nouveau, restauration de `token` en cas d'échec, refus si `token` est absent ; vérifier par un test d'aller-retour sur une image chiffrée locale (le nouveau ouvre, l'ancien non, le contenu est intact).
- [ ] 2.2 Tester l'échec : `token` corrompu après `chpass` → restauration et l'ancien mot de passe ouvre l'image ; ancien mot de passe faux → refus sans rien modifier ; vérifier par des tests `CairnSelfTest`.
- [ ] 2.3 Ajouter l'opération de service (dans `BackupService` ou à côté) qui prend `OperationLock`, ouvre la destination sans attacher l'image, appelle `changePassword`, puis écrit le Trousseau et remet `imagePasswordStoredAt` à `nil` ; si l'écriture dans le Trousseau échoue, renvoyer le nouveau mot de passe dans l'erreur ; vérifier par un test que le verrou tenu par une sauvegarde fait refuser l'opération.
- [ ] 2.4 Vérifier par un test qu'après une sauvegarde chiffrée de test, aucun fichier de la destination ni de `~/.cairn` (racine `CAIRN_HOME` de test) ne contient le mot de passe.

## 3. Interface : ajout d'une destination chiffrée

- [ ] 3.1 Dans `DestinationForm`, pour une nouvelle destination chiffrée : mot de passe proposé (généré), bouton pour le remplacer, champ de confirmation, raison affichée sous le champ et enregistrement désactivé si invalide ; vérifier dans l'app (`just storage-install`) les cas de l'exigence « Chiffrement ».
- [ ] 3.2 À l'enregistrement, écrire le mot de passe dans le Trousseau sous la clé de l'image ; quand le dossier contient déjà l'image de ce Mac, demander le mot de passe actuel et le vérifier en ouvrant l'image avant d'enregistrer ; vérifier par un test du modèle du formulaire et dans l'app.
- [ ] 3.3 Ajouter les textes en-US et fr-FR et vérifier que `L10n.no_untranslated_ui_strings` passe (`just test`).

## 4. Interface : page de la destination

- [ ] 4.1 Ajouter la section « Mot de passe de l'image » dans `BackupView` : « Afficher » après `LAContext` (`.deviceOwnerAuthentication`), « Copier » (presse-papiers marqué « concealed », effacé après 90 s), masqué en quittant la page ; cas « mot de passe absent du Trousseau » avec saisie vérifiée en ouvrant l'image ; vérifier dans l'app, y compris l'annulation de l'authentification.
- [ ] 4.2 Ajouter la feuille « Changer le mot de passe » (ancien prérempli depuis le Trousseau, nouveau saisi deux fois), désactivée avec la raison pendant une opération ou si la destination est injoignable (`BackupActions.unavailableReason`) ; vérifier dans l'app sur une destination locale chiffrée de test.
- [ ] 4.3 Ajouter la bannière « Mot de passe à ranger hors de ce Mac » avec le bouton « Je l'ai rangé hors de ce Mac », et le signal dans l'accueil et la barre de menus via `HubState` ; vérifier dans l'app que la confirmation fait disparaître les trois signaux.
- [ ] 4.4 Revoir la fenêtre « Image chiffrée créée » : « Copier », « Je l'ai rangé hors de ce Mac » (confirme), « Plus tard » (ferme sans confirmer), texte qui conseille l'app Mots de passe ; vérifier dans l'app.
- [ ] 4.5 Ajouter les textes en-US et fr-FR de la page et des fenêtres, et vérifier `just test`.

## 5. Documentation et vérification d'ensemble

- [ ] 5.1 Documenter dans `Cairn/README.md` (section Restauration) les deux secrets nécessaires sur un Mac neuf et où retrouver le mot de passe de l'image ; vérifier que les commandes citées fonctionnent.
- [ ] 5.2 Vérification de bout en bout sur une destination locale chiffrée : ajout avec un mot de passe choisi, sauvegarde, affichage, changement, puis `cairn restore --destination <id>` en saisissant le nouveau mot de passe ; vérifier que `just test` passe, puis `openspec validate image-password-recovery`.

## Workflow follow-up

- Second changement à proposer : signature de Cairn avec un compte Apple Developer et rangement du mot de passe dans le Trousseau iCloud synchronisé.
- Archiver le changement après revue, puis vérifier le résultat archivé.
