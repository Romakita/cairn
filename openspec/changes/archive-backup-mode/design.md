# Design

## Context

Voir proposal.md (Why). État actuel utile :

- `BackupService.run` prépare une fois les parties (`BackupPart` : source, exclusions, `filesFrom`), puis boucle sur les destinations. Pour chacune, `DestinationSession.open` monte le partage puis l'image sparsebundle, et `BackupEngine.run` copie avec rsync dans `versions/<version>/` et écrit `manifest.json` et `checksums.tsv`.
- `Retention` connaît déjà le mode `count(n)`, à côté de `tiered`.
- La planification est commune (`config.schedule`), mais `BackupController.tick` décide déjà destination par destination à partir de `runs.json`. Les fréquences sont `daily`, `weekly` et `manual`.
- `RestoreSource.open(dir)` lit une version à partir de son `manifest.json`, quel que soit son emplacement.

## Goals / Non-Goals

**Goals:**
- Une archive est un fichier autonome : on la copie, on la double-clique, on restaure, sans Cairn si besoin.
- Réutiliser le moteur rsync, les exclusions, le manifeste, les empreintes et la restauration au lieu de les dupliquer.

**Non-Goals:**
- Pas d'archive incrémentale ni de déduplication entre archives.
- Pas de conversion d'une destination d'un mode à l'autre.
- Pas de format lisible hors macOS.

## Decisions

### 1. Configuration : `mode` et `schedule` par destination
```toml
[[destinations]]
id = "nas-archive"
provider = "smb"
url = "smb://syno/home/cairn"
username = "romain.lenzotti"
encrypted = true
mode = "archive"                                    # "rsync" par défaut
retention = { mode = "count", count = 4 }           # défaut en mode archive
schedule = { frequency = "monthly", day = 1, time = "13:00" }   # facultatif
```
- La clé `schedule` d'une destination accepte les mêmes clés que `[schedule]`, sauf `background` et `onBatteryMinPercent`, qui restent communes. La planification effective est `d.schedule ?? config.schedule`.
- `monthly` utilise `day` (1 à 28, pour exister tous les mois) et `time`.
- Le numéro de version du schéma de `config.toml` passe à 2. Sinon, une version antérieure de Cairn lirait une destination `archive` comme une destination rsync et créerait une image sparsebundle à côté des archives. La validation existante refuse déjà un schéma plus récent (`Config.swift`, `version > currentVersion`).
- Validation : mode inconnu, `tiered` en mode archive, `day` hors de 1 à 28, et `count` hors de 1 à 99 sont des erreurs sur la ligne concernée.

### 2. Création d'une archive : copie locale, puis image compressée écrite sur la destination
1. Estimation : `rsync -n --stats` par partie, avec les mêmes options et exclusions, donne la taille totale. Il faut un espace libre local d'au moins 110 % de cette taille plus 1 Go, sinon erreur avant toute copie.
2. Préparation : `BackupEngine` copie les parties dans `~/Library/Caches/Cairn/archive-staging/<version>/`, sans `--link-dest` ni versions précédentes. Ce dossier est déjà exclu de la sauvegarde du home (`Caches/`). Le moteur écrit `manifest.json` (avec `"mode": "archive"`) et `checksums.tsv` comme pour une version.
3. Image : `hdiutil create -srcfolder <staging> -format ULFO -volname "Cairn <version>"`, plus `-encryption AES-256 -stdinpass` si la destination est chiffrée. Elle est écrite sous un nom partiel (`.<version>.partial.dmg`) dans `cairn-archives/<machine>/`, puis renommée en `<version>.dmg` après `hdiutil verify`.
4. Le dossier de préparation est supprimé dans tous les cas (`defer`). Au lancement, les `.partial.dmg` de ce Mac et les dossiers de préparation laissés par un arrêt brutal sont supprimés.
- Format `ULFO` (lzfse) : bon compromis vitesse et taux, lisible depuis macOS 10.11. `UDZO` (zlib) est plus lent pour un taux proche, `ULMO` (lzma) plus compact mais beaucoup plus lent.
- Alternative : `hdiutil create -srcfolder` directement sur les sources. Rejetée : impossible d'appliquer les exclusions, et le home ou les dossiers suivis sont répartis sur plusieurs racines.
- Alternative : préparation sur la destination. Rejetée : les données traverseraient le réseau deux fois.
- Optimisation ultérieure possible, hors périmètre : clones APFS (`cp -c`) pour les sources du même volume que le dossier de préparation.

