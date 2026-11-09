# Spec Delta

## MODIFIED Requirements

### Requirement: Réinstallation des outils
Cairn SHALL réinstaller les outils de l'inventaire dans cet ordre : Homebrew (formules et taps), mise, npm global, uv, pipx, puis cargo. Les outils go et ceux de `~/.local/bin` sont listés comme réinstallations manuelles, avec leur nom et leur version, sans tentative d'installation. Les outils déjà présents sont ignorés et chaque échec est journalisé sans arrêter les suivants. Une étape qui demande un mot de passe administrateur (installation de Homebrew ou des Command Line Tools) MUST s'ouvrir dans Terminal plutôt que de demander ce mot de passe dans l'app.

#### Scenario: Homebrew absent
- **WHEN** Homebrew n'est pas installé
- **THEN** Cairn ouvre Terminal avec la commande officielle d'installation, attend la fin de l'installation, puis reprend

#### Scenario: Échec d'un outil
- **WHEN** l'installation d'un paquet npm échoue
- **THEN** l'échec est noté et les outils suivants sont quand même installés

#### Scenario: Outil go
- **WHEN** l'inventaire sauvegardé contient un outil installé par `go install`
- **THEN** la restauration le liste comme « à réinstaller à la main » avec sa version, et l'étape finale le compte comme manquant s'il est absent
