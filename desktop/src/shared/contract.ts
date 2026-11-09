// biome-ignore-all lint/suspicious/noConfusingVoidType: `result: void` = méthode sans valeur de retour (Promise<void>).
// Contrat entre le process principal et l'interface (design.md, décision 6 ; parity/platform.md §5).
//
// - Le main possède l'état : il pousse un `AppSnapshot` complet (au plus 10 par seconde) à chaque fenêtre abonnée.
// - L'interface n'appelle que les méthodes métier de `CairnApi` ; chaque argument est validé dans le main par le
//   schéma zod de `schemas.ts`, et l'origine de l'appel est vérifiée (`app://cairn`).
// - Les suppressions désignent des éléments du dernier état connu du main (`nodeId`, plan de suppression…), jamais
//   des chemins libres ; les confirmations destructives sont redemandées par le main.
// - Les mots de passe vont de l'interface au main une seule fois et ne reviennent jamais (sauf le mot de passe d'une
//   image neuve, montré une fois).
//
// Ce fichier n'importe que des TYPES du core (aucun code) : il est partagé par le main, le preload et l'interface.
import type { AnalysisSummary, BigObject, Project } from "../core/analysis.ts";
import type { DestinationProgress } from "../core/backup/progress.ts";
import type { BackupResult as CoreBackupResult } from "../core/backup/run.ts";
import type { DestinationRunState } from "../core/backup/run-state.ts";
import type { PartKind } from "../core/backup/types.ts";
import type {
  AIToolConfig,
  AlertsConfig,
  AnalysisConfig,
  CairnConfig,
  DestinationConfig,
  FolderConfig,
  Frequency,
  GitConfig,
  HomeConfig,
  Provider,
  Retention,
  ScheduleConfig,
  Severity,
} from "../core/config.ts";
import type { BackupAction } from "../core/destinations/actions.ts";
import type { ExistingImage, FolderEntry, ProbeFailure, ProbeResult } from "../core/destinations/failure.ts";
import type { CleanupResult } from "../core/git/apply.ts";
import type { PoolProgress } from "../core/git/pool.ts";
import type { GitOptions, RepoReport } from "../core/git/types.ts";
import type { HealthLevel } from "../core/health.ts";
import type { HubState } from "../core/hub-state.ts";
import type { Inventory } from "../core/inventory/types.ts";
import type { AppLanguage } from "../core/l10n.ts";
import type { PathSuggestion } from "../core/path-completion.ts";
import type { Category } from "../core/regenerable.ts";
import type { RestoreProgress, RestoreStep } from "../core/restore/service.ts";
import type { ScanProgress } from "../core/scanner.ts";
import type { StorageAlert } from "../core/storage-alerts.ts";

export type {
  AnalysisSummary,
  BackupAction,
  BigObject,
  CairnConfig,
  Category,
  CleanupResult,
  DestinationConfig,
  DestinationProgress,
  DestinationRunState,
  ExistingImage,
  FolderEntry,
  HealthLevel,
  HubState,
  Inventory,
  PathSuggestion,
  PoolProgress,
  ProbeFailure,
  ProbeResult,
  Project,
  RepoReport,
  Retention,
  StorageAlert,
};

/** Version du contrat (le preload et le main sont construits ensemble ; utile aux captures et aux tests). */
export const CONTRACT_VERSION = 1;

/** Préfixe des canaux IPC ; `cairn:<méthode>` pour chaque méthode de `CairnMethods`. */
export const CHANNEL_PREFIX = "cairn:";
/** Canal poussé par le main : nouvel état complet. */
export const SNAPSHOT_CHANNEL = "cairn:snapshot";
/** Canal poussé par le main : navigation demandée (notification « Nettoyer », barre des menus…). */
export const NAVIGATE_CHANNEL = "cairn:navigate";
/** Origine autorisée pour les appels IPC. */
export const APP_ORIGIN = "app://cairn";

// MARK: État poussé par le main

/** Problème de `config.toml` (copie simple de `ConfigIssue`, avec son texte traduit). */
export interface IssueView {
  severity: Severity;
  key: string;
  line: number | null;
  message: string;
  description: string;
}

