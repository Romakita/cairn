# Tasks

## 1. Configuration

- [ ] 1.1 Ajouter `mode` (`rsync` par défaut, `archive`) et `schedule` facultatif à `CairnConfig.Destination`, lecture et écriture TOML, avec la rétention par défaut `count = 4` en mode archive ; vérifier par des tests `ConfigTests` (aller-retour, destination sans `mode` lue en rsync).
- [ ] 1.2 Ajouter la fréquence `monthly` et la clé `day` (1 à 28) à `Schedule` ; vérifier par un test de lecture et d'écriture.
- [ ] 1.3 Ajouter les erreurs de validation : mode inconnu, `tiered` en mode archive, `day` hors de 1 à 28, `count` hors de 1 à 99, chacune sur sa ligne ; vérifier par des tests `ConfigWarningTests`.
- [ ] 1.4 Passer `currentVersion` à 2 avec une migration 1 → 2 qui ne change que le numéro, et mettre à jour le modèle commenté de `config.toml` (exemple de destination archive mensuelle) ; vérifier par un test de migration (`config.toml.bak` écrit, contenu inchangé à part `version`).
- [ ] 1.5 Ajouter les textes des erreurs en-US et fr-FR et vérifier `just test`.

## 2. Planification par destination

- [ ] 2.1 Ajouter le cas `monthly` à `BackupSchedule.lastOccurrence`, et la fonction `effectiveSchedule(destination:config:)` ; vérifier par des tests (le 1er du mois à 13 h, échéance manquée en fin de mois, mois de 28 jours).
- [ ] 2.2 Utiliser la planification effective dans `BackupController.tick`, `notifyOverdue` et `Health` ; vérifier par un test `Health` avec une destination quotidienne et une mensuelle (seule la quotidienne en retard le 15).
- [ ] 2.3 Vérifier par un test que deux destinations dues au même passage partent dans un seul `run`, l'une après l'autre, dans l'ordre de `config.toml`.

## 3. Création des archives

- [ ] 3.1 Dans `DestinationSession`, en mode archive : pas d'image sparsebundle, racine `<base>/cairn-archives/<machine>/` créée si besoin ; vérifier par un test sur une destination locale.
- [ ] 3.2 Ajouter l'estimation de taille (`rsync -n --stats` par partie) et le contrôle de l'espace local (110 % plus 1 Go) avant toute copie ; vérifier par un test qui force une taille estimée supérieure à l'espace libre (erreur, destination intacte).
- [ ] 3.3 Copier les parties avec `BackupEngine` dans `~/Library/Caches/Cairn/archive-staging/<version>/` (sans `--link-dest`), avec `manifest.json` (`"mode": "archive"`) et `checksums.tsv` ; vérifier par un test que le contenu respecte les exclusions (`node_modules`, `dist` absents).
- [ ] 3.4 Créer l'image (`hdiutil create -srcfolder -format ULFO`, plus `-encryption AES-256 -stdinpass` si chiffrée) sous le nom `.<version>.partial.dmg`, puis `hdiutil verify` et renommage en `<version>.dmg`, et supprimer le dossier de préparation dans tous les cas ; vérifier par un test d'aller-retour : l'archive s'ouvre avec le mot de passe, et les empreintes correspondent.
- [ ] 3.5 Brancher l'annulation (arrêt de `hdiutil`, suppression du fichier partiel) et le nettoyage au lancement des `.partial.dmg` et des dossiers de préparation orphelins ; vérifier par un test qui interrompt la création.
- [ ] 3.6 Afficher l'étape « Compression » avec le pourcentage de `-puppetstrings` dans la progression de l'app et de `cairn backup` ; vérifier dans l'app et en ligne de commande.
- [ ] 3.7 Simulation en mode archive : taille estimée et nombre de fichiers, aucune écriture ; vérifier avec `cairn backup --dry-run --destination <id>` sur une destination de test.

## 4. Rétention et vérification des archives

- [ ] 4.1 Appliquer `Retention.count(n)` aux archives de ce Mac après le renommage, sans toucher aux archives des autres Mac ni en cas d'échec ; vérifier par des tests (cinquième archive, échec, archive d'un autre Mac gardée).
- [ ] 4.2 `cairn verify` sur une destination en mode archive : `hdiutil verify` par défaut, ouverture en lecture seule et contrôle de toutes les empreintes avec `--full` ; vérifier par un test qui abîme un fichier de l'archive de test.

## 5. Restauration

- [ ] 5.1 Lister les archives dans `RestoreSource.versions(onDestinationRoot:)` (sans les `.partial`), et ouvrir une archive en lecture seule (`hdiutil attach -readonly -nobrowse`), puis la détacher en fin de restauration ou à l'annulation ; vérifier par un test de restauration simulée depuis une archive chiffrée.
- [ ] 5.2 Accepter un fichier `.dmg` dans `cairn restore --from`, avec demande du mot de passe s'il est chiffré ; vérifier en ligne de commande sur l'archive de test.
- [ ] 5.3 Afficher les archives dans `RestoreView` comme des versions (date, machine, parties) ; vérifier dans l'app.

## 6. Interface

- [ ] 6.1 Dans `DestinationForm`, choix du mode à la création (deux tuiles avec la place prise et la vitesse), mode affiché et figé en modification, rétention « Garder les N dernières archives » en mode archive ; vérifier dans l'app.
- [ ] 6.2 Ajouter le réglage de planification par destination (« Comme les autres destinations » ou une récurrence propre, mensuelle comprise) sur la page de la destination et dans les réglages ; vérifier dans l'app que `config.toml` contient la clé `schedule` attendue.
- [ ] 6.3 Afficher le mode et la prochaine échéance sur la page de la destination, et signaler les archives dans le navigateur de dossiers (« Sauvegardes existantes ») ; vérifier dans l'app.
- [ ] 6.4 En mode archive chiffré, indiquer près du mot de passe que son changement ne s'applique qu'aux archives suivantes ; vérifier dans l'app.
- [ ] 6.5 Ajouter tous les textes de l'interface en-US et fr-FR et vérifier `just test` (`L10n.no_untranslated_ui_strings`).

## 7. Documentation et vérification d'ensemble

- [ ] 7.1 Documenter le mode archive dans `Cairn/README.md` (choix du mode, place prise, espace local nécessaire, ouverture d'une archive sans Cairn, exemple rsync quotidien et archive mensuelle sur le même NAS) ; vérifier que l'exemple de configuration passe `cairn config validate`.
- [ ] 7.2 Vérification de bout en bout sur un dossier local : une destination rsync et une destination archive sur le même dossier, une sauvegarde de chaque, double-clic sur l'archive dans le Finder, puis `cairn restore --destination <archive>` ; vérifier `just test` et `openspec validate archive-backup-mode`.

## Workflow follow-up

- À implémenter après `image-password-recovery`, dont il réutilise le choix et la gestion du mot de passe.
- Archiver le changement après revue, puis vérifier le résultat archivé.
