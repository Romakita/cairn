// API d'exemple : implémente `CairnApi` en mémoire, sans disque ni réseau, pour `bun run dev:web`, les captures et
// la galerie. L'état part d'un scénario (`?scenario=<id>`) ; la sauvegarde et l'analyse simulées avancent dans le
// temps (`?t=<secondes>` démarre plus loin, `?frozen=1` arrête l'horloge : captures reproductibles).

import type { AppLanguage } from "../../../core/l10n.ts";
import { setLanguage, t } from "../../../core/l10n.ts";
import { applyPatches } from "../../../shared/config-patch.ts";
import {
  type AppSnapshot,
  type CairnApi,
  CairnApiError,
  type MethodName,
  type NavigationRequest,
  type NodeView,
  type RestorePlanView,
  type Retention,
} from "../../../shared/contract.ts";
import { simulatedProgress, simulationFinished } from "./backup-simulation.ts";
import { destinationView, FIXTURE_NOW, GB, node, sampleInventory } from "./base.ts";

/** Volume par partie d'une sauvegarde simulée (`bytesByPart`). */
const SIMULATED_PARTS: Record<string, number> = {
  "folders/workspaces": 61_200_000,
  "folders/Projects": 8_400_000,
  home: 3_100_000,
  "ai/claude-code/conversations": 1_300_000,
  "ai/codex/conversations": 380_000,
  tools: 20_000,
};

import { fixturePlan, RESTORE_SECONDS, restoreProgressAt } from "./restore.ts";
import { SCENARIOS, type ScenarioId } from "./scenarios.ts";

export interface FixtureOptions {
  scenario: ScenarioId;
  language?: AppLanguage;
  /** Secondes déjà écoulées dans les simulations au démarrage. */
  startAt?: number;
  /** Horloge arrêtée : l'état ne bouge plus (captures). */
  frozen?: boolean;
  /** Intervalle de mise à jour des simulations (ms). */
  tickMs?: number;
}

const ANALYSIS_SECONDS = 8;
const GIT_SECONDS = 4;

/** API d'exemple : `calls` garde la trace des appels (tests de l'interface). */
export interface FixtureApi extends CairnApi {
  readonly calls: { method: MethodName; args: unknown }[];
  /** Avance l'horloge des simulations (tests). */
  advance(seconds: number): void;
  /** Arrête les minuteries. */
  dispose(): void;
}