export interface ConfigView {
  /** Chemin de `config.toml`. */
  file: string;
  /** Le fichier existe (sinon : premier lancement, assistant). */
  exists: boolean;
  /** Dernière configuration valide (par défaut si aucune n'a encore été lue). */
  config: CairnConfig;
  issues: IssueView[];
  /** Le fichier sur disque contient une erreur : planification bloquée, enregistrement refusé. */
  hasErrors: boolean;
  /** `config` est la dernière configuration valide, pas celle du fichier (rechargement à chaud). */
  usingLastValid: boolean;
}

export interface VersionView {
  name: string;
  /** Date de la version (ms), d'après son nom. */
  date: number | null;
  partial: boolean;
  damaged: boolean;
}

export interface HistoryView {
  status: "idle" | "loading" | "loaded" | "failed";
  versions: VersionView[];
  error: string | null;
  /** Dernière lecture (ms). */
  loadedAt: number | null;
}

export interface DestinationView {
  id: string;
  /** Nom affiché (chemin court ou hôte). */
  label: string;
  provider: Provider;
  config: DestinationConfig;
  health: HealthLevel;
  /** `null` : pas encore sondée. */
  reachable: boolean | null;
  /** Injoignable au dernier tour du planificateur. */
  waiting: boolean;
  run: DestinationRunState;
  /** Prochaine échéance (ms), `null` en manuel. */
  nextBackup: number | null;
  history: HistoryView;
  /** Action → clé de traduction de la raison de son indisponibilité, `null` si elle est possible. */
  unavailable: Record<BackupAction, string | null>;
}

/** Résultat d'une destination, sans secret (le mot de passe d'une image neuve passe par `newImagePasswords`). */
export type BackupResultView = Omit<CoreBackupResult, "newImagePassword" | "outcome"> & {
  version: string | null;
  filesTransferred: number;
  bytesTransferred: number;
};

export interface BackupView {
  running: boolean;
  dryRun: boolean;
  /** Début de l'exécution en cours ou de la dernière (ms). */
  startedAt: number | null;
  finishedAt: number | null;
  /** Progression par destination visée (modèle `backup/progress.ts`). */
  destinations: DestinationProgress[];
  /** Destinations dont l'arrêt est demandé. */
  stopping: string[];
  /** Journal de l'exécution en cours ou de la dernière. */
  log: string | null;
  /** Résultats de la dernière exécution. */
  lastResults: BackupResultView[] | null;
  /** Erreur hors destination (verrou tenu, configuration invalide…). */
  lastError: string | null;
  /** Mot de passe d'une image chiffrée créée par la dernière sauvegarde : montré une fois, puis `acknowledge`. */
  newImagePasswords: { destination: string; password: string }[];
}

export interface VerificationView {
  destination: string;
  full: boolean;
  running: boolean;
  /** Version en cours, fichiers vérifiés et à vérifier. */
  version: string | null;
  done: number;
  total: number;
  /** Versions vérifiées et leurs fichiers abîmés. */
  reports: { version: string; damaged: number; missingChecksums: boolean }[];
  error: string | null;
}

/** Nœud de l'arbre d'analyse vu par l'interface (les enfants se lisent avec `analysisChildren`). */
export interface NodeView {
  id: number;
  name: string;
  path: string;
  isDirectory: boolean;
  category: Category;
  size: number;
  fileCount: number;
  /** Octets par catégorie, dans l'ordre de `CATEGORIES`. */
  breakdown: number[];
  childCount: number;
  isGitRepo: boolean;
  /** Dossier régénérable (supprimable sans perte). */
  regenerable: boolean;
}

export interface FolderScanView {
  folder: string;
  available: boolean;
  root: NodeView | null;
  errors: number;
  duration: number;
}

export interface AnalysisView {
  running: boolean;
  progress: ScanProgress | null;
  startedAt: number | null;
  finishedAt: number | null;
  folders: FolderScanView[];
  /** Gros fichiers puis gros dossiers (50 premiers), avec le nœud correspondant s'il est dans l'arbre. */
  bigObjects: (BigObject & { nodeId: number | null })[];
  projects: Project[];
  /** Dossiers régénérables, du plus gros au plus petit (200 premiers) : écran « Nettoyable ». */
  regenerable: NodeView[];
  /** Présélection proposée en arrivant d'une alerte (rien n'est supprimé sans confirmation). */
  preselection: number[];
  /** Résumé persistant de la dernière analyse (`state/analysis-summary.json`). */
  summary: AnalysisSummary | null;
  /** La dernière analyse date de plus de 7 jours. */
  stale: boolean;
  error: string | null;
}

