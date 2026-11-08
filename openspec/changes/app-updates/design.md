# Design

## Context

Les releases sont produites par `.github/workflows/release.yml` : tag `vX.Y.Z`, assets `Cairn-<version>-<arch>.zip` et `.zip.sha256`, notes tirées du `CHANGELOG.md`. L'app est signée ad hoc, sans Sparkle ni Xcode (Command Line Tools seulement). La commande `cairn` est un lien vers le binaire du bundle, donc un remplacement du bundle au même endroit la met aussi à jour.

## Goals / Non-Goals

**Goals :** proposer la mise à jour comme Codex (bouton dans le rail, installation et relance en un clic), sans dépendance externe, avec une vérification d'intégrité et un retour arrière.

**Non-Goals :** Sparkle et les flux appcast, les préversions, la mise à jour silencieuse sans accord, la mise à jour depuis la ligne de commande.

## Decisions

- **Source : API GitHub `releases/latest`.** Elle ignore déjà les brouillons et les préversions. URL remplaçable par `CAIRN_UPDATE_URL` pour les tests. Alternative écartée : un appcast Sparkle, qui demanderait un framework et une clé EdDSA.
- **Comparaison de versions** numérique composant par composant ; une version avec suffixe (`-beta`) est inférieure à la même version sans suffixe.
- **Vérification** : SHA-256 de l'archive comparé au fichier `.sha256` publié (CryptoKit), puis lecture de l'`Info.plist` extrait : `CFBundleIdentifier` = `fr.lenzotti.cairn` et `CFBundleShortVersionString` = version annoncée. L'attribut de quarantaine est retiré de la copie extraite (comme le conseillent les notes de release).
- **Remplacement** : un script `zsh` détaché attend la fin du processus de Cairn, déplace l'ancien bundle à côté, met le nouveau en place, restaure l'ancien si le déplacement échoue, puis relance l'app avec `open`. Un binaire ne peut pas se remplacer de façon fiable pendant qu'il tourne ; le script évite cela.
- **Garde-fous** : pas d'installation pendant une sauvegarde ; hors d'un bundle `.app` dans un dossier modifiable, le bouton ouvre la page de la release.
- **Fréquence** : premier contrôle quelques secondes après le lancement, puis toutes les 6 heures ; désactivable avec `updates.check = false`. Le contrôle manuel reste toujours possible.

## Risks / Trade-offs

- Limite de 60 requêtes/heure de l'API GitHub sans jeton → largement suffisant à 4 contrôles par jour ; une erreur réseau est silencieuse en automatique et affichée en manuel.
- App non notarisée : Gatekeeper pourrait bloquer la nouvelle copie → la quarantaine est retirée, et l'archive est vérifiée avant.
- Le script de remplacement tourne après la fin de l'app : en cas d'échec, l'ancienne app est remise en place et relancée.
