# Spec Delta

## ADDED Requirements

### Requirement: Accès complet au disque
Cairn SHALL détecter s'il a l'Accès complet au disque de macOS. Sans cet accès, l'app MUST l'indiquer par un bandeau sur l'accueil et l'écran Sauvegardes, avec un bouton qui ouvre le réglage système concerné, et `cairn backup` MUST l'écrire sur la sortie d'erreur avant de commencer. Les éléments sautés parce que macOS en refuse la lecture MUST être comptés et signalés dans le résultat, le journal et la notification, jamais passés sous silence.

#### Scenario: Accès refusé
- **WHEN** Cairn n'a pas l'Accès complet au disque
- **THEN** l'accueil et l'écran Sauvegardes affichent un bandeau qui explique que Documents, Téléchargements et d'autres dossiers protégés ne seront pas sauvegardés, avec un bouton « Ouvrir les réglages »

#### Scenario: Dossiers protégés sautés
- **WHEN** une sauvegarde se termine alors que macOS a refusé la lecture de certains éléments
- **THEN** le résultat indique le nombre d'éléments non lus à cause des autorisations et en cite quelques-uns, et la notification le mentionne

### Requirement: Applications exclues des sauvegardes de dossiers
La sauvegarde d'un dossier suivi MUST exclure les applications, qui se réinstallent : le dossier `Applications` à la racine du dossier suivi et tout paquet `*.app`. Ces éléments ne sont pas pour autant classés régénérables par l'analyse, qui ne les propose jamais au nettoyage.

#### Scenario: Home suivi en entier
- **WHEN** le home est un dossier suivi et contient `~/Applications/WebStorm.app`
- **THEN** ni `~/Applications` ni l'app ne sont copiés, et l'écran Nettoyable ne les propose pas

#### Scenario: App construite dans un projet
- **WHEN** un projet contient `build/Demo.app`
- **THEN** le paquet `Demo.app` n'est pas copié

### Requirement: Caches de paquets régénérables
Les caches des gestionnaires de paquets (`.bun/install/cache`, `.npm-cache`, `.npm/_cacache`, `.pnpm-store`) MUST être classés régénérables (catégorie caches) par l'analyse et exclus de la sauvegarde, comme `node_modules`.

#### Scenario: Cache npm local à un projet
- **WHEN** un projet contient `.npm-cache/`
- **THEN** il n'est pas copié et l'analyse le compte comme cache régénérable

## MODIFIED Requirements

### Requirement: Simulation, progression et journal
Cairn SHALL proposer une simulation qui indique ce qui serait copié et sa taille sans rien écrire. Pendant une sauvegarde, il affiche la progression et permet l'annulation. Chaque exécution MUST écrire un journal dans `~/.cairn/logs/` et un état (succès, échec, durée, taille) consultable dans l'app.

La progression MUST montrer, pour chaque destination, la phase en cours : préparation, comptage, copie, finalisation, terminé. Pendant tout le comptage des fichiers, l'avancement de chaque compteur (dossier en cours, fichiers trouvés) SHALL rester visible, que le total soit déjà connu ou non. La copie indique le dossier en cours (« dossier n sur N ») et un pourcentage qui n'atteint 100 % qu'à la fin. La finalisation affiche ses étapes : empreintes, vérification de l'échantillon, image, compactage.

#### Scenario: Simulation
- **WHEN** l'utilisateur lance une simulation
- **THEN** Cairn affiche le volume à copier par partie, et la destination n'est pas modifiée

#### Scenario: Notification d'échec
- **WHEN** une sauvegarde planifiée échoue
- **THEN** une notification macOS indique l'échec et donne accès au journal

#### Scenario: Comptage avec un total déjà connu
- **WHEN** une sauvegarde démarre alors que le total de fichiers d'une sauvegarde précédente est connu
- **THEN** les compteurs de fichiers restent affichés pendant tout le comptage, et le pourcentage utilise le total connu jusqu'à la fin du nouveau comptage

#### Scenario: Deux destinations
- **WHEN** la copie vers la première destination est finie et sa finalisation commence
- **THEN** la carte de la première affiche les étapes de finalisation pendant que la seconde affiche sa propre copie

#### Scenario: Sauvegarde complète de bout en bout
- **WHEN** l'utilisateur lance une sauvegarde complète vers une destination locale et une destination SMB
- **THEN** chaque destination passe par toutes les phases jusqu'à « terminé », une nouvelle version complète devient `latest`, et le journal ne contient aucune erreur

### Requirement: Reprise d'une sauvegarde interrompue
Une sauvegarde interrompue (app quittée, veille, réseau coupé, annulation) SHALL reprendre là où elle s'était arrêtée au lancement suivant : les fichiers déjà copiés ne sont pas recopiés, et un gros fichier partiellement copié reprend à partir de la partie déjà transférée. Une version interrompue MUST NOT être visible comme version terminée. À la reprise d'une version complète, les parties qui ne font plus partie de la sélection MUST être retirées de la version en cours, pour qu'elle ne contienne que ce qui est sauvegardé.

#### Scenario: App quittée pendant la première sauvegarde
- **WHEN** l'app est quittée après 40 Go copiés sur 60
- **THEN** la sauvegarde suivante ne transfère que les 20 Go restants, plus ce qui a changé entre-temps

#### Scenario: Partie retirée entre deux tentatives
- **WHEN** une sauvegarde interrompue contenait `folders/home` et que l'utilisateur a retiré ce dossier de la sauvegarde avant la reprise
- **THEN** la reprise supprime `folders/home` de la version en cours avant la copie, et la version terminée ne le contient pas
