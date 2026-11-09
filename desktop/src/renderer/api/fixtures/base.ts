// Données d'exemple de l'API (design.md, décision 8) : un état « normal » complet et ses briques, sans aucun accès au
// disque. Les scénarios (scenarios.ts) partent de là. Seuls des TYPES viennent du core : rien de Node n'est importé.
import type { DestinationConfig } from "../../../core/config.ts";
import type { HubState, ModuleState } from "../../../core/hub-state.ts";
import type { Inventory, InventoryEntry, ToolSource } from "../../../core/inventory/types.ts";
import type {
  AppSnapshot,
  CairnConfig,
  DestinationRunState,
  DestinationView,
  NodeView,
  RepoReport,
  StorageAlert,
} from "../../../shared/contract.ts";

/** Horloge figée des captures : lundi 9 novembre 2026, 10:00 (heure locale). */
export const FIXTURE_NOW = new Date(2026, 10, 9, 10, 0, 0);
const DAY = 86_400_000;
const GB = 1_000_000_000;

export function daysAgo(days: number, hours = 0): Date {
  return new Date(FIXTURE_NOW.getTime() - days * DAY - hours * 3_600_000);
}

export function fixtureConfig(): CairnConfig {
  return {
    version: 1,
    language: "auto",
    analysis: { bigFileThresholdMB: 50, bigFolderThresholdGB: 1 },
    folders: [
      { path: "/Volumes/workspaces", backup: true, exclude: ["*.iso"] },
      { path: "~/Documents", backup: true, exclude: [] },
    ],
    home: { include: [".zshrc", ".gitconfig", ".ssh", ".config/mise"], exclude: [] },
    ai: [
      { id: "claude-code", categories: ["conversations", "config", "memories"] },
      { id: "codex", categories: ["conversations", "config"] },
    ],
    destinations: [
      {
        id: "nas",
        provider: "smb",
        url: "smb://nas.local/backups",
        username: "romain",
        encrypted: true,
        retention: { mode: "tiered", days: 30, weeks: 48 },
      },
      {
        id: "disk",
        provider: "local",
        path: "/Volumes/Archive/cairn",
        encrypted: true,
        retention: { mode: "count", count: 12 },
      },
    ],
    schedule: { frequency: "daily", time: "12:30", weekday: "monday", background: true, onBatteryMinPercent: 20 },
    alerts: { lowPercent: 10, lowGB: 20, criticalPercent: 5, criticalGB: 5 },
    logRetentionDays: 90,
    checkUpdates: true,
    git: { fetchBefore: false, gc: true, worktreeStaleDays: 30 },
    excludedTools: [],
  };
}

export function runState(values: Partial<DestinationRunState> = {}): DestinationRunState {
  return { damagedVersions: [], lastBytesTransferred: 0, lastDuration: 0, ...values };
}

function label(d: DestinationConfig): string {
  if (d.provider === "smb") return d.url ? new URL(d.url.replace(/^smb:/, "http:")).host : d.id;
  return d.path?.split("/").filter(Boolean).at(-1) ?? d.id;
}