export interface StorageView {
  /** Alertes en cours (volumes sous un seuil ou pleins dans moins de 7 jours). */
  alerts: StorageAlert[];
  /** Espace libre du volume principal (premier dossier suivi). */
  freeBytes: number | null;
  lastCheck: number | null;
}

export interface GitView {
  running: boolean;
  progress: PoolProgress | null;
  /** Rapports reçus au fil de l'eau, dans l'ordre d'arrivée. */
  reports: RepoReport[];
  failed: Record<string, string>;
  options: GitOptions;
  startedAt: number | null;
  finishedAt: number | null;
  applying: boolean;
  lastCleanup: CleanupResult | null;
  error: string | null;
}

export interface InventoryView {
  status: "idle" | "loading" | "loaded" | "failed";
  inventory: Inventory | null;
  error: string | null;
}

export interface AIToolView {
  id: string;
  name: string;
  detected: boolean;
  bytesByCategory: Record<string, number>;
  totalBytes: number;
  conversations: number;
  latestConversation: number | null;
  lastBackup: number | null;
  /** Catégories cochées dans `config.toml`. */
  categories: string[];
}

export interface AIView {
  status: "idle" | "loading" | "loaded" | "failed";
  tools: AIToolView[];
  /** Raison pour laquelle les identifiants ne sont pas sauvegardés (texte traduit), `null` si permis. */
  credentialsBlock: string | null;
  error: string | null;
}

export type UpdatePhase = "idle" | "checking" | "downloading" | "failed";

export interface UpdateView {
  current: string;
  available: { version: string; notes: string; pageURL: string } | null;
  phase: UpdatePhase;
  error: string | null;
  /**
   * Raison (texte traduit) pour laquelle l'installation est impossible maintenant, `null` sinon. Suit l'état de la
   * sauvegarde en direct : le bouton se réactive dès la fin de la sauvegarde (0f7a1ce).
   */
  blocker: string | null;
  installable: boolean;
  lastCheck: number | null;
  /** Dernier contrôle manuel : « à jour » (texte traduit) ou `null`. */
  message: string | null;
}

export interface LockView {
  /** Le verrou d'opération est tenu (par cette app ou par la commande `cairn`). */
  held: boolean;
  /** Tenu par un autre processus (la commande `cairn`, une autre instance). */
  byOther: boolean;
  holder: string | null;
}

/** Partie restaurable (même découpage que `cairn restore --parts`). */
export type RestorePart = "tools" | "home" | "ai" | "folders";

/** Étape d'une restauration (simulée ou appliquée) : `home`, `folders/<nom>`, `ai`, `ai/<outil>`, `tool:<nom>`… */
export type RestoreStepView = RestoreStep;

/** Avancement d'une restauration appliquée (modèle `restore/service.ts`, sérialisable). */
export type RestoreProgressView = RestoreProgress;

export interface RestoreView {
  /** La restauration est branchée (moteur `src/core/restore`). */
  available: boolean;
  /** Une restauration appliquée est en cours. */
  running: boolean;
  /** Dernier plan préparé (`planRestore`). */
  plan: RestorePlanView | null;
  /** Avancement de la restauration en cours ou de la dernière appliquée. */
  progress: RestoreProgressView | null;
  /** Dernière restauration appliquée : toutes les étapes ont réussi (`null` avant la première). */
  ok: boolean | null;
  /** Erreur de la dernière restauration appliquée (verrou tenu, destination fermée…), texte traduit. */
  error: string | null;
}

export interface ActivityView {
  kind: string;
  date: number;
  subject?: string;
  count?: number;
  bytes?: number;
  level?: string;
}

/** Message bref à afficher (barre de messages) : déjà traduit. */
export interface MessageView {
  id: number;
  level: "info" | "success" | "warning" | "error";
  text: string;
  date: number;
}

export interface BackgroundView {
  /** Ouverture à la connexion demandée (`schedule.background`). */
  enabled: boolean;
  /** État de l'élément d'ouverture : `requires-approval` à valider dans Réglages Système. */
  status: "enabled" | "not-registered" | "requires-approval" | "not-found" | "unknown";
}

