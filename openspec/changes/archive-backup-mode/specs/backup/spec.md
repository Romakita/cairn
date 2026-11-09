# Spec Delta

## MODIFIED Requirements

### Requirement: Planification tant que l'app est ouverte
Cairn SHALL lancer les sauvegardes selon la récurrence de `config.toml` tant que l'app tourne : quotidienne à une heure donnée (par défaut), hebdomadaire (jour et heure), mensuelle (jour du mois de 1 à 28 et heure) ou manuelle. Chaque destination SHALL pouvoir avoir sa propre récurrence. Sans récurrence propre, la récurrence commune s'applique. Une échéance manquée pendant que l'app était fermée ou le Mac en veille MUST déclencher une sauvegarde au prochain lancement ou au réveil.

#### Scenario: Échéance manquée
- **WHEN** la sauvegarde quotidienne de 12 h a été manquée parce que l'app était fermée et que l'app est lancée à 15 h
- **THEN** une sauvegarde démarre dans la minute

#### Scenario: Sauvegarde déjà en cours
- **WHEN** une échéance arrive alors qu'une sauvegarde est déjà en cours
- **THEN** aucune seconde sauvegarde n'est lancée

#### Scenario: Deux rythmes sur le même NAS
- **WHEN** la destination `nas` (rsync) est quotidienne à 12 h 30, et la destination `nas-archive` (archive) est mensuelle le 1er à 13 h
- **THEN** le 1er du mois, `nas` est sauvegardée à 12 h 30 puis `nas-archive` à 13 h ; les autres jours, seule `nas` est sauvegardée

#### Scenario: Récurrence commune
- **WHEN** une destination n'a pas de récurrence propre
- **THEN** elle suit la récurrence commune de `[schedule]`

## ADDED Requirements

### Requirement: Mode de sauvegarde par destination
Chaque destination SHALL avoir un mode, choisi à sa création : `rsync` (versions incrémentales, par défaut) ou `archive` (une archive complète par sauvegarde). Le mode MUST NOT pouvoir être modifié après la création. Pour en changer, l'utilisateur crée une autre destination. Le mode SHALL être affiché sur la page de la destination.

#### Scenario: Choix à la création
- **WHEN** l'utilisateur ajoute une destination
- **THEN** le formulaire propose « Versions incrémentales (rsync) » et « Archive complète », avec pour chacune une ligne qui explique la place prise et la vitesse

#### Scenario: Mode figé
- **WHEN** l'utilisateur modifie une destination existante
- **THEN** le mode est affiché sans pouvoir être changé, avec l'indication qu'il faut créer une autre destination pour en changer

#### Scenario: Configuration sans mode
- **WHEN** `config.toml` contient une destination sans clé `mode`
- **THEN** elle est traitée en mode `rsync`, comme avant ce changement

### Requirement: Archive complète
En mode `archive`, chaque sauvegarde réussie SHALL produire une image disque compressée en lecture seule, avec la même arborescence, le même contenu et les mêmes exclusions qu'une version rsync. Sur une destination chiffrée, l'image MUST être chiffrée en AES-256 avec le mot de passe de la destination. Une archive incomplète MUST NOT apparaître comme terminée.

#### Scenario: Archive créée
- **WHEN** une sauvegarde vers une destination en mode archive se termine
- **THEN** la destination contient un nouveau fichier `.dmg` daté pour ce Mac, qui s'ouvre sur un autre Mac avec le mot de passe et dont les empreintes correspondent

#### Scenario: Sauvegarde interrompue
- **WHEN** la création d'une archive est interrompue (coupure réseau, veille, annulation)
- **THEN** aucune archive incomplète n'apparaît dans la liste, et le fichier partiel est supprimé au lancement suivant

#### Scenario: Espace local insuffisant
- **WHEN** l'espace libre sur ce Mac est inférieur à la taille estimée de l'archive à préparer
- **THEN** la sauvegarde échoue avant toute copie avec un message qui indique l'espace nécessaire, et la destination n'est pas modifiée

#### Scenario: Simulation
- **WHEN** l'utilisateur simule une sauvegarde en mode archive
- **THEN** Cairn indique la taille estimée et le nombre de fichiers, sans rien écrire sur la destination ni dans le dossier de préparation

### Requirement: Rétention des archives
En mode `archive`, Cairn SHALL garder les N dernières archives de ce Mac sur la destination (4 par défaut, de 1 à 99). La plus ancienne MUST n'être supprimée qu'après la réussite d'une nouvelle archive. La rétention par paliers MUST NOT être proposée en mode archive. Les archives des autres Mac ne sont jamais supprimées.

#### Scenario: Cinquième archive
- **WHEN** la destination garde 4 archives et qu'une cinquième se termine avec succès
- **THEN** la plus ancienne archive de ce Mac est supprimée et il en reste 4

#### Scenario: Échec
- **WHEN** la création d'une archive échoue
- **THEN** aucune archive existante n'est supprimée

#### Scenario: Rétention par paliers dans la configuration
- **WHEN** `config.toml` donne une rétention `tiered` à une destination en mode archive
- **THEN** la validation de la configuration signale l'erreur sur cette ligne
