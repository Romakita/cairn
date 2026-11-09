# Proposal

## Why

Le seul mode de sauvegarde actuel (rsync incrémental dans une image sparsebundle) est efficace mais complexe : il dépend d'une image montée sur le NAS, et une image abîmée ou un mot de passe perdu touche toutes les versions d'un coup. L'utilisateur veut, en complément, des copies complètes indépendantes : un fichier par sauvegarde, qui s'ouvre seul sur n'importe quel Mac, avec un rythme plus lent (par exemple une archive mensuelle en plus des sauvegardes rsync quotidiennes, sur le même NAS).

## What Changes

- Chaque destination a un **mode** choisi à sa création, puis figé : `rsync` (comportement actuel, par défaut) ou `archive`.
- En mode `archive`, chaque sauvegarde produit **une image disque compressée et en lecture seule** (`.dmg`), chiffrée en AES-256 si la destination est chiffrée. Elle contient la même arborescence qu'une version rsync (parties, `manifest.json`, `checksums.tsv`) et s'ouvre d'un double-clic sur un Mac avec le mot de passe.
- Le contenu et les exclusions sont les mêmes qu'en mode rsync (dossiers suivis, home, outils IA, inventaire, contenu régénérable exclu).
- Rétention en mode `archive` : les **N dernières archives** (4 par défaut). La plus ancienne n'est supprimée qu'après la réussite d'une nouvelle archive.
- Chaque destination peut avoir **sa propre planification**. Sans elle, c'est la planification commune qui s'applique. Une fréquence **mensuelle** (jour du mois et heure) est ajoutée.
- La restauration liste et lit les archives comme les versions rsync.
- Deux destinations peuvent viser le même partage, par exemple une en rsync et une en archive.

Hors du périmètre : le zip classique (pas de chiffrement fiable), les archives lisibles hors macOS, la conversion d'une destination existante d'un mode à l'autre (il faut en créer une nouvelle), et les archives incrémentales.

## Capabilities

### New Capabilities

Aucune.

### Modified Capabilities

- `backup` : ajout du mode de sauvegarde par destination, du format archive et de sa rétention par nombre ; la planification devient réglable par destination, avec une fréquence mensuelle.
- `restore` : le choix de la sauvegarde inclut les archives d'une destination en mode `archive`.

## Impact

- `CairnCore/Config.swift` : clés `mode` et `schedule` de `[[destinations]]`, fréquence `monthly` et clé `day`, validation (mode inconnu, rétention par paliers refusée en mode archive), modèle commenté.
- `CairnCore/BackupService.swift` et `BackupEngine.swift` : chemin « archive » (copie vers un dossier de préparation local, puis création de l'image compressée sur la destination).
- `CairnCore/Providers.swift` : en mode archive, pas de sparsebundle ; dossier `cairn-archives/<machine>/` sur la destination.
- `CairnCore/Retention.swift` : rétention par nombre appliquée aux archives.
- `CairnCore/Scheduler.swift` et `Cairn/BackupController.swift` : planification par destination, fréquence mensuelle.
- `CairnCore/Restore.swift` et `Cairn/RestoreView.swift` : liste des archives, montage en lecture seule pour restaurer.
- `Cairn/DestinationForm.swift`, `Cairn/BackupView.swift`, réglages : choix du mode et de la planification.
- `cairn backup` et `cairn restore` : aucun nouvel argument, ils suivent le mode de la destination.
- Lien avec `image-password-recovery` : en mode archive, le mot de passe des archives est celui de la destination (même entrée du Trousseau), donc les mêmes fonctions afficher et changer s'appliquent. Le changement ne touche que les futures archives.
- Textes en-US et fr-FR, tests `CairnSelfTest`, `README.md`.