export interface AppSnapshot {
  /** Incrémenté à chaque changement (les fenêtres ignorent un état plus ancien). */
  revision: number;
  contract: number;
  version: string;
  language: AppLanguage;
  /** Exécution de développement (`electron .`) ou app empaquetée. */
  packaged: boolean;
  /** Aucun `config.toml` : premier lancement, assistant. */
  firstLaunch: boolean;
  config: ConfigView;
  destinations: DestinationView[];
  backup: BackupView;
  verification: VerificationView | null;
  analysis: AnalysisView;
  storage: StorageView;
  git: GitView;
  inventory: InventoryView;
  ai: AIView;
  hub: HubState;
  /** Mini-graphique de l'accueil : 7 derniers jours, du plus ancien à aujourd'hui. */
  backupDays: (boolean | null)[];
  activity: ActivityView[];
  updates: UpdateView;
  lock: LockView;
  restore: RestoreView;
  background: BackgroundView;
  /** Notifications système disponibles (sinon les alertes restent visibles dans l'app seulement). */
  notificationsSupported: boolean;
  messages: MessageView[];
}

// MARK: Navigation poussée par le main

export type Route =
  | "home"
  | "storage"
  | "clean"
  | "explorer"
  | "backup"
  | "restore"
  | "git"
  | "tools"
  | "ai"
  | "settings"
  | "onboarding";

export interface NavigationRequest {
  route: Route;
  /** Destination, volume… selon l'écran. */
  ref?: string;
  /** « Nettoyer » depuis une alerte : présélection des dossiers régénérables (identifiants de nœuds). */
  preselect?: number[];
}

// MARK: Arguments des méthodes

export interface StartBackupArgs {
  /** Absent : toutes les destinations. */
  destinations?: string[];
  dryRun?: boolean;
  /** Absent : toutes les parties (sinon la version est partielle). */
  only?: PartKind[];
  /** Limiter la partie IA à ces outils. */
  aiTools?: string[];
}

export interface VerifyArgs {
  destination: string;
  version?: string;
  full?: boolean;
  /** Mots de passe saisis pour cette session (Mac neuf) : jamais renvoyés. */
  imagePassword?: string;
  sharePassword?: string;
}

export interface RemoveNodesArgs {
  nodeIds: number[];
  /** `false` (défaut) : corbeille. `true` : suppression définitive, confirmée par le main. */
  permanently?: boolean;
}

export interface GitSelection {
  repo: string;
  branches: string[];
  /** Chemins des worktrees. */
  worktrees: string[];
}

export type ConfigPatch =
  | { kind: "language"; language: string }
  | { kind: "analysis"; analysis: Partial<AnalysisConfig> }
  | { kind: "folders"; folders: FolderConfig[] }
  | { kind: "home"; home: Partial<HomeConfig> }
  | { kind: "ai"; ai: AIToolConfig[] }
  | { kind: "schedule"; schedule: Partial<ScheduleConfig> }
  | { kind: "alerts"; alerts: Partial<AlertsConfig> }
  | { kind: "git"; git: Partial<GitConfig> }
  | { kind: "updates"; check: boolean }
  | { kind: "excludedTools"; excludedTools: string[] }
  | { kind: "logRetentionDays"; days: number };

/** Destination vérifiée, avant l'attribution de son identifiant. */
export type NewDestination = Omit<DestinationConfig, "id">;

/** Brouillon de l'assistant (les ensembles passent en tableaux). */
export interface OnboardingDraftWire {
  folders: { path: string; selected: boolean }[];
  home: { path: string; selected: boolean }[];
  ai: { id: string; detected: boolean; categories: string[] }[];
  destination: { kind: "later" } | { kind: "local"; path: string } | { kind: "smb"; url: string; username: string };
  encrypted: boolean;
  frequency: Frequency;
  time: string;
  weekday: string;
  background: boolean;
  language: string;
}

export interface RemovalPlanView {
  /** Jeton du plan, à repasser à `removeDestination` (le main garde le plan). */
  planId: string;
  destination: string;
  includeBackups: boolean;
  items: (
    | { kind: "configuration"; id: string }
    | { kind: "state"; id: string }
    | { kind: "backups"; path: string; bytes: number }
  )[];
  backupsUnavailable: string | null;
  canExecute: boolean;
  backupBytes: number;
}

