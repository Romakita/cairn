// Restauration sélective (port de `RestoreService`, Restore.swift). Simulation par défaut : `apply` écrit réellement,
// sous le verrou d'opération `restore`. Parties : home, dossiers suivis (nom → cible), outils IA (fusion), outils CLI
// (réinstallation), puis vérification finale. Les fichiers remplacés sont gardés en `.pre-restore` ; une simulation ne
// crée rien, pas même la cible (e229e52). La progression est un objet sérialisable (IPC) diffusé par événements.
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runningApps } from "../ai/backup.ts";
import { type AIProfile, aiManagedPaths, BUNDLED_PROFILES, displayName } from "../ai/profiles.ts";
import { describeError } from "../backup/types.ts";
import { type CommandRunner, systemRunner } from "../inventory/collector.ts";
import { t } from "../l10n.ts";
import { OperationLock, type StatePaths } from "../lock.ts";
import { CairnPaths } from "../paths.ts";
import { ProcessLaunchError, run } from "../process.ts";
import { measure } from "../scanner.ts";
import {
  type AIRestoreReport,
  emptyReport,
  notRewritten,
  type PathPrefix,
  restoreLegacy,
  restoreTool,
} from "./ai-restore.ts";
import type { RestoreSource } from "./source.ts";
import { type Clock, fixSecretPermissions, waitUntil } from "./system.ts";
import { checkTools, type ManualTool, reinstallTools } from "./tools.ts";

export const SYSTEM_RSYNC = "/usr/bin/rsync";
/** Outil IA ouvert : vérifié toutes les 2 s, 10 minutes au plus. */
export const QUIT_POLL_MS = 2000;
export const QUIT_TIMEOUT_MS = 600_000;

export interface RestorePlan {
  tools: boolean;
  home: boolean;
  /** Outils IA à restaurer (identifiants). */
  ai: string[];
  replaceDatabases: boolean;
  /** Dossier de la sauvegarde (nom) → dossier cible. */
  folders: Record<string, string>;
}

/** Plan par défaut de la 0.8.0 : outils et home, aucun outil IA, aucun dossier. */
export function defaultPlan(): RestorePlan {
  return { tools: true, home: true, ai: [], replaceDatabases: false, folders: {} };
}

export interface RestoreStep {
  step: string;
  ok: boolean;
  detail: string;
  /** Réinstallation manuelle (go, `~/.local/bin`). */
  manual?: ManualTool;
}

export type RestorePhase = "home" | "folders" | "ai" | "tools" | "check";

export type RestoreWaiting = { kind: "admin"; command: string } | { kind: "quit"; tool: string; name: string };

/** État de la restauration pour l'interface (objet simple, sérialisable). */
export interface RestoreProgress {
  apply: boolean;
  phase: RestorePhase | null;
  /** Partie en cours (`home`, `folders/<nom>`, `ai`, `tools`, `check`). */
  current: string | null;
  /** Parties terminées / prévues. */
  done: number;
  total: number;
  steps: RestoreStep[];
  waiting: RestoreWaiting | null;
  finished: boolean;
}

export type RestoreEvent =
  | { type: "progress"; progress: RestoreProgress }
  | { type: "step"; step: RestoreStep }
  | { type: "finished"; steps: RestoreStep[]; ok: boolean };

export interface RestoreDependencies {
  /** Home à restaurer (par défaut celui de l'utilisateur ; un dossier temporaire dans les tests). */
  home?: string;
  /** Commandes d'outils (`command -v`, `xcode-select -p`, installations) : `SystemRunner` par défaut. */
  runner?: CommandRunner;
  /** rsync de la copie (`/usr/bin/rsync`). */
  rsync?: string;
  profiles?: readonly AIProfile[];
  /** Outil IA ouvert ? (`pgrep` par défaut) */
  isRunning?: (profile: AIProfile) => Promise<boolean>;
  /**
   * Étape qui demande le mot de passe administrateur (Command Line Tools, Homebrew) : ouverte dans Terminal, jamais
   * dans Cairn, puis attendue (`terminalAdminWaiter`). Par défaut : rien n'est ouvert, l'étape échoue.
   */
  waitForAdmin?: (command: string) => Promise<boolean>;
  /** Outil IA ouvert : demande de le quitter et renvoie vrai une fois fermé (`quitWaiter`). Par défaut : passé. */
  waitForQuit?: (profile: AIProfile) => Promise<boolean>;
  /** `state/` du verrou d'opération (`~/.cairn/state` par défaut). */
  statePaths?: StatePaths;
  /** Taille d'un dossier (récapitulatif) : `Scanner.measure` par défaut. */
  measure?: (p: string) => Promise<number>;
}