### 3. Destination en mode archive : pas de sparsebundle
`DestinationSession.usesImage` est faux en mode archive. La racine de travail est `<base>/cairn-archives/<machine>/`, à côté d'un éventuel `cairn-<machine>.sparsebundle` : une destination rsync et une destination archive peuvent viser le même dossier du NAS sans conflit. Le navigateur de dossiers (« Sauvegardes existantes ») signale aussi les archives trouvées.

### 4. Mot de passe des archives
Le mot de passe est celui de la destination chiffrée : même entrée du Trousseau (`image.<destination>`, compte = machine), choisi à la création comme le prévoit `image-password-recovery`. Toutes les archives d'une destination ont donc le même mot de passe. Un changement de mot de passe ne s'applique qu'aux archives suivantes, et la page de la destination l'indique : les anciennes gardent l'ancien. C'est un compromis assumé, car rechiffrer des archives complètes sur le NAS coûterait des heures.

### 5. Rétention et intégrité
Après le renommage, `Retention.count(n)` est appliquée aux `.dmg` de ce Mac, triés par nom (la version est un horodatage triable). `hdiutil verify` sur l'archive fraîche, l'image ULFO ayant une somme de contrôle intégrée, remplace l'échantillon d'empreintes du mode rsync. `cairn verify --full` sur une archive l'ouvre en lecture seule et contrôle toutes les empreintes.

### 6. Planification
`BackupSchedule.lastOccurrence` gagne le cas `monthly`. `BackupController.tick` et `Health` utilisent la planification effective de chaque destination. Les destinations dues au même passage sont sauvegardées l'une après l'autre dans le même `run`, ce qui préserve le verrou unique. Elles partagent la préparation des parties (copie des bases IA).

### 7. Restauration
`RestoreSource.versions(onDestinationRoot:)` liste aussi `cairn-archives/<machine>/*.dmg` (en ignorant `.partial`). Ouvrir une archive revient à `hdiutil attach -readonly -nobrowse` (avec `-stdinpass` si chiffrée), puis `RestoreSource.open(<point de montage>)`. L'archive est détachée en fin de restauration ou d'annulation. `cairn restore --from` accepte un fichier `.dmg`.

## Risks / Trade-offs

- [Espace local : une archive complète est d'abord copiée sur ce Mac] → contrôle avant copie (décision 2), message clair. L'optimisation par clones APFS est notée pour plus tard.
- [`hdiutil create` long et sans progression rsync] → `-puppetstrings` donne un pourcentage, affiché comme une étape « Compression ». L'annulation tue `hdiutil` et supprime le fichier partiel.
- [Grosse écriture unique sur SMB, sensible aux coupures] → nom partiel, puis vérification et renommage. Une coupure laisse un `.partial.dmg` supprimé au lancement suivant, sans toucher aux archives terminées.
- [Archives illisibles hors macOS] → accepté (choix de l'utilisateur), noté dans la documentation.
- [Même mot de passe pour toutes les archives et pas de rechiffrement des anciennes] → indiqué dans l'interface (décision 4).
- [Deux destinations dues en même temps, sauvegarde plus longue] → séquentiel et assumé. La destination rsync passe en premier, l'ordre étant celui de `config.toml`.

## Migration Plan

Les destinations existantes restent en mode rsync (clé `mode` absente). `CairnConfig.currentVersion` passe de 1 à 2, avec une migration 1 → 2 qui ne change que le numéro. La migration automatique existante l'applique au premier lancement et garde `config.toml.bak`. Une version antérieure de Cairn refuse ensuite ce fichier (`config.issue.version_unsupported`, déjà en place) au lieu de mal l'interpréter. Retour arrière : supprimer les destinations en mode archive (leurs fichiers `.dmg` restent lisibles sans Cairn).
