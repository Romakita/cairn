# Proposal

## Why

Cairn est publié sur GitHub (`Romakita/cairn`) sous forme d'archive zippée, mais l'app ne sait pas qu'une nouvelle version existe : il faut surveiller la page des releases, télécharger, décompresser et remplacer `Cairn.app` à la main. Codex propose la mise à jour directement dans l'app, avec un bouton discret en bas de la barre d'icônes (« Mise à jour disponible ») qui installe et relance. Cairn doit faire de même.

## What Changes

- Cairn interroge la dernière release publiée sur GitHub au lancement puis toutes les 6 heures, et à la demande (menu « Rechercher les mises à jour… »).
- Quand une version plus récente existe, un bouton bleu apparaît en bas de la barre d'icônes, au-dessus de la pastille d'état, avec l'infobulle « Mise à jour disponible ».
- Le bouton ouvre un panneau : versions actuelle et nouvelle, notes de version, actions « Installer et relancer », « Voir la release » et « Plus tard ».
- L'installation télécharge l'archive de l'architecture du Mac, vérifie son SHA-256 et le bundle (identifiant, version), remplace `Cairn.app` après la fermeture de l'app, puis la relance. En cas d'échec, l'ancienne app est remise en place.
- L'installation est refusée pendant une sauvegarde. Hors d'un bundle `.app` modifiable (exécution de développement), le bouton ouvre seulement la page de la release.
- Nouveau réglage `[updates] check` dans `config.toml` (`true` par défaut) et case à cocher dans les réglages, avec la version installée.

## Capabilities

### New Capabilities
- `app-updates` : détection d'une nouvelle version, proposition dans l'interface, installation vérifiée et relance.

### Modified Capabilities
- Aucune spec principale n'est encore synchronisée ; le réglage `updates.check` est décrit dans la nouvelle capacité.

## Impact

- `CairnCore` : nouveau `Updater.swift` (lecture de la release, comparaison de versions, préparation et remplacement du bundle), clé `updates.check` dans `Config.swift` et `cairn config show`.
- `Cairn` : bouton et panneau dans `MainView.swift`, état dans `AppModel`, commande de menu dans `App.swift`, case dans `SettingsView.swift`.
- Réseau : un appel HTTPS à l'API GitHub, sans donnée personnelle, désactivable.
- Hors périmètre : mises à jour delta, canal de préversions, signature et notarisation (l'app reste signée ad hoc).
