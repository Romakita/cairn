# Tasks

Toute tâche qui ajoute un texte visible l'ajoute en en-US et en fr-FR dans le même temps.

## 1. Cœur (`CairnCore`)

- [x] 1.1 Comparaison de versions et lecture de la réponse `releases/latest` (asset de l'architecture et `.sha256`) ; tests sur version plus récente, égale, suffixe `-beta`, asset absent
- [x] 1.2 Préparation : vérification SHA-256, extraction `ditto`, contrôle de l'identifiant et de la version, retrait de la quarantaine ; tests sur archive valide, SHA faux, mauvais identifiant
- [x] 1.3 Script de remplacement détaché avec retour arrière ; test qui remplace un faux bundle et un test d'échec qui garde l'ancien
- [x] 1.4 Clé `[updates] check` (lecture, écriture, `cairn config show`) ; test de lecture et de valeur par défaut

## 2. App

- [x] 2.1 État de mise à jour dans `AppModel` : contrôle au lancement puis toutes les 6 heures, contrôle manuel, installation
- [x] 2.2 Bouton dans le rail et panneau (notes, installer et relancer, voir la release, plus tard, erreurs, sauvegarde en cours)
- [x] 2.3 Commande « Rechercher les mises à jour… » dans le menu de l'app, case et version dans les réglages
- [x] 2.4 Documentation (`Cairn/README.md`, CHANGELOG)

## 3. Vérification

- [x] 3.1 `just test`, `openspec validate app-updates`, construction de l'app et essai du bouton avec une release simulée (`CAIRN_UPDATE_URL`)