export function createFixtureApi(options: FixtureOptions): FixtureApi {
  const language = options.language ?? "en-US";
  setLanguage(language);
  const scenario = SCENARIOS[options.scenario];
  let state: AppSnapshot = { ...scenario.build(), language };
  let clock = options.startAt ?? 0;
  let backupStart: number | null = scenario.backupRunning ? 0 : null;
  let backupDryRun = scenario.backupDryRun ?? false;
  let backupTargets: string[] | null = null;
  /** Carte Sauvegarde de l'accueil avant le lancement (rendue telle quelle après une simulation). */
  let backupFigure: AppSnapshot["hub"]["modules"][number]["figure"] | null = null;
  let tokens = 0;
  let analysisStart: number | null = scenario.analysisRunning ? 0 : null;
  let gitStart: number | null = null;
  let restoreStart: number | null = null;
  let restorePlan: RestorePlanView | null = null;
  let volumeCreated = false;
  const restorePlans = new Map<string, RestorePlanView>();
  const retentionPlans = new Map<string, { destination: string; retention: Retention }>();
  const stopped = new Set<string>();
  const listeners = new Set<(s: AppSnapshot) => void>();
  const navigators = new Set<(n: NavigationRequest) => void>();
  const calls: { method: MethodName; args: unknown }[] = [];

  const publish = () => {
    state = { ...state, revision: state.revision + 1, updates: { ...state.updates, blocker: blocker() } };
    for (const l of listeners) l(state);
  };

  const blocker = () => (state.backup.running ? t("update.blocked.backup") : null);

  // MARK: Simulations

  function stepBackup(): void {
    if (backupStart === null) return;
    const elapsed = clock - backupStart;
    const progress = simulatedProgress(elapsed, backupDryRun)
      .filter((p) => backupTargets === null || backupTargets.includes(p.destination))
      .map((p) =>
        stopped.has(p.destination) && !p.result
          ? {
              ...p,
              phase: "stopped" as const,
              result: {
                status: "stopped" as const,
                version: null,
                error: null,
                warnings: [],
                filesTransferred: 0,
                bytesTransferred: 0,
                deletedVersions: [],
                damagedFiles: [],
                imageCheck: null,
                log: state.backup.log,
              },
            }
          : p,
      );
    const finished = simulationFinished(elapsed) || progress.every((p) => p.result !== null);
    state = {
      ...state,
      backup: {
        ...state.backup,
        running: !finished,
        destinations: progress,
        finishedAt: finished ? FIXTURE_NOW.getTime() + elapsed * 1000 : null,
        stopping: [...stopped].filter((id) => !finished && progress.some((p) => p.destination === id)),
      },
      lock: finished
        ? { held: false, byOther: false, holder: null }
        : { held: true, byOther: false, holder: "4242 backup" },
    };
    if (finished) {
      backupStart = null;
      stopped.clear();
      const previous = backupFigure;
      backupFigure = null;
      state = {
        ...state,
        backup: {
          ...state.backup,
          // Résultats de la dernière exécution, avec le volume par partie (à copier, en simulation).
          lastResults: progress.map((p) => ({
            destination: p.destination,
            error: p.result?.error ?? null,
            waiting: false,
            stopped: p.result?.status === "stopped",
            damagedFiles: [],
            imageCheck: null,
            log: p.result?.log ?? null,
            version: p.result?.version ?? null,
            filesTransferred: p.result?.filesTransferred ?? 0,
            bytesTransferred: p.result?.bytesTransferred ?? 0,
            bytesByPart: p.result?.status === "succeeded" ? SIMULATED_PARTS : {},
          })),
        },
        destinations: state.destinations.map((d) => ({
          ...d,
          unavailable: { simulate: null, verify: null, verifyFull: null, backup: null },
          run:
            backupDryRun || !progress.some((p) => p.destination === d.id && p.result?.status === "succeeded")
              ? d.run
              : { ...d.run, lastSuccess: FIXTURE_NOW, lastAttempt: FIXTURE_NOW },
        })),
        hub: {
          ...state.hub,
          modules: state.hub.modules.map((m) =>
            m.module === "backup" && m.figure.kind === "backingUp"
              ? {
                  ...m,
                  figure: backupDryRun && previous ? previous : { kind: "lastBackup" as const, date: FIXTURE_NOW },
                }
              : m,
          ),
        },
      };
    }
  }

  function stepAnalysis(): void {
    if (analysisStart === null) return;
    const elapsed = clock - analysisStart;
    if (elapsed >= ANALYSIS_SECONDS) {
      analysisStart = null;
      state = {
        ...state,
        analysis: {
          ...state.analysis,
          running: false,
          progress: null,
          finishedAt: FIXTURE_NOW.getTime() + elapsed * 1000,
          summary: state.analysis.summary ? { ...state.analysis.summary, date: FIXTURE_NOW } : null,
          stale: false,
        },
      };
      return;
    }
    const f = elapsed / ANALYSIS_SECONDS;
    state = {
      ...state,
      analysis: {
        ...state.analysis,
        running: true,
        progress: {
          files: Math.round(f * 612_000),
          bytes: Math.round(f * 248 * GB),
          current: `/Volumes/workspaces/project-${Math.round(f * 40)}/node_modules/.pnpm`,
          errors: f > 0.6 ? 2 : 0,
        },
      },
    };
  }

  function stepGit(): void {
    if (gitStart === null) return;
    const elapsed = clock - gitStart;
    if (elapsed >= GIT_SECONDS) {
      gitStart = null;
      state = { ...state, git: { ...state.git, running: false, progress: null, finishedAt: Date.now() } };
      return;
    }
    const total = state.git.reports.length || 3;
    state = {
      ...state,
      git: {
        ...state.git,
        running: true,
        progress: { done: Math.floor((elapsed / GIT_SECONDS) * total), total, running: {}, failed: {} },
      },
    };
  }

  function stepRestore(): void {
    if (restoreStart === null || !restorePlan) return;
    const elapsed = clock - restoreStart;
    const progress = restoreProgressAt(restorePlan, elapsed, t);
    const finished = elapsed >= RESTORE_SECONDS;
    if (finished) restoreStart = null;
    state = {
      ...state,
      restore: {
        ...state.restore,
        running: !finished,
        progress,
        ok: finished ? progress.steps.every((x) => x.ok || x.manual !== undefined) : null,
      },
      lock: finished
        ? { held: false, byOther: false, holder: null }
        : { held: true, byOther: false, holder: "4242 restore" },
    };
  }

  function step(): void {
    stepRestore();
    stepBackup();
    stepAnalysis();
    stepGit();
    // « Tout vérifier » fini quand l'analyse et git le sont (comme `checkAll` du main).
    if (state.hub.checking && analysisStart === null && gitStart === null) {
      state = { ...state, hub: { ...state.hub, checking: false, lastCheck: Date.now() } };
    }
  }

  step();
  const tickMs = options.tickMs ?? 250;
  const timer = options.frozen
    ? null
    : setInterval(() => {
        if (backupStart === null && analysisStart === null && gitStart === null && restoreStart === null) return;
        clock += tickMs / 1000;
        step();
        publish();
      }, tickMs);

  const record = (method: MethodName, args?: unknown) => {
    calls.push({ method, args });
  };

  const update = (change: (s: AppSnapshot) => AppSnapshot) => {
    state = change(state);
    publish();
  };

  const children = (id: number): NodeView[] => {
    const parent = [
      ...state.analysis.folders.flatMap((f) => (f.root ? [f.root] : [])),
      ...state.analysis.regenerable,
    ].find((n) => n.id === id);
    const base = parent?.path ?? `/Volumes/workspaces/node-${id}`;
    const size = parent?.size ?? GB;
    return ["src", "node_modules", "docs", ".git", "build", "assets"].map((name, i) =>
      node(id * 10 + i, name, `${base}/${name}`, Math.round(size / (i + 2)), {
        category: (["source", "deps", "source", "git", "build", "source"] as const)[i]!,
        regenerable: name === "node_modules" || name === "build",
        childCount: i === 3 ? 0 : 4,
      }),
    );
  };

  const api: FixtureApi = {
    calls,
    advance(seconds: number) {
      clock += seconds;
      step();
      publish();
    },
    dispose() {
      if (timer) clearInterval(timer);
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    onNavigate(listener) {
      navigators.add(listener);
      return () => {
        navigators.delete(listener);
      };
    },

    async getSnapshot() {
      record("getSnapshot");
      return state;
    },

    async startBackup(args) {
      record("startBackup", args);
      if (state.backup.running) throw new CairnApiError("busy", t("update.blocked.backup"));
      if (state.config.hasErrors) throw new CairnApiError("invalidConfig", state.config.issues[0]?.description ?? "");
      if (state.destinations.length === 0) throw new CairnApiError("notFound", "no destination");
      backupStart = clock;
      backupDryRun = args.dryRun ?? false;
      backupTargets = args.destinations ?? null;
      stopped.clear();
      backupFigure = state.hub.modules.find((m) => m.module === "backup")?.figure ?? null;
      state = {
        ...state,
        backup: { ...state.backup, dryRun: backupDryRun, startedAt: Date.now(), lastError: null, lastResults: null },
        // Carte Sauvegarde de l'accueil « en cours », comme le main (`isBackingUp`).
        hub: {
          ...state.hub,
          modules: state.hub.modules.map((m) =>
            m.module === "backup" ? { ...m, figure: { kind: "backingUp" as const } } : m,
          ),
        },
      };
      step();
      publish();
    },
    async stopBackup(args) {
      record("stopBackup", args);
      if (!state.backup.running) return;
      for (const p of state.backup.destinations)
        if (!args.destination || p.destination === args.destination) stopped.add(p.destination);
      step();
      publish();
    },
    async acknowledgeImagePassword(args) {
      record("acknowledgeImagePassword", args);
      update((s) => ({
        ...s,
        backup: {
          ...s.backup,
          newImagePasswords: s.backup.newImagePasswords.filter((p) => p.destination !== args.destination),
        },
      }));
    },
    async verify(args) {
      record("verify", args);
      update((s) => ({
        ...s,
        verification: {
          destination: args.destination,
          full: args.full ?? false,
          running: false,
          version: s.destinations.find((d) => d.id === args.destination)?.history.versions[0]?.name ?? null,
          done: 4_210,
          total: 4_210,
          reports: [{ version: "2026-11-08T123000", damaged: 0, missingChecksums: false }],
          error: null,
        },
      }));
    },
    async refreshHistory(args) {
      record("refreshHistory", args);
    },

    async scan(args) {
      record("scan", args);
      if (state.analysis.running) throw new CairnApiError("busy", t("hub.checking"));
      analysisStart = clock;
      state = { ...state, analysis: { ...state.analysis, startedAt: Date.now() } };
      step();
      publish();
    },
    async cancelScan() {
      record("cancelScan");
      analysisStart = null;
      update((s) => ({ ...s, analysis: { ...s.analysis, running: false, progress: null } }));
    },
    async analysisChildren(args) {
      record("analysisChildren", args);
      return children(args.nodeId);
    },
    async removeNodes(args) {
      record("removeNodes", args);
      const gone = state.analysis.regenerable.filter((n) => args.nodeIds.includes(n.id));
      const freed = gone.reduce((n, x) => n + x.size, 0);
      update((s) => ({
        ...s,
        analysis: {
          ...s.analysis,
          regenerable: s.analysis.regenerable.filter((n) => !args.nodeIds.includes(n.id)),
          preselection: s.analysis.preselection.filter((id) => !args.nodeIds.includes(id)),
        },
        activity: [{ kind: "cleanup", date: Date.now(), count: gone.length, bytes: freed }, ...s.activity],
      }));
      return { cancelled: false, removed: gone.length, freed, failures: [] };
    },
    async checkStorage() {
      record("checkStorage");
    },
    async snoozeAlert(args) {
      record("snoozeAlert", args);
      update((s) => ({
        ...s,
        storage: { ...s.storage, alerts: s.storage.alerts.filter((a) => a.volume !== args.volume) },
      }));
    },
    async checkAll() {
      record("checkAll");
      if (state.hub.checking) throw new CairnApiError("busy", t("hub.checking"));
      if (!state.analysis.running) {
        analysisStart = clock;
        gitStart = clock;
        state = { ...state, hub: { ...state.hub, checking: true } };
        step();
        publish();
      }
    },
    async cancelCheckAll() {
      record("cancelCheckAll");
      analysisStart = null;
      gitStart = null;
      update((s) => ({
        ...s,
        hub: { ...s.hub, checking: false },
        analysis: { ...s.analysis, running: false, progress: null },
        git: { ...s.git, running: false, progress: null },
      }));
    },

    async gitAnalyze(args) {
      record("gitAnalyze", args);
      gitStart = clock;
      step();
      publish();
    },
    async gitCancel() {
      record("gitCancel");
      gitStart = null;
      update((s) => ({ ...s, git: { ...s.git, running: false, progress: null } }));
    },
    async gitApply(args) {
      record("gitApply", args);
      const deletedBranches = args.selections.flatMap((x) => x.branches);
      const removedWorktrees = args.selections.flatMap((x) => x.worktrees);
      update((s) => ({
        ...s,
        git: {
          ...s.git,
          reports: s.git.reports.map((r) => {
            const sel = args.selections.find((x) => x.repo === r.path);
            if (!sel) return r;
            return {
              ...r,
              branches: r.branches.filter((b) => !sel.branches.includes(b.name)),
              worktrees: r.worktrees.filter((w) => !sel.worktrees.includes(w.path)),
            };
          }),
        },
      }));
      return {
        cancelled: false,
        value: {
          deletedBranches,
          removedWorktrees,
          failures: [],
          cleanedRepos: args.selections.map((x) => x.repo),
        },
      };
    },
    async gitCompact(args) {
      record("gitCompact", args);
      const report = state.git.reports.find((r) => r.path === args.repo);
      const before = report?.gitBytes ?? 0;
      const after = Math.round(before * (args.pruneNow ? 0.55 : 0.7));
      update((s) => ({
        ...s,
        git: {
          ...s.git,
          reports: s.git.reports.map((r) => (r.path === args.repo ? { ...r, gitBytes: after, looseBytes: 0 } : r)),
        },
      }));
      return { cancelled: false, value: { repo: args.repo, before, after } };
    },
    async gitTrashRepo(args) {
      record("gitTrashRepo", args);
      update((s) => ({ ...s, git: { ...s.git, reports: s.git.reports.filter((r) => r.path !== args.repo) } }));
      return { cancelled: false };
    },

    async toolsRefresh() {
      record("toolsRefresh");
      // Recensement simulé : « en cours » un instant (figé avec `frozen`, pour les captures), puis chargé.
      update((s) => ({ ...s, inventory: { ...s.inventory, status: "loading", error: null } }));
      if (options.frozen) return;
      setTimeout(() => {
        update((s) => ({
          ...s,
          inventory: { status: "loaded", error: null, inventory: sampleInventory(s.config.config.excludedTools) },
        }));
      }, 300);
    },
    async toolsExport(args) {
      record("toolsExport", args);
      return { dir: args.dir ?? "/Users/demo/Desktop" };
    },
    async aiRefresh() {
      record("aiRefresh");
    },
    async aiExport() {
      record("aiExport");
      return { file: "/Users/demo/Desktop/cairn-ai.json" };
    },

    async saveConfig(args) {
      record("saveConfig", args);
      if (state.config.hasErrors) throw new CairnApiError("invalidConfig", state.config.issues[0]?.description ?? "");
      update((s) => {
        const config = applyPatches(s.config.config, args.patches);
        // Vues dérivées de la configuration, comme dans le main : catégories IA cochées, outils exclus.
        const ai = {
          ...s.ai,
          tools: s.ai.tools.map((tool) => ({
            ...tool,
            categories: config.ai.find((a) => a.id === tool.id)?.categories ?? [],
          })),
        };
        const inventory = s.inventory.inventory
          ? {
              ...s.inventory,
              inventory: {
                ...s.inventory.inventory,
                entries: s.inventory.inventory.entries.map((e) => ({
                  ...e,
                  excluded: config.excludedTools.includes(e.name),
                })),
              },
            }
          : s.inventory;
        return { ...s, config: { ...s.config, config }, ai, inventory };
      });
    },
    async homeChoices() {
      record("homeChoices");
      return [".aws", ".config", ".gitconfig", ".ssh", ".zshrc", "Documents", "Pictures"];
    },
    async completePath(args) {
      record("completePath", args);
      const entries = [".config/", ".config/mise/", ".gitconfig", ".ssh/", ".zshrc", "Documents/"];
      const text = args.input.replace(/^~\//, "");
      return entries
        .filter((e) => e.toLowerCase().startsWith(text.toLowerCase()) && e !== text)
        .slice(0, 8)
        .map((p) => ({ path: p, isDirectory: p.endsWith("/") }));
    },
    async onboardingDetect() {
      record("onboardingDetect");
      return {
        folders: [
          { path: "/Volumes/workspaces", selected: true },
          { path: "/Users/demo/Projects", selected: false },
        ],
        home: [
          { path: ".zshrc", selected: true },
          { path: ".gitconfig", selected: true },
          { path: ".ssh", selected: true },
          { path: ".docker", selected: false },
        ],
        ai: [
          {
            id: "claude-code",
            name: "Claude Code",
            detected: true,
            categories: ["config", "conversations", "memories"],
            offeredCategories: ["conversations", "config", "memories"],
          },
          {
            id: "claude-desktop",
            name: "Claude Desktop",
            detected: false,
            categories: [],
            offeredCategories: ["conversations", "config"],
          },
          {
            id: "codex",
            name: "Codex",
            detected: true,
            categories: ["config", "conversations"],
            offeredCategories: ["conversations", "config", "memories", "credentials"],
          },
        ],
        destination: { kind: "later" },
        encrypted: true,
        frequency: "daily",
        time: "12:30",
        weekday: "monday",
        background: false,
        language: "auto",
        notifications: true,
      };
    },
    async onboardingFinish(args) {
      record("onboardingFinish", { draft: args.draft, password: args.password ? "•••" : undefined });
      const normal = SCENARIOS.normal.build();
      update((s) => ({ ...normal, revision: s.revision, language: s.language }));
    },

    async probeLocal(args) {
      record("probeLocal", args);
      return { kind: "ok", freeBytes: 812 * GB, existingImages: [] };
    },
    async connectSMB(args) {
      record("connectSMB", { ...args, password: args.password ? "•••" : undefined });
      return { ok: true, failure: null, message: null, hint: null, root: "/Volumes/backups" };
    },
    async checkSMB(args) {
      record("checkSMB", { ...args, password: args.password ? "•••" : undefined });
      return {
        kind: "ok",
        freeBytes: 3_200 * GB,
        existingImages: [
          { machine: "MacBook-Pro", path: "/Volumes/backups/cairn-MacBook-Pro.sparsebundle", isThisMac: true },
        ],
      };
    },
    async listShares(args) {
      record("listShares", { ...args, password: args.password ? "•••" : undefined });
      return ["backups", "home", "media"];
    },
    async closeProbe() {
      record("closeProbe");
    },
    async localRoots() {
      record("localRoots");
      return [
        { name: "Archive", path: "/Volumes/Archive" },
        { name: "demo", path: "/Users/demo" },
      ];
    },
    async listFolders(args) {
      record("listFolders", args);
      return ["Backups", "Photos", "Projects"].map((name) => ({ name, path: `${args.path}/${name}` }));
    },
    async createFolder(args) {
      record("createFolder", args);
      return `${args.parent}/${args.name.trim()}`;
    },
    async addDestination(args) {
      record("addDestination", { ...args, password: args.password ? "•••" : undefined });
      const ids = state.destinations.map((d) => d.id);
      const prefix = args.destination.provider === "smb" ? "nas" : "disk";
      const id = ids.length === 0 ? "main" : ids.includes(prefix) ? `${prefix}-${ids.length + 1}` : prefix;
      const destination = { ...args.destination, id };
      update((s) => ({
        ...s,
        config: {
          ...s.config,
          config: { ...s.config.config, destinations: [...s.config.config.destinations, destination] },
        },
        destinations: [
          ...s.destinations,
          destinationView(destination, {
            run: { damagedVersions: [], lastBytesTransferred: 0, lastDuration: 0 },
            history: { status: "idle", versions: [], error: null, loadedAt: null },
          }),
        ],
      }));
      return { destination, keychainError: null };
    },
    async editDestination(args) {
      record("editDestination", { ...args, password: args.password ? "•••" : undefined });
      const original = state.config.config.destinations.find((d) => d.id === args.id);
      if (!original) throw new CairnApiError("notFound", `unknown destination ${args.id}`);
      const destination = {
        ...original,
        path: args.destination.path,
        url: args.destination.url,
        username: args.destination.username,
      };
      update((s) => ({
        ...s,
        destinations: s.destinations.map((d) => (d.id === args.id ? { ...d, config: destination } : d)),
      }));
      return { destination, keychainError: null };
    },
    async planDestinationRemoval(args) {
      record("planDestinationRemoval", args);
      const items: Awaited<ReturnType<CairnApi["planDestinationRemoval"]>>["items"] = [
        { kind: "configuration", id: args.id },
        { kind: "state", id: args.id },
        ...(args.includeBackups
          ? [
              {
                kind: "backups" as const,
                path: "/Volumes/Archive/cairn/cairn-MacBook-Pro.sparsebundle",
                bytes: 182 * GB,
              },
            ]
          : []),
      ];
      return {
        planId: `plan-${args.id}`,
        destination: args.id,
        includeBackups: args.includeBackups,
        items,
        backupsUnavailable: null,
        canExecute: true,
        backupBytes: args.includeBackups ? 182 * GB : 0,
      };
    },
    async removeDestination(args) {
      record("removeDestination", args);
      const id = args.planId.replace(/^plan-/, "");
      update((s) => ({
        ...s,
        destinations: s.destinations.filter((d) => d.id !== id),
        config: {
          ...s.config,
          config: { ...s.config.config, destinations: s.config.config.destinations.filter((d) => d.id !== id) },
        },
      }));
      return { cancelled: false };
    },
    async planRetention(args) {
      record("planRetention", args);
      const planId = `retention-${args.destination}-${calls.length}`;
      retentionPlans.set(planId, { destination: args.destination, retention: args.retention });
      // Rétention plus courte (nombre de versions inférieur à celles de l'historique) : versions à supprimer.
      const d = state.destinations.find((x) => x.id === args.destination);
      const kept = args.retention.mode === "count" ? args.retention.count : args.retention.days + args.retention.weeks;
      const names = (d?.history.versions ?? []).slice(kept).map((v) => v.name);
      const shorter =
        args.retention.mode === "count" && d?.config.retention.mode === "count"
          ? args.retention.count < d.config.retention.count
          : names.length > 0;
      return {
        planId,
        destination: args.destination,
        decision: shorter ? "confirm" : "apply",
        excess: shorter
          ? { names: names.length > 0 ? names : ["2026-09-01T123000", "2026-09-08T123000"], bytes: 3.4 * GB }
          : { names: [], bytes: 0 },
      };
    },
    async applyRetention(args) {
      record("applyRetention", args);
      const plan = retentionPlans.get(args.planId);
      if (!plan) throw new CairnApiError("notFound", "unknown or expired retention plan");
      retentionPlans.delete(args.planId);
      const setRetention = <T extends { id: string; retention: unknown }>(d: T): T =>
        d.id === plan.destination ? { ...d, retention: plan.retention } : d;
      update((s) => ({
        ...s,
        config: {
          ...s.config,
          config: { ...s.config.config, destinations: s.config.config.destinations.map(setRetention) },
        },
        destinations: s.destinations.map((d) =>
          d.id === plan.destination ? { ...d, config: setRetention(d.config) } : d,
        ),
      }));
      return { cancelled: false, value: { deleted: ["2026-09-01T123000", "2026-09-08T123000"], failed: [] } };
    },

    async planRestore(args) {
      record("planRestore", {
        ...args,
        imagePassword: args.imagePassword ? "•••" : undefined,
        sharePassword: args.sharePassword ? "•••" : undefined,
      });
      const source = args.source;
      if (source.kind === "destination" && !state.destinations.some((d) => d.id === source.destination))
        throw new CairnApiError("notFound", t("cli.backup.no_destination"));
      const raw = fixturePlan(state, args, scenario.newMac === true, t, `restore-${calls.length}`);
      // Volume « workspaces » créé depuis l'écran : plus de cible absente.
      const plan =
        volumeCreated && raw.details
          ? {
              ...raw,
              details: { ...raw.details, folders: raw.details.folders.map((f) => ({ ...f, targetMissing: false })) },
              warnings: raw.warnings.filter((w) => !w.includes("/Volumes/workspaces")),
            }
          : raw;
      if (plan.simulated) restorePlans.set(plan.planId, plan);
      update((s) => ({ ...s, restore: { ...s.restore, plan } }));
      return plan;
    },
    async applyRestore(args) {
      record("applyRestore", args);
      const plan = restorePlans.get(args.planId);
      if (!plan) throw new CairnApiError("notFound", "unknown restore plan");
      if (state.restore.running || state.backup.running) throw new CairnApiError("busy", t("cli.busy"));
      restorePlan = plan;
      restoreStart = clock;
      restorePlans.clear();
      state = { ...state, restore: { ...state.restore, running: true, ok: null, error: null, progress: null } };
      step();
      publish();
      return { cancelled: false };
    },

    async createWorkspacesVolume(args) {
      record("createWorkspacesVolume", args);
      // Le volume existe désormais : les cibles sous /Volumes/workspaces ne manquent plus.
      update((s) => ({
        ...s,
        messages: [
          ...s.messages,
          {
            id: s.messages.length + 100,
            level: "success",
            text: t("restore.ui.volume_created", "workspaces"),
            date: Date.now(),
          },
        ],
      }));
      volumeCreated = true;
      return { cancelled: false };
    },
    async prepareConfirmation(args) {
      record("prepareConfirmation", args);
      tokens += 1;
      return { token: `00000000-0000-4000-8000-${String(tokens).padStart(12, "0")}`, expiresIn: 120_000 };
    },

    async checkUpdates() {
      record("checkUpdates");
      update((s) => ({
        ...s,
        updates: {
          ...s.updates,
          lastCheck: Date.now(),
          message: s.updates.available ? null : t("update.up_to_date", s.updates.current),
        },
      }));
    },
    async installUpdate() {
      record("installUpdate");
      const blocked = blocker();
      update((s) => ({
        ...s,
        updates: blocked
          ? { ...s.updates, phase: "failed", error: blocked }
          : { ...s.updates, phase: "downloading", error: null },
      }));
    },

    async openTarget(args) {
      record("openTarget", args);
    },
    async showInFinder(args) {
      record("showInFinder", args);
    },
    async openExternal(args) {
      record("openExternal", args);
      if (!/^https:\/\/github\.com\/Romakita\/cairn(\/|$)/.test(args.url))
        throw new CairnApiError("forbidden", "URL not allowed");
    },
    async copyText(args) {
      record("copyText", args);
    },
    async chooseFolder(args) {
      record("chooseFolder", args);
      return args.defaultPath ?? "/Users/demo/Projects";
    },
    async openWindow(args) {
      record("openWindow", args);
      const preselect = args.route === "clean" && !args.preselect ? state.analysis.preselection : args.preselect;
      const request = { ...args, ...(preselect ? { preselect } : {}) };
      for (const n of navigators) n(request);
    },
    async hidePanel() {
      record("hidePanel");
    },
    async dismissMessage(args) {
      record("dismissMessage", args);
      update((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== args.id) }));
    },
    async quit() {
      record("quit");
    },
  };

  return api;
}
