# Spec Delta

## Purpose

Sauvegarde les dossiers suivis et la partie du home choisie par l'utilisateur vers une ou plusieurs destinations (NAS Synology, dossier local, puis drives en ligne), de façon chiffrée, versionnée et planifiée, en reprenant ce que faisait `backup.sh`.

## ADDED Requirements

### Requirement: Contenu d'une sauvegarde
Une sauvegarde SHALL contenir :
- les dossiers suivis activés pour la sauvegarde ;
- les éléments du home sélectionnés ;
- les données des outils IA sélectionnées (voir la capacité `ai-tools`) ;
- l'inventaire des outils ;
- un manifest (date, machine, architecture, version de macOS, version de Cairn, liste des parties).

#### Scenario: Sauvegarde complète
- **WHEN** une sauvegarde de `/Volumes/workspaces` et du home se termine
- **THEN** la destination contient ces dossiers, la partie `ai/` des outils IA, l'inventaire des outils et un manifest daté

### Requirement: Exclusions du contenu régénérable
La sauvegarde des dossiers MUST exclure les mêmes contenus régénérables que l'analyse (dépendances, builds, caches, environnements Python, métadonnées de volume). Dans un dépôt git, les dossiers génériques (`lib`, `build`, `out`, `target`, `tmp`, `vendor`) MUST n'être exclus que s'ils sont ignorés par le `.gitignore` du dépôt. L'utilisateur SHALL pouvoir ajouter ses propres motifs d'exclusion.

#### Scenario: Projet Node
- **WHEN** un projet contient `node_modules/` et `dist/`
- **THEN** ni l'un ni l'autre n'est copié

#### Scenario: Dossier lib versionné
- **WHEN** un dépôt git suit un dossier `lib/` qui n'est pas ignoré
- **THEN** `lib/` est copié

### Requirement: Sélection du home par l'utilisateur
L'utilisateur SHALL choisir les éléments du home à sauvegarder dans une liste d'éléments détectés (fichiers de configuration du shell, `~/.config/*`, `~/.ssh`, `~/.aws`, `~/.gitconfig`, configurations des outils IA…) ou par chemins libres. Rien d'autre du home n'est copié. Les caches et installations reconstructibles MUST être exclus même s'ils se trouvent dans un élément sélectionné.

#### Scenario: Sélection restreinte
- **WHEN** l'utilisateur sélectionne seulement `~/.zshrc`, `~/.ssh` et `~/.config/mise`
- **THEN** la sauvegarde du home ne contient que ces trois éléments

#### Scenario: Cache dans un dossier sélectionné
- **WHEN** l'utilisateur sélectionne `~/.config/gcloud`
- **THEN** ses sous-dossiers de cache et de journaux ne sont pas copiés

### Requirement: Destinations par fournisseur
Chaque destination SHALL être décrite par un type de fournisseur et ses paramètres. Dès cette version, les fournisseurs « dossier local / disque externe » et « NAS SMB » (Synology) MUST être disponibles. L'ajout d'un fournisseur de drive en ligne MUST se faire sans modifier le moteur de sauvegarde.

#### Scenario: NAS non monté
- **WHEN** une sauvegarde vise `smb://nas.local/backups` et le partage n'est pas monté
- **THEN** Cairn monte le partage avec les identifiants du Trousseau, sauvegarde, puis démonte ce qu'il a monté

#### Scenario: Une destination sur deux joignable
- **WHEN** une sauvegarde vise un disque externe branché et le NAS, qui ne répond pas
- **THEN** la version est écrite sur le disque externe, et le NAS est mis en attente (voir « Destination injoignable »)

### Requirement: Chiffrement
Une destination SHALL pouvoir être chiffrée (activé par défaut). Les données sont alors écrites dans une image disque chiffrée en AES-256 sur la destination, dont le mot de passe est dans le Trousseau. Sans chiffrement, Cairn MUST avertir que des secrets du home seront stockés en clair.

#### Scenario: Destination chiffrée
- **WHEN** une sauvegarde vers une destination chiffrée se termine
- **THEN** la destination ne contient qu'une image chiffrée, illisible sans le mot de passe

#### Scenario: Désactivation du chiffrement
- **WHEN** l'utilisateur désactive le chiffrement sur une destination alors que `~/.ssh` est sélectionné
- **THEN** Cairn affiche un avertissement et demande une confirmation explicite