export interface RetentionPlanView {
  planId: string;
  destination: string;
  decision: "apply" | "confirm" | "unreachable";
  /** Versions qui seraient supprimées et leur taille propre, `null` si la destination est illisible. */
  excess: { names: string[]; bytes: number } | null;
}

/**
 * Source d'une restauration : une destination configurée, ou un dossier (version Cairn, sauvegarde de backup.sh, ou
 * racine d'une destination avec `cairn/<machine>/versions`).
 */
export type RestoreSource = { kind: "destination"; destination: string } | { kind: "folder"; path: string };

export interface RestorePlanArgs {
  source: RestoreSource;
  /** Nom de la version (`--version`) ; absent : la plus récente complète de ce Mac. */
  version?: string;
  /** Parties à restaurer ; absent : outils CLI et home (plan par défaut de la 0.8.0). */
  parts?: RestorePart[];
  /** Dossiers de la sauvegarde à restaurer (noms) ; absent : tous, si `folders` est dans `parts`. */
  folders?: string[];
  /** Dossier restauré → nouvel emplacement (`--target nom=chemin`). */
  targets?: Record<string, string>;
  /** Outils IA à restaurer (`--tool`) ; absent : tous ceux de la sauvegarde, si `ai` est dans `parts`. */
  tools?: string[];
  replaceDatabases?: boolean;
  /** Tailles par partie et simulation complète (rien n'est écrit) : récapitulatif avant « Restaurer ». */
  simulate?: boolean;
  /** Mots de passe saisis pour cette restauration (Mac neuf) : jamais renvoyés ni enregistrés. */
  imagePassword?: string;
  sharePassword?: string;
}

/** Version trouvée sur une destination (toutes les machines). */
export interface RestoreVersionView {
  name: string;
  machine: string;
  /** Date de la version (ms), d'après son nom. */
  date: number | null;
  partial: boolean;
  /** Version de ce Mac. */
  thisMac: boolean;
}

export interface RestoreFolderView {
  name: string;
  /** Emplacement d'origine sur la machine sauvegardée. */
  originalPath: string;
  /** Cible retenue (l'origine par défaut, ou `targets[nom]`). */
  target: string;
  /** La cible n'existe pas sur ce Mac (volume absent : à créer ou à changer). */
  targetMissing: boolean;
}

/** Version ouverte : ce qu'elle contient. */
export interface RestoreSourceView {
  kind: "cairn" | "legacy";
  path: string;
  date: number | null;
  machine: string;
  arch: string;
  /** Architecture de ce Mac (`uname -m`). */
  currentArch: string;
  archMatches: boolean;
  home: boolean;
  folders: RestoreFolderView[];
  aiTools: { id: string; name: string }[];
  /** Inventaire des outils CLI présent (réinstallation possible). */
  tools: boolean;
}

export interface RestorePlanView {
  /** Jeton du plan, à repasser à `applyRestore` (le main garde le plan et la destination ouverte). */
  planId: string;
  source: RestoreSource;
  /** Mot de passe à saisir pour ouvrir la destination (Mac neuf) ; le reste du plan est alors vide. */
  needsPassword: "share" | "image" | null;
  /** Versions de la destination (vide pour une version ouverte directement depuis un dossier). */
  versions: RestoreVersionView[];
  /** Version retenue (nom), `null` pour un dossier ou sans version. */
  version: string | null;
  details: RestoreSourceView | null;
  /** Parties retenues (celles absentes de la version sont retirées). */
  parts: RestorePart[];
  /** Outils IA retenus. */
  ai: string[];
  replaceDatabases: boolean;
  /** Octets à copier par partie (`home`, `folders/<nom>`, `ai/<outil>`), après `simulate`. */
  sizes: Record<string, number>;
  /** Étapes de la simulation (après `simulate`) : outils présents, à installer, à réinstaller à la main… */
  steps: RestoreStepView[];
  /** Avertissements (texte traduit) : architecture différente, cible absente. */
  warnings: string[];
  /** La simulation a été faite : `applyRestore` est possible. */
  simulated: boolean;
}

export type ShowTarget = { kind: "node"; nodeId: number } | { kind: "path"; path: string };

