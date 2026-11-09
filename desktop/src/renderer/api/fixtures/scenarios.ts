// États scénarisés de l'API d'exemple, choisis par l'URL (`?scenario=<id>`). Chaque scénario part de l'état normal.
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot } from "../../../shared/contract.ts";
import { simulatedProgress } from "./backup-simulation.ts";
import {
  daysAgo,
  destinationView,
  diskAlert,
  FIXTURE_NOW,
  fixtureConfig,
  GB,
  normalSnapshot,
  repoReport,
  runState,
  sampleInventory,
} from "./base.ts";

export const SCENARIO_IDS = [
  "empty",
  "normal",
  "backup-running",
  "backup-failed",
  "analysis-running",
  "disk-critical",
  "git-many-repos",
  "update-available",
  "config-invalid",
  "unencrypted-destination",
  "restore",
  "backup-new-image",
  "messages",
  "backup-simulated",
  "no-full-disk-access",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface Scenario {
  id: ScenarioId;
  /** Description courte (outillage : captures, galerie). */
  description: string;
  build(): AppSnapshot;
  /** Une sauvegarde simulée tourne dès l'ouverture. */
  backupRunning?: boolean;
  /** Cette sauvegarde est une simulation (`dryRun`) : rien n'est copié, le volume par partie est montré à la fin. */
  backupDryRun?: boolean;
  /** Une analyse simulée tourne dès l'ouverture. */
  analysisRunning?: boolean;
  /** Mac neuf : la restauration demande le mot de passe de l'image et trouve les versions de l'ancien Mac. */
  newMac?: boolean;
}

function empty(): AppSnapshot {
  const s = normalSnapshot();
  const config = { ...fixtureConfig(), folders: [], destinations: [], ai: [], home: { include: [], exclude: [] } };
  return {
    ...s,
    firstLaunch: true,
    config: { ...s.config, exists: false, config },
    destinations: [],
    backup: { ...s.backup, startedAt: null, finishedAt: null, log: null },
    analysis: {
      ...s.analysis,
      startedAt: null,
      finishedAt: null,
      folders: [],
      bigObjects: [],
      projects: [],
      regenerable: [],
      preselection: [],
      summary: null,
      stale: true,
    },
    storage: { alerts: [], freeBytes: null, volumes: [], lastCheck: null },
    git: { ...s.git, reports: [], startedAt: null, finishedAt: null },
    ai: { status: "idle", tools: [], credentialsBlock: null, error: null },
    hub: {
      lastCheck: null,
      checking: false,
      overall: "ok",
      causes: [],
      topIssue: null,
      modules: [
        {
          module: "storage",
          tone: "unknown",
          figure: { kind: "notAnalyzed" },
          detail: { kind: "none" },
          action: "analyze",
        },
        {
          module: "backup",
          tone: "attention",
          figure: { kind: "noDestination" },
          detail: { kind: "none" },
          action: "addDestination",
        },
        {
          module: "git",
          tone: "unknown",
          figure: { kind: "notAnalyzed" },
          detail: { kind: "none" },
          action: "analyzeGit",
        },
        { module: "ai", tone: "unknown", figure: { kind: "notAnalyzed" }, detail: { kind: "none" }, action: "viewAI" },
        {
          module: "restore",
          tone: "unknown",
          figure: { kind: "noVersion" },
          detail: { kind: "none" },
          action: "restore",
        },
      ],
    },
    backupDays: [null, null, null, null, null, null, null],
    activity: [],
    background: { enabled: false, status: "not-registered" },
  };
}

function backupRunning(): AppSnapshot {
  const s = normalSnapshot();
  return {
    ...s,
    backup: {
      ...s.backup,
      running: true,
      startedAt: FIXTURE_NOW.getTime(),
      finishedAt: null,
      destinations: simulatedProgress(0),
      log: "/Users/demo/.cairn/logs/backup-20261109-100000.log",
    },
    destinations: s.destinations.map((d) => ({
      ...d,
      unavailable: {
        simulate: "backup.unavailable.running",
        verify: "backup.unavailable.running",
        verifyFull: "backup.unavailable.running",
        backup: "backup.unavailable.running",
      },
    })),
    hub: {
      ...s.hub,
      modules: s.hub.modules.map((m) => (m.module === "backup" ? { ...m, figure: { kind: "backingUp" } } : m)),
    },
    lock: { held: true, byOther: false, holder: "4242 backup" },
  };
}

function backupFailed(): AppSnapshot {
  const s = normalSnapshot();
  const config = s.config.config;
  const nas = config.destinations[0]!;
  const disk = config.destinations[1]!;
  const error = "rsync failed (code 23): some files could not be transferred";
  return {
    ...s,
    destinations: [
      destinationView(nas, {
        health: "error",
        run: runState({
          lastSuccess: daysAgo(3, 21),
          lastAttempt: daysAgo(0, 1),
          lastFailure: daysAgo(0, 1),
          lastError: error,
        }),
      }),
      destinationView(disk, {
        health: "attention",
        reachable: false,
        waiting: true,
        run: runState({ lastSuccess: daysAgo(2, 21), waitingSince: daysAgo(1, 22) }),
        unavailable: {
          simulate: "backup.unavailable.unreachable",
          verify: "backup.unavailable.unreachable",
          verifyFull: "backup.unavailable.unreachable",
          backup: "backup.unavailable.unreachable",
        },
      }),
    ],
    backup: {
      ...s.backup,
      startedAt: daysAgo(0, 1).getTime(),
      finishedAt: daysAgo(0, 1).getTime() + 95_000,
      lastResults: [
        {
          destination: "nas",
          error,
          waiting: false,
          stopped: false,
          damagedFiles: [],
          imageCheck: null,
          permissionDenied: { count: 0, examples: [] },
          log: "/Users/demo/.cairn/logs/backup-20261109-090000.log",
          version: null,
          filesTransferred: 0,
          bytesTransferred: 0,
          bytesByPart: {},
        },
        {
          destination: "disk",
          error: null,
          waiting: true,
          stopped: false,
          damagedFiles: [],
          imageCheck: null,
          permissionDenied: { count: 0, examples: [] },
          log: "/Users/demo/.cairn/logs/backup-20261109-090000.log",
          version: null,
          filesTransferred: 0,
          bytesTransferred: 0,
          bytesByPart: {},
        },
      ],
    },
    hub: {
      ...s.hub,
      overall: "error",
      causes: [
        { kind: "backupFailed", subject: "nas.local", ref: "nas" },
        { kind: "destinationOverdue", subject: "cairn", ref: "disk" },
      ],
      topIssue: { kind: "backupFailed", subject: "nas.local", ref: "nas" },
      modules: s.hub.modules.map((m) =>
        m.module === "backup"
          ? { ...m, tone: "error", figure: { kind: "failed", label: "nas.local" }, action: "openBackup" }
          : m,
      ),
    },
    backupDays: [true, true, true, true, null, false, false],
    activity: [
      { kind: "backupFailed", date: daysAgo(0, 1).getTime(), subject: "nas" },
      ...s.activity.slice(0, 2).map((a) => ({ ...a, date: daysAgo(3, 21).getTime() })),
    ],
  };
}

function analysisRunning(): AppSnapshot {
  const s = normalSnapshot();
  return {
    ...s,
    analysis: {
      ...s.analysis,
      running: true,
      startedAt: FIXTURE_NOW.getTime(),
      finishedAt: null,
      progress: { files: 0, bytes: 0, current: "/Volumes/workspaces", errors: 0 },
    },
  };
}

function diskCritical(): AppSnapshot {
  const s = normalSnapshot();
  const alert = diskAlert(2, 3.1 * GB, 1.3);
  return {
    ...s,
    storage: {
      alerts: [alert],
      freeBytes: alert.available,
      volumes: [{ volume: "workspaces", free: alert.available, total: 238 * GB }, ...s.storage.volumes.slice(1)],
      lastCheck: FIXTURE_NOW.getTime(),
    },
    hub: {
      ...s.hub,
      overall: "attention",
      causes: [{ kind: "diskCritical", subject: "workspaces", ref: "workspaces", bytes: alert.available }],
      topIssue: { kind: "diskCritical", subject: "workspaces", ref: "workspaces", bytes: alert.available },
      modules: s.hub.modules.map((m) =>
        m.module === "storage" ? { ...m, tone: "error", figure: { kind: "free", bytes: alert.available } } : m,
      ),
    },
    activity: [
      {
        kind: "diskAlert",
        date: FIXTURE_NOW.getTime() - 600_000,
        subject: "workspaces",
        bytes: alert.available,
        level: "critical",
      },
      ...s.activity,
    ],
  };
}

function gitManyRepos(): AppSnapshot {
  const s = normalSnapshot();
  const names = Array.from({ length: 79 }, (_, i) => `project-${String(i + 1).padStart(2, "0")}`);
  const reports = names.map((n, i) =>
    repoReport(n, {
      gitBytes: 40_000_000 + i * 7_000_000,
      looseBytes: i % 5 === 0 ? 80_000_000 : 3_000_000,
      branches: i % 3 === 0 ? [] : repoReport(n).branches,
      reclaimableBytes: i % 3 === 0 ? 0 : 12_000_000 + i * 100_000,
      worktrees:
        i % 7 === 0
          ? [
              {
                repo: `/Volumes/workspaces/${n}`,
                path: `/Volumes/workspaces/${n}-wt/feature`,
                branch: "feat/feature",
                head: "0a1b2c3d4e5f",
                exists: true,
                size: 420_000_000,
                regenerable: 380_000_000,
                lastModified: daysAgo(60),
                modifiedFiles: i % 2,
                untrackedFiles: 0,
                unpushedCommits: 0,
                status: "stale",
                staleReason: null,
                branchStatus: "merged",
              },
            ]
          : [],
    }),
  );
  return {
    ...s,
    git: {
      ...s.git,
      running: true,
      reports: reports.slice(0, 64),
      progress: {
        done: 64,
        total: 79,
        running: {
          [reports[64]!.path]: 210_000_000,
          [reports[65]!.path]: 96_000_000,
          [reports[66]!.path]: 1_120_000_000,
          [reports[67]!.path]: 44_000_000,
        },
        failed: { [reports[12]!.path]: "timeout after 300 s" },
      },
      failed: { [reports[12]!.path]: "timeout after 300 s" },
      startedAt: FIXTURE_NOW.getTime() - 95_000,
      finishedAt: null,
    },
    hub: {
      ...s.hub,
      modules: s.hub.modules.map((m) =>
        m.module === "git"
          ? { ...m, figure: { kind: "gitCandidates", count: 103 }, detail: { kind: "gitReclaimable", bytes: 4.6 * GB } }
          : m,
      ),
    },
  };
}

function updateAvailable(): AppSnapshot {
  const s = normalSnapshot();
  return {
    ...s,
    updates: {
      ...s.updates,
      available: {
        version: "0.10.0",
        notes:
          "### Features\n- verify a destination before saving it\n- menu bar panel with the next backup\n\n### Bug Fixes\n- keep the last valid configuration while editing config.toml",
        pageURL: "https://github.com/Romakita/cairn/releases/tag/v0.10.0",
      },
    },
  };
}

function configInvalid(): AppSnapshot {
  const s = normalSnapshot();
  const issue = {
    severity: "error" as const,
    key: "schedule.time",
    line: 42,
    message: 'expected HH:MM, found "25:00"',
    description: 'Error line 42: schedule.time: expected HH:MM, found "25:00"',
  };
  return {
    ...s,
    config: { ...s.config, issues: [issue], hasErrors: true, usingLastValid: true },
    hub: {
      ...s.hub,
      overall: "error",
      causes: [{ kind: "configInvalid", subject: "", detail: issue.description }],
      topIssue: { kind: "configInvalid", subject: "", detail: issue.description },
    },
  };
}

/** Destination « disk » non chiffrée : identifiants IA ignorés même cochés ; inventaire des outils déjà chargé. */
function unencryptedDestination(): AppSnapshot {
  const s = normalSnapshot();
  const base = fixtureConfig();
  const destinations = base.destinations.map((d) => (d.id === "disk" ? { ...d, encrypted: false } : d));
  const ai = base.ai.map((a) => (a.id === "codex" ? { ...a, categories: [...a.categories, "credentials"] } : a));
  const config = { ...base, destinations, ai, excludedTools: ["cowsay"] };
  return {
    ...s,
    config: { ...s.config, config },
    destinations: destinations.map((d) => destinationView(d)),
    ai: {
      ...s.ai,
      tools: s.ai.tools.map((tool) => ({
        ...tool,
        categories: ai.find((a) => a.id === tool.id)?.categories ?? [],
      })),
      credentialsBlock: t("ai.credentials.ignored"),
    },
    inventory: { status: "loaded", inventory: sampleInventory(config.excludedTools), error: null },
  };
}

/** Mac neuf configuré avec le NAS de l'ancien Mac : rien encore sauvegardé d'ici, restauration à faire. */
function restoreScenario(): AppSnapshot {
  const s = normalSnapshot();
  const base = fixtureConfig();
  const config = { ...base, destinations: base.destinations.slice(0, 1) };
  return {
    ...s,
    config: { ...s.config, config },
    destinations: config.destinations.map((d) =>
      destinationView(d, {
        run: runState(),
        nextBackup: null,
        history: { status: "loaded", versions: [], error: null, loadedAt: FIXTURE_NOW.getTime() },
        unavailable: {
          simulate: null,
          verify: "backup.unavailable.nothing_to_verify",
          verifyFull: "backup.unavailable.nothing_to_verify",
          backup: null,
        },
      }),
    ),
    backup: { ...s.backup, startedAt: null, finishedAt: null, log: null },
    activity: [],
    backupDays: [null, null, null, null, null, null, null],
  };
}

/** Première sauvegarde vers une destination chiffrée neuve : le mot de passe de l'image est à noter, montré une fois. */
function backupNewImage(): AppSnapshot {
  const s = normalSnapshot();
  return {
    ...s,
    backup: {
      ...s.backup,
      newImagePasswords: [{ destination: "disk", password: "kV7q-3mXa-PL9w-Z2rT-8hNc" }],
    },
  };
}

/** Messages brefs du main (barre de messages) : succès, avertissement et erreur. */
function withMessages(): AppSnapshot {
  const s = normalSnapshot();
  const at = FIXTURE_NOW.getTime();
  return {
    ...s,
    messages: [
      { id: 1, level: "success", text: t("git.trashed", "/Volumes/workspaces/old-prototype"), date: at - 60_000 },
      { id: 2, level: "warning", text: t("onboarding.keychain_error", "errSecAuthFailed"), date: at - 30_000 },
      { id: 3, level: "error", text: t("cli.busy"), date: at },
    ],
  };
}

/**
 * Sans l'Accès complet au disque : bandeau sur l'accueil et l'écran Sauvegardes, problème de l'accueil, et dernière
 * sauvegarde vers le NAS réussie avec 21 éléments que macOS n'a pas laissé lire.
 */
function noFullDiskAccess(): AppSnapshot {
  const s = normalSnapshot();
  const home = "/Users/demo";
  const examples = [
    `${home}/Documents`,
    `${home}/Downloads`,
    `${home}/Desktop`,
    `${home}/Pictures/Photos Library.photoslibrary`,
    `${home}/.Trash`,
    `${home}/Library/Mail`,
    `${home}/Library/Messages`,
    `${home}/Library/Safari`,
    `${home}/Library/Preferences/com.apple.madrid.plist`,
    `${home}/Library/Containers/com.apple.Notes`,
  ];
  const log = "/Users/demo/.cairn/logs/backup-20261109-090000.log";
  const issue = { kind: "fullDiskAccess" as const, subject: "" };
  return {
    ...s,
    access: { fullDisk: "denied" },
    backup: {
      ...s.backup,
      startedAt: daysAgo(0, 1).getTime(),
      finishedAt: daysAgo(0, 1).getTime() + 412_000,
      log,
      lastResults: [
        {
          destination: "nas",
          error: null,
          waiting: false,
          stopped: false,
          damagedFiles: [],
          imageCheck: null,
          permissionDenied: { count: 21, examples },
          log,
          version: "2026-11-09T090000",
          filesTransferred: 1_958,
          bytesTransferred: 74_400_000,
          bytesByPart: {},
        },
      ],
    },
    hub: { ...s.hub, overall: "attention", causes: [issue], topIssue: issue },
  };
}

export const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
  empty: { id: "empty", description: "First launch: no config.toml, onboarding", build: empty },
  normal: { id: "normal", description: "Two destinations backed up yesterday, recent analysis", build: normalSnapshot },
  "backup-running": {
    id: "backup-running",
    description: "Backup to two destinations: counting, copy n/N, then finishing while the other copies",
    build: backupRunning,
    backupRunning: true,
  },
  "backup-failed": {
    id: "backup-failed",
    description: "Last backup failed on the NAS, the disk is unreachable for a day",
    build: backupFailed,
  },
  "analysis-running": {
    id: "analysis-running",
    description: "Disk analysis in progress",
    build: analysisRunning,
    analysisRunning: true,
  },
  "disk-critical": {
    id: "disk-critical",
    description: "Volume critically full, cleanup proposed",
    build: diskCritical,
  },
  "git-many-repos": {
    id: "git-many-repos",
    description: "Git analysis of 79 repositories, reports streaming in",
    build: gitManyRepos,
  },
  "update-available": { id: "update-available", description: "A new release is available", build: updateAvailable },
  "config-invalid": {
    id: "config-invalid",
    description: "config.toml has an error: last valid configuration kept, schedule blocked",
    build: configInvalid,
  },
  "unencrypted-destination": {
    id: "unencrypted-destination",
    description: "One destination is not encrypted: AI credentials are left out; CLI inventory already listed",
    build: unencryptedDestination,
  },
  restore: {
    id: "restore",
    description: "New Mac: restore from the NAS of the old Mac (image password asked, other architecture)",
    build: restoreScenario,
    newMac: true,
  },
  "backup-new-image": {
    id: "backup-new-image",
    description: "First backup to a new encrypted image: its password is shown once",
    build: backupNewImage,
  },
  "backup-simulated": {
    id: "backup-simulated",
    description: "Simulation to two destinations (use at=40 for the result: volume to copy by part)",
    build: () => {
      const s = backupRunning();
      return {
        ...s,
        backup: { ...s.backup, dryRun: true, destinations: s.backup.destinations.map((d) => ({ ...d, dryRun: true })) },
      };
    },
    backupRunning: true,
    backupDryRun: true,
  },
  "no-full-disk-access": {
    id: "no-full-disk-access",
    description: "No Full Disk Access: banner, home issue, last backup skipped 21 protected items",
    build: noFullDiskAccess,
  },
  messages: {
    id: "messages",
    description: "Short messages from the app: a repository moved to the Trash, a Keychain warning, an error",
    build: withMessages,
  },
};

export function isScenarioId(value: string | null | undefined): value is ScenarioId {
  return value !== null && value !== undefined && (SCENARIO_IDS as readonly string[]).includes(value);
}