export function destinationView(d: DestinationConfig, values: Partial<DestinationView> = {}): DestinationView {
  return {
    id: d.id,
    label: label(d),
    provider: d.provider,
    config: d,
    health: "ok",
    reachable: true,
    waiting: false,
    run: runState({
      lastSuccess: daysAgo(0, 21),
      lastAttempt: daysAgo(0, 21),
      lastBytesTransferred: 1_840_000_000,
      lastDuration: 412,
    }),
    nextBackup: new Date(FIXTURE_NOW.getFullYear(), FIXTURE_NOW.getMonth(), FIXTURE_NOW.getDate(), 12, 30).getTime(),
    history: {
      status: "loaded",
      versions: Array.from({ length: 6 }, (_, i) => {
        const date = daysAgo(i, 21);
        const pad = (n: number) => String(n).padStart(2, "0");
        const name = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T123000`;
        return { name, date: date.getTime(), partial: false, damaged: false };
      }),
      error: null,
      loadedAt: FIXTURE_NOW.getTime(),
    },
    unavailable: { simulate: null, verify: null, verifyFull: null, backup: null },
    ...values,
  };
}

export function node(
  id: number,
  name: string,
  nodePath: string,
  size: number,
  values: Partial<NodeView> = {},
): NodeView {
  const breakdown = [0, 0, 0, 0, 0, 0, 0, 0];
  breakdown[values.category ? categoryIndex(values.category) : 0] = size;
  return {
    id,
    name,
    path: nodePath,
    isDirectory: true,
    category: "source",
    size,
    fileCount: Math.round(size / 40_000),
    breakdown,
    childCount: 0,
    isGitRepo: false,
    regenerable: false,
    ...values,
  };
}

function categoryIndex(c: NodeView["category"]): number {
  return ["source", "git", "deps", "build", "ios", "python", "cache", "trash"].indexOf(c);
}

/** Dossiers régénérables de l'écran Nettoyable (identifiants 100 et suivants). */
export function regenerableNodes(): NodeView[] {
  const items: [string, NodeView["category"], number][] = [
    ["cairn/desktop/node_modules", "deps", 1.84 * GB],
    ["website/node_modules", "deps", 1.21 * GB],
    ["ios-app/DerivedData", "ios", 3.2 * GB],
    ["cairn/Cairn/.build", "build", 2.4 * GB],
    ["ml-notebooks/.venv", "python", 0.96 * GB],
    ["website/.next", "build", 0.42 * GB],
    ["api/target", "build", 0.88 * GB],
  ];
  return items
    .map(([rel, category, size], i) =>
      node(100 + i, rel.split("/").at(-1)!, `/Volumes/workspaces/${rel}`, Math.round(size), {
        category,
        regenerable: true,
        childCount: 12,
      }),
    )
    .sort((a, b) => b.size - a.size);
}

export function repoReport(name: string, values: Partial<RepoReport> = {}): RepoReport {
  const repo = `/Volumes/workspaces/${name}`;
  return {
    path: repo,
    gitBytes: 180_000_000,
    looseBytes: 12_000_000,
    mainRef: "origin/main",
    branches: [
      {
        repo,
        name: "feat/old-experiment",
        status: "merged",
        sha: "a1b2c3d",
        date: "2026-08-14",
        subject: "feat: try a new layout",
        checkedOutInWorktree: null,
      },
      {
        repo,
        name: "fix/typo",
        status: "squash",
        sha: "d4e5f6a",
        date: "2026-09-02",
        subject: "fix: typo in README",
        checkedOutInWorktree: null,
      },
    ],
    worktrees: [],
    reclaimableBytes: 24_000_000,
    lastModified: daysAgo(3),
    modifiedFiles: 0,
    unpushedCommits: 0,
    ...values,
  };
}

/** Projets de l'état normal (écran Analyse), du plus gros au plus petit. */
export function sampleProjects(): AppSnapshot["analysis"]["projects"] {
  const project = (name: string, size: number, source: number, git: number, isGitRepo = true) => ({
    path: `/Volumes/workspaces/${name}`,
    name,
    isGitRepo,
    size: size * GB,
    source: source * GB,
    git: git * GB,
    regenerable: (size - source - git) * GB,
    worktrees: [] as { path: string; size: number; repoPath: string }[],
  });
  const cairn = project("cairn", 6.1, 0.4, 0.41);
  cairn.worktrees = [
    { path: "/Volumes/workspaces/cairn-worktrees/menu-bar", size: 1.24 * GB, repoPath: "/Volumes/workspaces/cairn" },
  ];
  return [
    cairn,
    project("ios-app", 5.4, 1.1, 0.62),
    project("website", 3.3, 0.6, 0.27),
    project("ml-notebooks", 2.1, 0.9, 0.08),
    project("api", 1.4, 0.3, 0.09),
    project("design-assets", 0.9, 0.9, 0, false),
  ];
}

/** Gros fichiers et dossiers en plus des deux de base (`nodeId` nul : nœud hors de l'arbre d'exemple). */
function sampleBigObjects(): AppSnapshot["analysis"]["bigObjects"] {
  const docs = "/Users/demo/Documents";
  const ws = "/Volumes/workspaces";
  return [
    { kind: "file", path: `${docs}/Videos/talk-2026.mov`, size: 2.8 * GB, category: "source", nodeId: null },
    { kind: "folder", path: `${ws}/cairn/Cairn/.build`, size: 2.4 * GB, category: "build", nodeId: 103 },
    { kind: "file", path: `${ws}/ml-notebooks/data/train.parquet`, size: 1.6 * GB, category: "source", nodeId: null },
    { kind: "folder", path: `${ws}/cairn/desktop/node_modules`, size: 1.84 * GB, category: "deps", nodeId: 100 },
    { kind: "file", path: `${docs}/Archives/photos-2019.zip`, size: 0.74 * GB, category: "source", nodeId: null },
  ];
}

/**
 * Dépôts de l'état normal (écran Git) : branches fusionnées, une branche non fusionnée, une branche extraite dans un
 * worktree à risque, un worktree orphelin, un dépôt avec des commits non poussés, un vieux dépôt.
 */
export function sampleRepos(): RepoReport[] {
  const root = "/Volumes/workspaces";
  const cairn = repoReport("cairn", {
    gitBytes: 412_000_000,
    looseBytes: 96_000_000,
    reclaimableBytes: 61_000_000,
    branches: [
      ...repoReport("cairn").branches,
      {
        repo: `${root}/cairn`,
        name: "spike/sqlite-snapshots",
        status: "unmerged",
        sha: "9f8e7d6",
        date: "2026-06-21",
        subject: "wip: snapshot every database",
        checkedOutInWorktree: null,
      },
      {
        repo: `${root}/cairn`,
        name: "feat/menu-bar",
        status: "merged",
        sha: "5c4b3a2",
        date: "2026-10-02",
        subject: "feat: menu bar panel",
        checkedOutInWorktree: `${root}/cairn-worktrees/menu-bar`,
      },
    ],
    worktrees: [
      {
        repo: `${root}/cairn`,
        path: `${root}/cairn-worktrees/menu-bar`,
        branch: "feat/menu-bar",
        head: "5c4b3a2e1f00",
        exists: true,
        size: 1_240_000_000,
        regenerable: 1_100_000_000,
        lastModified: daysAgo(38),
        modifiedFiles: 3,
        untrackedFiles: 1,
        unpushedCommits: 0,
        status: "risk",
        staleReason: "merged",
        branchStatus: "merged",
      },
      {
        repo: `${root}/cairn`,
        path: `${root}/cairn-worktrees/old-release`,
        branch: null,
        head: "77aa88bb99cc",
        exists: false,
        size: 0,
        regenerable: 0,
        lastModified: null,
        modifiedFiles: 0,
        untrackedFiles: 0,
        unpushedCommits: 0,
        status: "orphan",
        staleReason: null,
        branchStatus: null,
      },
      {
        repo: `${root}/cairn`,
        path: `${root}/cairn-worktrees/docs`,
        branch: "docs/readme",
        head: "1234abcd5678",
        exists: true,
        size: 86_000_000,
        regenerable: 0,
        lastModified: daysAgo(1),
        modifiedFiles: 0,
        untrackedFiles: 0,
        unpushedCommits: 2,
        status: "active",
        staleReason: null,
        branchStatus: "unmerged",
      },
    ],
    lastModified: daysAgo(0, 2),
  });
  const website = repoReport("website", { gitBytes: 268_000_000, lastModified: daysAgo(12) });
  const api = repoReport("api", {
    gitBytes: 94_000_000,
    looseBytes: 2_000_000,
    branches: [],
    reclaimableBytes: 0,
    modifiedFiles: 4,
    unpushedCommits: 3,
    lastModified: daysAgo(6),
  });
  const prototype = repoReport("old-prototype", {
    gitBytes: 38_000_000,
    looseBytes: 31_000_000,
    branches: [],
    reclaimableBytes: 0,
    lastModified: daysAgo(540),
  });
  return [cairn, website, api, prototype];
}

/** Inventaire des outils de ligne de commande (écran Outils CLI) ; `excluded` : `config.excludedTools`. */
export function sampleInventory(excluded: readonly string[] = []): Inventory {
  const entry = (
    name: string,
    source: ToolSource | null,
    version: string,
    status: InventoryEntry["status"],
    reasons: InventoryEntry["reasons"],
  ): InventoryEntry => ({
    name,
    tool: source ? { name, source, version, commands: [name], details: {} } : null,
    status,
    reasons,
    excluded: excluded.includes(name),
  });
  return {
    taps: ["oven-sh/bun"],
    entries: [
      entry("ripgrep", "brew", "14.1.1", "used", [{ code: "history", uses: 212 }]),
      entry("node", "mise", "22.12.0", "used", [{ code: "project", file: "package.json" }]),
      entry("just", "brew", "1.40.0", "used", [
        { code: "project", file: "justfile" },
        { code: "history", uses: 96 },
      ]),
      entry("gh", "brew", "2.62.0", "used", [{ code: "home", file: ".config/gh" }]),
      entry("bun", "brew", "1.3.2", "used", [{ code: "history", uses: 431 }]),
      entry("@biomejs/biome", "npm", "2.6.6", "used", [{ code: "project", file: "biome.json" }]),
      entry("ruff", "uv", "0.8.4", "unused", []),
      entry("cowsay", "brew", "3.04", "unused", []),
      entry("httpie", "pipx", "3.2.4", "unused", []),
      entry("kubectl", null, "", "missing", [{ code: "home", file: ".kube" }]),
      entry("terraform", null, "", "missing", [{ code: "project", file: "main.tf" }]),
    ],
  };
}

function module(m: ModuleState["module"], values: Omit<ModuleState, "module">): ModuleState {
  return { module: m, ...values };
}

export function normalHub(): HubState {
  return {
    overall: "ok",
    causes: [],
    topIssue: null,
    modules: [
      module("storage", {
        tone: "ok",
        figure: { kind: "free", bytes: 412 * GB },
        detail: { kind: "reclaimable", bytes: 10.9 * GB },
        action: "clean",
      }),
      module("backup", {
        tone: "ok",
        figure: { kind: "lastBackup", date: daysAgo(0, 21) },
        detail: { kind: "nextBackup", date: new Date(2026, 10, 9, 12, 30) },
        action: "backupNow",
      }),
      module("git", {
        tone: "info",
        figure: { kind: "gitCandidates", count: 6 },
        detail: { kind: "gitReclaimable", bytes: 0.31 * GB },
        action: "openGit",
      }),
      module("ai", {
        tone: "ok",
        figure: { kind: "aiTools", count: 2 },
        detail: { kind: "aiLastBackup", date: daysAgo(0, 21) },
        action: "viewAI",
      }),
      module("restore", {
        tone: "ok",
        figure: { kind: "versions", count: 12 },
        detail: { kind: "none" },
        action: "restore",
      }),
    ],
  };
}

export function diskAlert(level: 1 | 2, available: number, percentFree: number): StorageAlert {
  return { volume: "workspaces", level, available, percentFree, daysToFull: level === 2 ? 3 : 9 };
}

/** État « normal » : configuration valide, deux destinations sauvegardées hier, analyse et git récents. */
export function normalSnapshot(): AppSnapshot {
  const config = fixtureConfig();
  const regenerable = regenerableNodes();
  return {
    revision: 1,
    contract: 1,
    version: "0.9.0",
    language: "fr-FR",
    packaged: true,
    firstLaunch: false,
    config: {
      file: "/Users/demo/.cairn/config.toml",
      exists: true,
      config,
      issues: [],
      hasErrors: false,
      usingLastValid: false,
    },
    destinations: config.destinations.map((d) => destinationView(d)),
    backup: {
      running: false,
      dryRun: false,
      startedAt: daysAgo(0, 21).getTime(),
      finishedAt: daysAgo(0, 21).getTime() + 412_000,
      destinations: [],
      stopping: [],
      log: "/Users/demo/.cairn/logs/backup-20261108-123000.log",
      lastResults: null,
      lastError: null,
      newImagePasswords: [],
    },
    verification: null,
    analysis: {
      running: false,
      progress: null,
      startedAt: daysAgo(1).getTime(),
      finishedAt: daysAgo(1).getTime() + 48_000,
      folders: [
        {
          folder: "/Volumes/workspaces",
          available: true,
          root: node(1, "workspaces", "/Volumes/workspaces", 212 * GB, {
            childCount: 42,
            // Octets par catégorie (ordre de `CATEGORIES`) : sources, .git, dépendances, builds, iOS, Python, caches.
            breakdown: [184.6, 6.2, 3.05, 3.7, 3.2, 0.96, 10.29, 0].map((g) => Math.round(g * GB)),
          }),
          errors: 0,
          duration: 41.2,
        },
        {
          folder: "/Users/demo/Documents",
          available: true,
          root: node(2, "Documents", "/Users/demo/Documents", 38 * GB, {
            childCount: 18,
            breakdown: [37.2, 0, 0, 0, 0, 0, 0, 0.8].map((g) => Math.round(g * GB)),
          }),
          errors: 2,
          duration: 6.8,
        },
      ],
      bigObjects: [
        { kind: "file", path: "/Volumes/workspaces/vm/ubuntu.iso", size: 5.6 * GB, category: "source", nodeId: 30 },
        {
          kind: "folder",
          path: "/Volumes/workspaces/ios-app/DerivedData",
          size: 3.2 * GB,
          category: "ios",
          nodeId: 102,
        },
        ...sampleBigObjects(),
      ],
      projects: sampleProjects(),
      regenerable,
      preselection: regenerable.slice(0, 4).map((n) => n.id),
      summary: {
        date: daysAgo(1),
        totalBytes: 250 * GB,
        reclaimableByType: { deps: 3.05 * GB, build: 3.7 * GB, ios: 3.2 * GB, python: 0.96 * GB, cache: 0 },
        obsoleteWorktreeBytes: 0,
        trashBytes: 0,
      },
      stale: false,
      error: null,
    },
    storage: { alerts: [], freeBytes: 412 * GB, lastCheck: FIXTURE_NOW.getTime() },
    git: {
      running: false,
      progress: null,
      reports: sampleRepos(),
      failed: {},
      options: {
        fetch: false,
        includeUnmerged: false,
        pruneNow: false,
        gc: true,
        staleDays: 30,
        only: null,
        worktreesOnly: false,
        includeAtRisk: false,
      },
      startedAt: daysAgo(1).getTime(),
      finishedAt: daysAgo(1).getTime() + 12_000,
      applying: false,
      lastCleanup: null,
      error: null,
    },
    inventory: { status: "idle", inventory: null, error: null },
    ai: {
      status: "loaded",
      tools: [
        {
          id: "claude-code",
          name: "Claude Code",
          detected: true,
          bytesByCategory: { conversations: 820_000_000, config: 2_000_000, memories: 400_000, credentials: 3_000 },
          totalBytes: 822_400_000,
          conversations: 1432,
          latestConversation: daysAgo(0, 1).getTime(),
          lastBackup: daysAgo(0, 21).getTime(),
          categories: ["conversations", "config", "memories"],
        },
        {
          id: "codex",
          name: "Codex",
          detected: true,
          bytesByCategory: { conversations: 120_000_000, config: 500_000, memories: 0, credentials: 2_000 },
          totalBytes: 120_500_000,
          conversations: 210,
          latestConversation: daysAgo(2).getTime(),
          lastBackup: daysAgo(0, 21).getTime(),
          categories: ["conversations", "config"],
        },
        {
          id: "claude-desktop",
          name: "Claude Desktop",
          detected: false,
          bytesByCategory: { conversations: 0, config: 0, memories: 0, credentials: 0 },
          totalBytes: 0,
          conversations: 0,
          latestConversation: null,
          lastBackup: null,
          categories: [],
        },
      ],
      credentialsBlock: null,
      error: null,
    },
    hub: normalHub(),
    backupDays: [true, true, null, true, true, true, true],
    activity: [
      { kind: "backupSucceeded", date: daysAgo(0, 21).getTime(), subject: "nas", bytes: 1_840_000_000 },
      { kind: "backupSucceeded", date: daysAgo(0, 21).getTime(), subject: "disk", bytes: 1_840_000_000 },
      { kind: "cleanup", date: daysAgo(1).getTime(), count: 3, bytes: 4.1 * GB },
      { kind: "gitCleanup", date: daysAgo(4).getTime(), count: 5 },
    ],
    updates: {
      current: "0.9.0",
      available: null,
      phase: "idle",
      error: null,
      blocker: null,
      installable: true,
      lastCheck: FIXTURE_NOW.getTime(),
      message: null,
    },
    lock: { held: false, byOther: false, holder: null },
    restore: { available: true, running: false, plan: null, progress: null, ok: null, error: null },
    background: { enabled: true, status: "enabled" },
    notificationsSupported: true,
    messages: [],
  };
}

export { GB };