export type OpenTarget =
  | { kind: "log"; file: string }
  | { kind: "config" }
  | { kind: "logs" }
  | { kind: "node"; nodeId: number }
  | { kind: "repo"; repo: string };

export interface ChooseFolderArgs {
  /** Texte du bouton (traduit par l'interface). */
  buttonLabel?: string;
  defaultPath?: string;
}

/** Résultat d'une suppression d'éléments de l'analyse. */
export interface RemovalOutcome {
  /** Annulée à la confirmation (rien n'a été supprimé). */
  cancelled: boolean;
  removed: number;
  freed: number;
  failures: { path: string; message: string }[];
}

/** Résultat d'une action confirmée par le main (`cancelled` : refusée par l'utilisateur, rien n'a changé). */
export interface Confirmed<T = void> {
  cancelled: boolean;
  value?: T;
}

export interface SMBConnectResult {
  ok: boolean;
  failure: ProbeFailure | null;
  /** Texte de l'échec et indication (traduits). */
  message: string | null;
  hint: string | null;
  /** Racine du partage monté (navigateur). */
  root: string | null;
}

export interface SavedDestinationView {
  destination: DestinationConfig;
  keychainError: string | null;
}

// MARK: Méthodes

/**
 * Méthodes métier : nom → arguments et résultat. Un seul argument (objet) par méthode, `undefined` sans argument.
 * Les canaux IPC sont `cairn:<nom>` ; `schemas.ts` a un schéma par nom (vérifié à la compilation).
 */
export interface CairnMethods {
  getSnapshot: { args: undefined; result: AppSnapshot };

  // Sauvegarde
  startBackup: { args: StartBackupArgs; result: void };
  stopBackup: { args: { destination?: string }; result: void };
  acknowledgeImagePassword: { args: { destination: string }; result: void };
  verify: { args: VerifyArgs; result: void };
  refreshHistory: { args: { destination: string }; result: void };

  // Analyse du disque et nettoyage
  scan: { args: { folders?: string[] }; result: void };
  cancelScan: { args: undefined; result: void };
  analysisChildren: { args: { nodeId: number }; result: NodeView[] };
  removeNodes: { args: RemoveNodesArgs; result: RemovalOutcome };
  checkStorage: { args: undefined; result: void };
  snoozeAlert: { args: { volume: string }; result: void };
  /** « Tout vérifier » de l'accueil (lecture seule) : analyse, git complet, joignabilité. */
  checkAll: { args: undefined; result: void };
  cancelCheckAll: { args: undefined; result: void };

  // Maintenance git
  gitAnalyze: { args: { fullCheck?: boolean; only?: string }; result: void };
  gitCancel: { args: undefined; result: void };
  gitApply: { args: { selections: GitSelection[] }; result: Confirmed<CleanupResult> };
  gitCompact: { args: { repo: string }; result: Confirmed };
  gitTrashRepo: { args: { repo: string }; result: Confirmed };

  // Outils et IA
  toolsRefresh: { args: undefined; result: void };
  toolsExport: { args: undefined; result: { dir: string } | null };
  aiRefresh: { args: undefined; result: void };
  aiExport: { args: undefined; result: { file: string } | null };

  // Configuration
  saveConfig: { args: { patches: ConfigPatch[] }; result: void };
  homeChoices: { args: undefined; result: string[] };
  completePath: { args: { input: string }; result: PathSuggestion[] };
  onboardingDetect: { args: undefined; result: OnboardingDraftWire };
  onboardingFinish: { args: { draft: OnboardingDraftWire; password?: string }; result: void };

  // Destinations
  probeLocal: { args: { path: string }; result: ProbeResult };
  connectSMB: { args: { address: string; username: string; password?: string }; result: SMBConnectResult };
  checkSMB: { args: { address: string; username: string; password?: string }; result: ProbeResult };
  listShares: { args: { host: string; username: string; password?: string }; result: string[] };
  closeProbe: { args: undefined; result: void };
  localRoots: { args: undefined; result: FolderEntry[] };
  listFolders: { args: { path: string }; result: FolderEntry[] };
  createFolder: { args: { parent: string; name: string }; result: string };
  addDestination: { args: { destination: NewDestination; password?: string }; result: SavedDestinationView };
  editDestination: {
    args: { id: string; destination: NewDestination; password?: string };
    result: SavedDestinationView;
  };
  planDestinationRemoval: { args: { id: string; includeBackups: boolean }; result: RemovalPlanView };
  removeDestination: { args: { planId: string }; result: Confirmed };
  planRetention: { args: { destination: string; retention: Retention }; result: RetentionPlanView };
  applyRetention: { args: { planId: string }; result: Confirmed<{ deleted: string[]; failed: string[] }> };

