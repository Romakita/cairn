# Spec Delta

## MODIFIED Requirements

### Requirement: Identifiants seulement sur destination chiffrée
La catégorie « identifiants » (par exemple `~/.codex/auth.json`, `~/.codex/.credentials.json`) MUST être sauvegardée uniquement si toutes les destinations de la sauvegarde sont chiffrées. Avec une destination non chiffrée, ou sans destination, la catégorie est retirée de la sauvegarde même si elle est cochée, et sa case est désactivée avec la raison affichée. Les identifiants rangés par un outil dans le Trousseau macOS ne sont pas sauvegardés, et l'app l'indique.

#### Scenario: Destination non chiffrée
- **WHEN** une destination de la sauvegarde n'est pas chiffrée
- **THEN** « identifiants » est désactivé pour tous les outils, son infobulle explique pourquoi, et aucun fichier d'identifiants n'est copié

#### Scenario: Jeton dans le Trousseau
- **WHEN** l'outil range son jeton dans le Trousseau macOS (cas de Claude Code)
- **THEN** la vue IA indique qu'une reconnexion sera nécessaire après restauration
