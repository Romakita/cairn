# Spec Delta

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