### Requirement: Versions et rétention
Chaque sauvegarde réussie SHALL créer une version datée. Les fichiers inchangés depuis la version précédente ne sont pas recopiés et ne prennent pas de place en plus. Les versions en trop MUST n'être supprimées qu'après la réussite d'une nouvelle version.

#### Scenario: Sauvegarde échouée
- **WHEN** une sauvegarde échoue
- **THEN** aucune version existante n'est supprimée

### Requirement: Rétention par paliers
Par défaut, chaque destination SHALL garder toutes les versions des 30 derniers jours, puis une version par semaine (la plus récente de la semaine) sur les 48 semaines suivantes, soit environ un an. Les deux nombres (jours et semaines) se règlent par destination. Les versions plus anciennes que les deux paliers sont supprimées.

#### Scenario: Sauvegardes quotidiennes sur plus d'un mois
- **WHEN** une sauvegarde quotidienne tourne depuis 60 jours avec la rétention par défaut
- **THEN** les 30 dernières versions quotidiennes sont gardées, et pour les 30 jours précédents seule la dernière version de chaque semaine reste

#### Scenario: Version de plus d'un an
- **WHEN** une version a plus de 30 jours + 48 semaines
- **THEN** elle est supprimée après la prochaine sauvegarde réussie

### Requirement: Réglage simple de la rétention
Les réglages SHALL proposer trois choix : « Recommandé » (30 jours, puis 48 semaines), « Nombre fixe de versions » (de 1 à 520) et « Personnalisé » (jours et semaines). Cairn MUST afficher la durée couverte et le nombre maximal de versions. Une réduction de la rétention ne supprime les versions en trop qu'après confirmation, en indiquant combien et l'espace libéré.

#### Scenario: Choix par défaut
- **WHEN** l'utilisateur ouvre la rétention d'une nouvelle destination
- **THEN** « Recommandé » est sélectionné, avec la mention « 30 jours en quotidien, puis 1 an en hebdomadaire »

#### Scenario: Nombre fixe
- **WHEN** l'utilisateur choisit « Nombre fixe » avec 12 versions
- **THEN** seules les 12 versions les plus récentes sont gardées, quel que soit leur âge

#### Scenario: Rétention réduite
- **WHEN** l'utilisateur passe de « Recommandé » à 12 versions alors que 60 existent
- **THEN** Cairn demande de confirmer la suppression des 48 plus anciennes avec l'espace libéré, et n'en supprime aucune en cas d'annulation

### Requirement: Planification tant que l'app est ouverte
Cairn SHALL lancer les sauvegardes selon la récurrence de `config.toml` (quotidienne à une heure donnée par défaut, hebdomadaire, ou manuelle) tant que l'app tourne. Une échéance manquée pendant que l'app était fermée ou le Mac en veille MUST déclencher une sauvegarde au prochain lancement ou au réveil.

#### Scenario: Échéance manquée
- **WHEN** la sauvegarde quotidienne de 12 h a été manquée parce que l'app était fermée et que l'app est lancée à 15 h
- **THEN** une sauvegarde démarre dans la minute

#### Scenario: Sauvegarde déjà en cours
- **WHEN** une échéance arrive alors qu'une sauvegarde est déjà en cours
- **THEN** aucune seconde sauvegarde n'est lancée

### Requirement: Fonctionnement en tâche de fond accepté par l'utilisateur
Au premier lancement, Cairn SHALL expliquer que les sauvegardes planifiées demandent que l'app tourne en tâche de fond (icône dans la barre des menus, ouverture à la connexion), et MUST demander l'accord de l'utilisateur. Sans cet accord, les sauvegardes planifiées ne partent que pendant que l'app est ouverte, et l'accord peut être donné plus tard dans les réglages.

#### Scenario: Accord refusé
- **WHEN** l'utilisateur refuse le fonctionnement en tâche de fond
- **THEN** Cairn ne s'ajoute pas à l'ouverture de session, et quitter l'app arrête les sauvegardes planifiées jusqu'à sa prochaine ouverture

#### Scenario: Accord donné
- **WHEN** l'utilisateur accepte
- **THEN** Cairn s'ouvre à la connexion et reste dans la barre des menus quand sa fenêtre est fermée

