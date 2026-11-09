# Proposal

## Why

Depuis le début du projet, aucun backup complet n'a abouti. Des bugs déjà corrigés reviennent : l'affichage des workers de comptage, par exemple, a disparu de la progression. Et l'interface s'écarte du design system de Codex, avec des menus et contrôles natifs, des couleurs hors jetons et du jargon.

En SwiftUI construit avec les seuls Command Line Tools, il est difficile de voir et de tester l'interface. Une interface web dans Electron, elle, se vérifie écran par écran (Playwright, captures). Réécrire coûte peu, puisque le code est généré. On repart donc sur Electron + TypeScript, à parité fonctionnelle, avec une liste de contrôle des régressions.

## What Changes

- Réécriture de l'app et de la commande `cairn` en TypeScript : process principal Electron, interface React, logique métier dans un module sans Electron. Bun sert à l'outillage (paquets, bundling, tests) ; l'app tourne sur le Node d'Electron.
- Parité fonctionnelle avec la 0.8.0. Elle couvre les 11 capacités de `openspec/specs/` et les deltas livrés mais non archivés (`app-updates`, `component-gallery`, `edit-and-delete-destination`, `git-row-actions`, `home-hub`). La liste de contrôle détaillée est dans `parity/behavior.md`.
- Compatibilité des données. La nouvelle version relit sans migration :
  - `~/.cairn` (ou `CAIRN_HOME`) : `config.toml` réécrit sans perte, `state/`, `logs/` ;
  - les entrées du Trousseau ;
  - les sauvegardes existantes : images, versions, manifests, empreintes.
- Même exécutable pour l'app et la CLI. Les liens `~/.local/bin/cairn` déjà installés continuent de fonctionner, et la CLI garde ses commandes, ses options, ses sorties et ses codes de retour.
- Une interface conforme au design system de Codex, appliqué partout :
  - jetons CSS repris de la palette actuelle ;
  - une seule bibliothèque de composants, visible dans la galerie ;
  - aucune commande native visible, hors dialogues système ;
  - toute action indisponible est désactivée et sa raison est affichée ;
  - aucun jargon.
  Les 25 problèmes relevés dans `parity/ui.md` §4 sont corrigés.
- Une progression de sauvegarde détaillée et stable : phases, comptage par workers, copie dossier par dossier, finalisation, puis une carte par destination.
- Des écarts entre specs et code tranchés. Voir les specs modifiées ci-dessous et `design.md`.
- La distribution change : zip signé ad hoc d'environ 100 Mo (au lieu de 5 Mo), installable par la mise à jour intégrée de l'app Swift 0.8.x.
- **BREAKING (développement)** :
  - `just test`, `just storage-install` et la CI passent à Bun/Electron ;
  - les sources Swift (`Cairn/`) sont retirées une fois la parité vérifiée ;
  - rien ne change pour l'utilisateur.

## Capabilities

### New Capabilities
- `interface-design` : règles du design system de l'app (jetons clair/sombre, bibliothèque de composants unique, galerie, actions indisponibles avec leur raison, vocabulaire sans jargon).
- `app-packaging` : distribution et installation de l'app (zip et son contrat de mise à jour, signature, lien de la commande, compatibilité des données et du Trousseau avec la version précédente).

### Modified Capabilities
- `backup` : la progression affichée est précisée (phases, workers de comptage visibles pendant tout le comptage, copie par dossier, finalisation, carte par destination).
- `ai-tools` : les identifiants ne sont jamais copiés vers une destination non chiffrée. On aligne ainsi la spec sur le comportement actuel, plus prudent qu'un avertissement suivi d'une confirmation.
- `restore` : les outils go et `~/.local/bin` sont listés comme réinstallations manuelles, alignés sur le comportement actuel.

## Impact

- **Code** : nouveau dossier `desktop/` (projet Bun/Electron). `Cairn/` (Swift) reste en place jusqu'à la parité, puis il est retiré.
- **Outillage** : `justfile`, `.github/workflows/ci.yml` et `release.yml`, `.releaserc.json` et `Cairn/scripts/*`. `package.json` devient la source de version, au lieu de `Cairn/VERSION` et de la constante Swift.
- **Dépendances** : Electron, React, electron-builder, Playwright, plus un petit module natif (Objective-C, N-API) pour le Trousseau, le montage SMB, `flock` et l'espace libre APFS.
- **Docs** : `README.md`, `README.fr.md`, `Cairn/README.md` et `DESIGN.md` (qui devient `desktop/DESIGN.md`), `AGENTS.md` (règles de l'app).
- **Utilisateurs** : mise à jour plus lourde à télécharger. Le Trousseau et l'Accès complet au disque peuvent redemander une autorisation à la première version Electron (voir `design.md`, Risques).