  // Restauration (simulation d'abord ; `applyRestore` est confirmé par le main, puis suivi par `restore.progress`)
  planRestore: { args: RestorePlanArgs; result: RestorePlanView };
  applyRestore: { args: { planId: string }; result: Confirmed };

  // Mises à jour
  checkUpdates: { args: undefined; result: void };
  installUpdate: { args: undefined; result: void };

  // Système
  openTarget: { args: OpenTarget; result: void };
  showInFinder: { args: ShowTarget; result: void };
  openExternal: { args: { url: string }; result: void };
  copyText: { args: { text: string }; result: void };
  chooseFolder: { args: ChooseFolderArgs; result: string | null };
  openWindow: { args: NavigationRequest; result: void };
  hidePanel: { args: undefined; result: void };
  dismissMessage: { args: { id: number }; result: void };
  quit: { args: undefined; result: void };
}

export type MethodName = keyof CairnMethods;
export type MethodArgs<M extends MethodName> = CairnMethods[M]["args"];
export type MethodResult<M extends MethodName> = CairnMethods[M]["result"];

/** Liste des méthodes (le preload crée une fonction par nom ; le main un gestionnaire par nom). */
export const METHOD_NAMES = [
  "getSnapshot",
  "startBackup",
  "stopBackup",
  "acknowledgeImagePassword",
  "verify",
  "refreshHistory",
  "scan",
  "cancelScan",
  "analysisChildren",
  "removeNodes",
  "checkStorage",
  "snoozeAlert",
  "checkAll",
  "cancelCheckAll",
  "gitAnalyze",
  "gitCancel",
  "gitApply",
  "gitCompact",
  "gitTrashRepo",
  "toolsRefresh",
  "toolsExport",
  "aiRefresh",
  "aiExport",
  "saveConfig",
  "homeChoices",
  "completePath",
  "onboardingDetect",
  "onboardingFinish",
  "probeLocal",
  "connectSMB",
  "checkSMB",
  "listShares",
  "closeProbe",
  "localRoots",
  "listFolders",
  "createFolder",
  "addDestination",
  "editDestination",
  "planDestinationRemoval",
  "removeDestination",
  "planRetention",
  "applyRetention",
  "planRestore",
  "applyRestore",
  "checkUpdates",
  "installUpdate",
  "openTarget",
  "showInFinder",
  "openExternal",
  "copyText",
  "chooseFolder",
  "openWindow",
  "hidePanel",
  "dismissMessage",
  "quit",
] as const satisfies readonly MethodName[];

// Chaque méthode de `CairnMethods` est dans la liste (erreur de compilation sinon).
type Missing = Exclude<MethodName, (typeof METHOD_NAMES)[number]>;
const _allMethodsListed: Missing extends never ? true : Missing = true;
void _allMethodsListed;

export type Unsubscribe = () => void;

/** API exposée à l'interface : `window.cairn` (preload) ou l'API d'exemple (`renderer/api/fixtures`). */
export type CairnApi = {
  [M in MethodName]: MethodArgs<M> extends undefined
    ? () => Promise<MethodResult<M>>
    : (args: MethodArgs<M>) => Promise<MethodResult<M>>;
} & {
  /** Reçoit chaque nouvel état (le premier arrive aussitôt). */
  subscribe(listener: (snapshot: AppSnapshot) => void): Unsubscribe;
  /** Navigation demandée par le main (notification, barre des menus). */
  onNavigate(listener: (request: NavigationRequest) => void): Unsubscribe;
};

// MARK: Erreurs

export type ApiErrorCode =
  | "invalidArguments"
  | "forbidden"
  | "notFound"
  | "locked"
  | "busy"
  | "invalidConfig"
  | "notImplemented"
  | "failed";

/** Réponse d'un canal : le preload la déballe et lève `CairnApiError` en cas d'échec. */
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: ApiErrorCode; message: string } };

export class CairnApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CairnApiError";
  }
}