### Requirement: Veille et alimentation
Par défaut, une sauvegarde SHALL ne tourner que si le Mac est éveillé : Cairn ne le réveille pas pour sauvegarder. Pendant une sauvegarde, il empêche la mise en veille automatique par inactivité, mais pas la veille demandée par l'utilisateur (capot fermé, menu Pomme). Si le Mac se met en veille, la sauvegarde est suspendue puis reprise au réveil. Sur batterie, une sauvegarde planifiée MUST attendre si le mode économie d'énergie est actif ou si la batterie est sous 20 %.

#### Scenario: Capot fermé pendant une sauvegarde
- **WHEN** l'utilisateur ferme le capot au milieu d'une sauvegarde
- **THEN** le Mac se met en veille, et la sauvegarde reprend au réveil sans recopier ce qui a déjà été transféré

#### Scenario: Batterie faible
- **WHEN** une échéance arrive alors que le Mac est sur batterie à 15 %
- **THEN** la sauvegarde attend le branchement secteur ou une batterie au-dessus de 20 %

### Requirement: Reprise d'une sauvegarde interrompue
Une sauvegarde interrompue (app quittée, veille, réseau coupé, annulation) SHALL reprendre là où elle s'était arrêtée au lancement suivant : les fichiers déjà copiés ne sont pas recopiés, et un gros fichier partiellement copié reprend à partir de la partie déjà transférée. Une version interrompue MUST NOT être visible comme version terminée.

#### Scenario: App quittée pendant la première sauvegarde
- **WHEN** l'app est quittée après 40 Go copiés sur 60
- **THEN** la sauvegarde suivante ne transfère que les 20 Go restants, plus ce qui a changé entre-temps

### Requirement: Destination injoignable
Quand une destination n'est pas joignable (NAS hors du réseau, disque débranché), Cairn SHALL ne pas lancer de sauvegarde vers elle et la mettre en attente. La sauvegarde part automatiquement dès que la destination redevient joignable. Aucune notification n'est envoyée tant que le retard est inférieur à un jour. Au-delà, Cairn MUST prévenir au plus une fois par jour, en indiquant la date de la dernière sauvegarde réussie.

#### Scenario: Retour sur le réseau du NAS
- **WHEN** le Mac revient sur le réseau du NAS après deux jours d'absence
- **THEN** la sauvegarde en attente démarre dans les 5 minutes

#### Scenario: Retard de plus d'un jour
- **WHEN** le NAS est injoignable depuis 30 heures alors qu'une sauvegarde quotidienne est prévue
- **THEN** une seule notification indique « dernière sauvegarde il y a 2 jours », et aucune autre n'est envoyée avant 24 heures

#### Scenario: Retard de moins d'un jour
- **WHEN** le NAS est injoignable depuis 3 heures
- **THEN** aucune notification n'est envoyée, et l'état « en attente du NAS » est visible dans la barre des menus

### Requirement: Contrôle d'intégrité
Chaque version SHALL contenir la liste des empreintes SHA-256 de ses fichiers. Seuls les fichiers nouveaux ou modifiés sont hachés, les autres reprennent l'empreinte de la version précédente. Cairn MUST vérifier les sauvegardes :
- un échantillon de fichiers de la dernière version et l'image disque, une fois par mois ;
- toutes les versions et tous les fichiers, à la demande.

Un fichier abîmé est signalé, et la sauvegarde suivante le recopie depuis la source au lieu de le lier à la copie abîmée.

#### Scenario: Fichier corrompu sur le NAS
- **WHEN** une vérification trouve un fichier dont l'empreinte ne correspond plus
- **THEN** la version est marquée « abîmée » avec la liste des fichiers, une notification est envoyée, et la sauvegarde suivante recopie ces fichiers depuis la source

#### Scenario: Vérification complète à la demande
- **WHEN** l'utilisateur lance une vérification complète d'une destination
- **THEN** Cairn recalcule l'empreinte de chaque fichier de chaque version et affiche le résultat par version, sans rien modifier

### Requirement: Simulation, progression et journal
Cairn SHALL proposer une simulation qui indique ce qui serait copié et sa taille sans rien écrire. Pendant une sauvegarde, il affiche la progression et permet l'annulation. Chaque exécution MUST écrire un journal dans `~/.cairn/logs/` et un état (succès, échec, durée, taille) consultable dans l'app.

#### Scenario: Simulation
- **WHEN** l'utilisateur lance une simulation
- **THEN** Cairn affiche le volume à copier par partie, et la destination n'est pas modifiée

#### Scenario: Notification d'échec
- **WHEN** une sauvegarde planifiée échoue
- **THEN** une notification macOS indique l'échec et donne accès au journal
