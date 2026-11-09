# AGENTS.md

Instructions pour les agents IA (Claude Code, Codex, etc.) qui travaillent dans ce repo.

## Projet

**Cairn** (`Cairn/`) : app macOS et commande `cairn` (même binaire) pour analyser l'occupation disque, sauvegarder
(dossiers, home, outils IA, inventaire des CLI), restaurer et nettoyer les dépôts git. Lancée via `just` depuis la racine.
Les anciens scripts bash ont été retirés (historique git). Voir [README.md](README.md) et [Cairn/README.md](Cairn/README.md).

- Langue du projet : français (docs, commentaires, artefacts OpenSpec) ; l'app est bilingue en-US / fr-FR.
- Commits : [Conventional Commits](https://www.conventionalcommits.org/) en anglais (`feat(scope): …`, `fix: …`,
  `docs: …`). Le type fixe la prochaine version (semantic-release, au merge sur `main`) : breaking change (`feat!:` ou
  `BREAKING CHANGE:`) → majeure, `feat` → mineure, `fix`/`perf` → patch, les autres types → pas de release. Ne pas
  toucher `Cairn/VERSION` ni `CHANGELOG.md` à la main : la CI les génère. La note de release (CHANGELOG, release
  GitHub et fenêtre de mise à jour de l'app) est faite des sujets des commits `feat`/`fix`/`perf` et breaking : les
  écrire comme une ligne de note lisible par un utilisateur (« verify a destination before saving it », pas
  « address review »). Les retouches de revue vont dans un commit `refactor`/`test`/`chore`, ou sont fusionnées dans
  le commit `feat`/`fix` d'origine.
- Nom de branche : `<type>/<description-courte>`, en anglais et en kebab-case, avec le même `type` que les
  Conventional Commits (`feat/`, `fix/`, `docs/`, `ci/`, `refactor/`, `perf/`, `test/`, `chore/`…). Exemples :
  `feat/in-app-updates`, `fix/ai-wal-database-backup`, `ci/semver-release`. Pas de numéro ni de suffixe aléatoire.
  Une session dont la branche a un nom généré (`claude/wonderful-varahamihira-8cbf34`, `claude/home-hub-8b5a95`…)
  la renomme dès qu'elle sait ce qu'elle va faire, avant le premier commit : `git branch -m <type>/<description>`
  (si la branche est déjà poussée : pousser la nouvelle, supprimer l'ancienne sur `origin` après accord).
- Branche de PR : la remettre à jour par rebase sur `main` (pas de commit de fusion), puis `git push --force-with-lease`.
- Cairn touche au home et à des tokens : toute opération destructive (suppression, nettoyage git, restauration)
  doit rester explicite, confirmée et avoir un mode simulation.

## OpenSpec (développement piloté par les specs)

OpenSpec est initialisé dans `openspec/` (schéma `spec-driven`, artefacts en français).

- `openspec/specs/` : comportement actuel du système (source de vérité).
- `openspec/changes/` : changements proposés, un dossier par changement ; `archive/` une fois livrés.

Commandes Claude Code (skills équivalents dans `.claude/skills/` et `.agents/skills/`) :

| Commande | Rôle |
|---|---|
| `/opsx:explore` | Explorer une idée ou un problème avant de proposer |
| `/opsx:propose` | Créer un changement avec proposal, design, specs et tâches en une fois |
| `/opsx:new` / `/opsx:continue` / `/opsx:ff` | Créer un changement pas à pas / artefact suivant / tout générer d'un coup |
| `/opsx:update` | Mettre à jour les artefacts d'un changement |
| `/opsx:apply` | Implémenter les tâches d'un changement |
| `/opsx:verify` | Vérifier que l'implémentation correspond aux artefacts |
| `/opsx:sync` | Reporter les deltas de specs dans `openspec/specs/` |
| `/opsx:archive` / `/opsx:bulk-archive` | Archiver un ou plusieurs changements terminés |
| `/opsx:onboard` | Tutoriel guidé du workflow |

CLI utile : `openspec list`, `openspec show <change>`, `openspec validate <change>`.
Après une mise à jour d'OpenSpec : `openspec update` pour régénérer les skills.

## Orchestration du travail

### 1. Planifier par défaut
- Mode plan pour toute tâche non triviale (3 étapes ou plus, ou décision d'architecture).
- Nouvelle fonctionnalité ou changement de comportement : passer par OpenSpec (`/opsx:propose`).
- Si ça dérape : STOP, on re-planifie tout de suite au lieu de forcer.
- Planifier aussi les étapes de vérification, pas seulement la construction.
- Écrire des specs détaillées en amont pour lever l'ambiguïté.

### 2. Sous-agents
- Utiliser les sous-agents largement pour garder le contexte principal propre.
- Leur déléguer la recherche, l'exploration et les analyses parallèles.
- Pour les problèmes complexes, mettre plus de calcul via des sous-agents.
- Une tâche par sous-agent, pour qu'il reste concentré.

### 3. Boucle d'amélioration
- Après TOUTE correction de l'utilisateur : ajouter la leçon dans [tasks/lessons.md](tasks/lessons.md).
- Écrire des règles qui empêchent de refaire la même erreur.
- Itérer sur ces leçons jusqu'à ce que le taux d'erreur baisse.
- Relire `tasks/lessons.md` au début de chaque session.

### 4. Vérifier avant de terminer
- Ne jamais marquer une tâche terminée sans prouver qu'elle marche.
- Comparer le comportement entre `main` et les changements quand c'est pertinent.
- Se demander : « Est-ce qu'un Staff engineer validerait ça ? »
- Lancer les vérifications, lire les logs, démontrer que c'est correct. Dans ce repo :
  - `just test` (Swift Testing, à faire passer à chaque lot) ;
  - les modes simulation : `just backup-dry`, `just git-clean`, `just restore`, `just check` ;
  - pour un changement OpenSpec : `openspec validate <change>` puis `/opsx:verify`.
  - pour `Cairn/` : `just test`, `just storage-report` (totaux à comparer à
    `du -sk <dossier>`), puis `just storage-install` pour reconstruire l'app.

### 5. Exiger l'élégance (avec mesure)
- Pour un changement non trivial : se demander « y a-t-il une façon plus élégante ? ».
- Si un correctif semble bricolé : « Avec tout ce que je sais maintenant, implémenter la solution propre. »
- Ne pas le faire pour les correctifs simples et évidents : pas de sur-ingénierie.
- Remettre en cause son propre travail avant de le présenter.

### 6. Correction de bugs autonome
- Face à un rapport de bug : le corriger, sans demander qu'on tienne la main.
- Partir des logs, erreurs et tests en échec, puis les résoudre.
- Aucun changement de contexte demandé à l'utilisateur.
- Corriger la CI en échec sans qu'on explique comment.

## Gestion des tâches

Pour le travail qui ne passe pas par un changement OpenSpec :

1. **Planifier d'abord** : écrire le plan dans [tasks/todo.md](tasks/todo.md) avec des cases à cocher.
2. **Valider le plan** : faire un point avant de commencer l'implémentation.
3. **Suivre l'avancement** : cocher les éléments au fur et à mesure.
4. **Expliquer les changements** : résumé de haut niveau à chaque étape.
5. **Documenter le résultat** : ajouter une section « Revue » dans `tasks/todo.md`.
6. **Capturer les leçons** : mettre à jour `tasks/lessons.md` après chaque correction.

## App Cairn

- L'app doit rester constructible avec les seuls Command Line Tools (sans Xcode) : leur plugin de macro `@State`
  est absent, utiliser `@ViewState` (alias défini dans `Compat.swift`) ; éviter `@Observable` et `#Preview`.
- Les tests (`Tests/CairnTests`) utilisent Swift Testing et demandent Xcode (`xcode-select` pointé sur Xcode) :
  une suite par fichier, déclarée dans `extension CairnTests { @Suite struct … }` (suite racine dans
  `TestSupport.swift` : `CAIRN_HOME` temporaire, inventaire des outils vide). Les tests tournent en parallèle :
  un test qui passe par `CLI.run`, change `L10n.current` ou compare un texte traduit porte `@Test(.globalState)`.
  Un test qui doit lancer un autre processus passe par `Tests/CairnTestHelper` (`builtExecutable("CairnTestHelper")`).
- `CairnCore` (bibliothèque, sans SwiftUI) contient la logique ; `Cairn` (exécutable) l'interface et l'aiguillage
  vers la ligne de commande (`main.swift`).
- Tout texte visible passe par `T("clé")` / `L10n.tr` avec une entrée dans `en.lproj` ET `fr.lproj`
  (`Sources/CairnCore/Resources`) ; le test `L10n.no_untranslated_ui_strings` échoue sinon.
- L'analyse (`Scanner.swift`) ne doit jamais rien modifier sur le disque ; les suppressions passent
  uniquement par l'interface, après confirmation, et la corbeille est proposée par défaut.
- Les règles de « régénérable » sont communes à l'analyse et à la sauvegarde (`Scanner.alwaysRegenerable`,
  `BackupExclusions`) : toute nouvelle règle va dans les deux.
- Les notifications passent par `Notifier` (UNUserNotificationCenter plante hors d'un bundle .app).
- Les analyses git lourdes passent par le pool de workers (`GitWorkerPool`) : ne jamais charger un diff ou un
  historique entier en mémoire (`Git.pipe`).

## Principes

- **Simplicité d'abord** : chaque changement aussi simple que possible, le moins de code touché.
- **Pas de paresse** : trouver la cause racine, pas de correctif temporaire. Standards de dev senior.
- **Impact minimal** : ne toucher que le nécessaire, éviter d'introduire des bugs.