export interface RestoreRunOptions {
  apply?: boolean;
  signal?: AbortSignal;
}

/** Attente qu'un outil IA soit quitté (toutes les 2 s, 10 minutes au plus), horloge injectable. */
export function waitUntilQuit(
  profile: AIProfile,
  options: {
    isRunning?: (p: AIProfile) => Promise<boolean>;
    clock?: Clock;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const isRunning = options.isRunning ?? defaultIsRunning;
  return waitUntil(async () => !(await isRunning(profile)), {
    intervalMs: QUIT_POLL_MS,
    timeoutMs: options.timeoutMs ?? QUIT_TIMEOUT_MS,
    clock: options.clock,
    signal: options.signal,
  });
}

/** `waitForQuit` de la CLI et de l'app : prévient l'utilisateur (`onWait`) puis attend que l'outil soit quitté. */
export function quitWaiter(
  options: {
    isRunning?: (p: AIProfile) => Promise<boolean>;
    clock?: Clock;
    signal?: AbortSignal;
    onWait?: (profile: AIProfile) => void;
  } = {},
): (profile: AIProfile) => Promise<boolean> {
  return async (profile) => {
    options.onWait?.(profile);
    return waitUntilQuit(profile, options);
  };
}

/** Un processus de l'outil tourne-t-il ? (`pgrep -lx` sur les noms du profil) */
export async function defaultIsRunning(profile: AIProfile): Promise<boolean> {
  const names = new Set(profile.processes ?? []);
  if (names.size === 0) return false;
  return (await runningApps([profile])).some((n) => names.has(n));
}

async function defaultMeasure(p: string): Promise<number> {
  return (await measure(p)).size;
}

export class RestoreService {
  readonly home: string;
  private readonly runner: CommandRunner;
  private readonly profiles: readonly AIProfile[];
  private readonly listeners = new Set<(event: RestoreEvent) => void>();
  private progress: RestoreProgress | null = null;

  constructor(
    readonly source: RestoreSource,
    private readonly deps: RestoreDependencies = {},
  ) {
    this.home = deps.home ?? os.homedir();
    this.runner = deps.runner ?? systemRunner(this.home);
    this.profiles = deps.profiles ?? BUNDLED_PROFILES;
  }

  /** Abonnement aux événements (progression, étapes, fin) ; renvoie le désabonnement. */
  on(listener: (event: RestoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Dernier état de la progression (copie), `null` avant le premier `run`. */
  get currentProgress(): RestoreProgress | null {
    return this.progress ? structuredClone(this.progress) : null;
  }

  private emit(event: RestoreEvent): void {
    for (const l of this.listeners) l(event);
  }

  private publish(): void {
    if (this.progress) this.emit({ type: "progress", progress: structuredClone(this.progress) });
  }

  /** Dossiers IA de la home héritée laissés à la fusion IA (racines et marqueurs des profils). */
  private legacyAIExcludes(): string[] {
    return this.source.kind === "legacy" ? aiManagedPaths(this.profiles) : [];
  }

  /** Dossiers d'un outil IA dans la sauvegarde (`ai/<outil>`, ou emplacements hérités de scripts/backup.sh). */
  aiDirs(tool: string): string[] {
    const root = this.source.root;
    if (this.source.kind !== "legacy") return [path.join(root, "ai", tool)];
    switch (tool) {
      case "claude-code":
        return [path.join(root, "home/.claude"), path.join(root, "home/.claude.json")];
      case "codex":
        return [path.join(root, "home/.codex")];
      case "claude-desktop":
        return [path.join(root, "ai/claude-desktop")];
      default:
        return [];
    }
  }

  /** Taille à copier par partie (récapitulatif avant confirmation). */
  async sizes(plan: RestorePlan): Promise<Record<string, number>> {
    const size = this.deps.measure ?? defaultMeasure;
    const out: Record<string, number> = {};
    const h = this.source.home;
    if (plan.home && h !== null) {
      let total = await size(h);
      // Sauvegarde héritée : les dossiers des outils IA de home/ passent par la fusion IA, pas par le home.
      for (const rel of this.legacyAIExcludes()) total -= await size(path.join(h, rel));
      out.home = Math.max(0, total);
    }
    for (const f of this.source.folders) {
      if (plan.folders[f.name] !== undefined) out[`folders/${f.name}`] = await size(f.dir);
    }
    for (const tool of plan.ai) {
      let total = 0;
      for (const d of this.aiDirs(tool)) total += await size(d);
      out[`ai/${tool}`] = total;
    }
    return out;
  }

  /** Copie avec rsync ; les fichiers remplacés sont gardés avec le suffixe `.pre-restore`. Codes 0, 23 et 24 : réussi. */
  private async copy(from: string, to: string, dryRun: boolean, excludes: readonly string[] = []) {
    // Une simulation ne crée pas le dossier cible (rsync -n vers un dossier absent liste tout, e229e52).
    if (!dryRun) await mkdir(to, { recursive: true }).catch(() => {});
    const args = [
      "-a",
      "--backup",
      "--suffix=.pre-restore",
      ...(dryRun ? ["-n"] : []),
      ...excludes.map((e) => `--exclude=/${e}`),
      `${from}/`,
      to.endsWith("/") ? to : `${to}/`,
    ];
    let status: number;
    try {
      const r = await run(this.deps.rsync ?? SYSTEM_RSYNC, args, { captureStdout: false, onData: () => {} });
      status = r.code ?? -1;
    } catch (error) {
      if (!(error instanceof ProcessLaunchError)) throw error;
      status = 127;
    }
    return { ok: status === 0 || status === 23 || status === 24, detail: `rsync ${status}` };
  }

  /**
   * Exécute la restauration choisie et renvoie les étapes. En `apply`, prend le verrou `restore` (lève
   * `OperationLockError` s'il est tenu) ; sinon rien n'est écrit ni lancé (simulation).
   */
  async run(plan: RestorePlan, options: RestoreRunOptions = {}): Promise<RestoreStep[]> {
    const apply = options.apply ?? false;
    let lock: OperationLock | null = null;
    if (apply) {
      lock = new OperationLock(this.deps.statePaths ?? { stateDir: new CairnPaths().state });
      await lock.acquire("restore");
    }
    try {
      return await this.perform(plan, apply, options.signal);
    } finally {
      await lock?.release();
    }
  }

  private plannedTotal(plan: RestorePlan, apply: boolean): number {
    const s = this.source;
    let n = plan.home && s.home !== null ? 1 : 0;
    n += s.folders.filter((f) => plan.folders[f.name] !== undefined).length;
    if (plan.ai.length > 0) n += 1;
    if (plan.tools && s.toolsDir !== null) n += 1;
    if (apply && s.toolsDir !== null) n += 1;
    return n;
  }

  private async perform(plan: RestorePlan, apply: boolean, signal?: AbortSignal): Promise<RestoreStep[]> {
    const s = this.source;
    const home = this.home;
    const progress: RestoreProgress = {
      apply,
      phase: null,
      current: null,
      done: 0,
      total: this.plannedTotal(plan, apply),
      steps: [],
      waiting: null,
      finished: false,
    };
    this.progress = progress;
    const record = (step: RestoreStep) => {
      progress.steps.push(step);
      this.emit({ type: "step", step: { ...step } });
      this.publish();
    };
    const begin = (phase: RestorePhase, current: string) => {
      progress.phase = phase;
      progress.current = current;
      this.publish();
    };
    const end = () => {
      progress.done += 1;
      progress.current = null;
      this.publish();
    };
    this.publish();

    if (plan.home && s.home !== null) {
      begin("home", "home");
      // Sauvegarde héritée : les dossiers des outils IA sont dans home/ ; ils passent par la fusion IA (3692993).
      const r = await this.copy(s.home, home, !apply, this.legacyAIExcludes());
      if (apply) await fixSecretPermissions(home);
      record({ step: "home", ok: r.ok, detail: r.detail });
      end();
    }
    const prefixes: PathPrefix[] = [];
    if (s.originalHome !== null && s.originalHome !== home) prefixes.push([s.originalHome, home]);
    for (const f of s.folders) {
      const target = plan.folders[f.name];
      if (target === undefined) continue;
      begin("folders", `folders/${f.name}`);
      const r = await this.copy(f.dir, target, !apply);
      record({ step: `folders/${f.name}`, ok: r.ok, detail: r.detail });
      if (f.originalPath !== target) prefixes.push([f.originalPath, target]);
      end();
    }
    if (plan.ai.length > 0) {
      begin("ai", "ai");
      await this.restoreAI(plan, apply, prefixes, record, progress, signal);
      end();
    }
    if (plan.tools && s.toolsDir !== null) {
      begin("tools", "tools");
      await reinstallTools(s.toolsDir, {
        runner: this.runner,
        apply,
        signal,
        record,
        waitForAdmin: async (command) => {
          progress.waiting = { kind: "admin", command };
          this.publish();
          try {
            return await (this.deps.waitForAdmin ?? (async () => false))(command);
          } finally {
            progress.waiting = null;
            this.publish();
          }
        },
      });
      end();
    }
    // Vérification finale (lecture seule) : outils de l'inventaire présents ou manquants.
    if (apply && s.toolsDir !== null) {
      begin("check", "check");
      const { present, missing } = await checkTools(s.toolsDir, this.runner);
      let detail = t("cli.restore.check", present.length, missing.length);
      if (missing.length > 0) detail += ` — ${missing.join(", ")}`;
      record({ step: "check", ok: !plan.tools || missing.length === 0, detail });
      end();
    }
    progress.phase = null;
    progress.finished = true;
    this.publish();
    const steps = progress.steps.map((x) => ({ ...x }));
    this.emit({ type: "finished", steps, ok: steps.every((x) => x.ok) });
    return steps;
  }

  private async restoreAI(
    plan: RestorePlan,
    apply: boolean,
    prefixes: readonly PathPrefix[],
    record: (step: RestoreStep) => void,
    progress: RestoreProgress,
    signal?: AbortSignal,
  ): Promise<void> {
    const s = this.source;
    const home = this.home;
    const isRunning = this.deps.isRunning ?? defaultIsRunning;
    const waitForQuit = this.deps.waitForQuit ?? (async () => false);
    // Un outil ouvert réécrirait ses fichiers par-dessus la restauration : il doit être quitté avant (3692993).
    const tools: string[] = [];
    for (const id of plan.ai) {
      const p = this.profiles.find((x) => x.id === id);
      if (!p) {
        tools.push(id);
        continue;
      }
      let skip = false;
      if (apply && (await isRunning(p))) {
        progress.waiting = { kind: "quit", tool: p.id, name: displayName(p) };
        this.publish();
        try {
          skip = signal?.aborted === true || !(await waitForQuit(p));
        } finally {
          progress.waiting = null;
          this.publish();
        }
      }
      if (skip) record({ step: `ai/${id}`, ok: false, detail: t("restore.ai.skipped_open") });
      else tools.push(id);
    }
    try {
      let report: AIRestoreReport = emptyReport();
      if (apply && tools.length > 0) {
        const options = { home, replaceDatabases: plan.replaceDatabases, prefixes };
        if (s.kind === "legacy") {
          report = await restoreLegacy(s.root, new Set(tools), options);
        } else {
          for (const id of tools) {
            const p = this.profiles.find((x) => x.id === id);
            if (!p) continue;
            const r = await restoreTool(path.join(s.root, "ai", id), p, options);
            report.renamedProjects.push(...r.renamedProjects);
            report.notRewritten.push(...r.notRewritten);
          }
        }
        await fixSecretPermissions(home);
      } else if (!apply) {
        // Simulation : les données qui garderont leurs anciens chemins sont annoncées dès maintenant.
        for (const id of tools) report.notRewritten.push(...(await notRewritten(id, home, prefixes)));
      }
      if (tools.length > 0) {
        let detail = tools.join(", ");
        if (report.renamedProjects.length > 0) {
          detail += ` — ${t("restore.ai.renamed", report.renamedProjects.length)}`;
        }
        record({ step: "ai", ok: true, detail });
      }
      for (const note of report.notRewritten) record({ step: "ai:paths", ok: true, detail: note });
    } catch (error) {
      record({ step: "ai", ok: false, detail: describeError(error) });
    }
  }

  /** Vérification seule (`--check`) : outils de l'inventaire présents ou manquants, sans rien modifier. */
  check(): Promise<{ present: string[]; missing: string[] }> {
    return checkTools(this.source.toolsDir, this.runner);
  }
}
