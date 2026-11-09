# Spec Delta

## MODIFIED Requirements

### Requirement: Choix de la sauvegarde
Cairn SHALL lister les versions disponibles sur une destination configurée, ou dans un dossier choisi à la main. Sur une destination en mode `archive`, chaque archive est une version. Un fichier d'archive `.dmg` peut aussi être choisi à la main. Pour chacune, Cairn affiche la date, la machine d'origine, l'architecture et les parties présentes. Une destination ou une archive chiffrée MUST demander son mot de passe s'il n'est pas dans le Trousseau. Une archive est ouverte en lecture seule et refermée à la fin de la restauration.

#### Scenario: Nouveau Mac
- **WHEN** Cairn est lancé sur un Mac neuf et que l'utilisateur choisit « Restaurer une sauvegarde » dans l'assistant
- **THEN** il peut se connecter au NAS, choisir une version et voir son contenu avant de restaurer

#### Scenario: Architecture différente
- **WHEN** la version a été faite sur une architecture différente de celle de la machine
- **THEN** Cairn affiche un avertissement avant la restauration

#### Scenario: Restauration depuis une archive
- **WHEN** l'utilisateur choisit une archive d'une destination en mode archive et saisit son mot de passe
- **THEN** Cairn ouvre l'archive en lecture seule, affiche ses parties, restaure comme depuis une version rsync, puis referme l'archive

#### Scenario: Archive choisie à la main
- **WHEN** l'utilisateur lance `cairn restore --from ~/Downloads/cairn-MacBook-Pro-2026-11-01-1300.dmg`
- **THEN** Cairn ouvre l'archive (en demandant le mot de passe si elle est chiffrée) et simule la restauration
