// Pool de worker_threads pour l'analyse git (port de `GitWorkerPool` et `GitMaintenance.analyzeAll`, design.md §5).
// Un worker par dépôt, au plus `parallel` (4) à la fois : chaque worker rend sa mémoire en se terminant, et un dépôt
// pathologique ne fait pas tomber l'analyse. Limites : `resourceLimits.maxOldGenerationSizeMb` (1536) et délai
// (300 s, `terminate()` au-delà). Toute analyse git passe par ce pool (b23d23f) ; les rapports arrivent au fil de
// l'eau par `onReport`, le premier progrès est `done=0,total=N`, l'arrêt garde les rapports déjà reçus (8171ca8).
// Le main ne fait qu'attendre des événements : aucune attente synchrone (a7d22bf).
//
// Chemin du worker : fourni par l'appelant (`workerFile`), jamais calculé ici. Sous `bun test`, c'est
// `src/core/git/worker.ts` ; dans l'app, le bundle CJS de ce fichier (`dist/git-worker.cjs`), à côté de `main.cjs`.
// `new Worker(code, { eval: true })` est écarté : le worker a besoin de tout le code d'analyse et de ses imports.
import { Worker } from "node:worker_threads";
import { Fmt } from "../format.ts";
import { t } from "../l10n.ts";
import { discover } from "./discovery.ts";
import { WORKER_KIND, type WorkerCommand, type WorkerInput, type WorkerReply } from "./protocol.ts";
import type { Classify, GitOptions, RepoReport } from "./types.ts";

export const DEFAULT_PARALLEL = 4;
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MEMORY_LIMIT_MB = 1536;
/** Délai laissé au worker pour tuer ses processus git avant `terminate()`. */
const ABORT_GRACE_MS = 1000;
const MONITOR_INTERVAL_MS = 1000;

export interface PoolProgress {
  done: number;
  total: number;
  /** Dépôt en cours → mémoire du tas de son worker (octets, 0 si inconnue). */
  running: Record<string, number>;
  /** Dépôt → raison de l'échec. */
  failed: Record<string, string>;
}

export interface PoolOptions {
  /** Fichier du worker (`worker.ts` sous Bun, son bundle CJS dans l'app). */
  workerFile: string;
  parallel?: number;
  timeoutMs?: number;
  memoryLimitMb?: number;
  signal?: AbortSignal;
  progress?: (p: PoolProgress) => void;
  onReport?: (r: RepoReport) => void;
}

export interface PoolResult {
  /** Rapports dans l'ordre des dépôts (seulement ceux reçus, même après un arrêt). */
  reports: RepoReport[];
  failed: Record<string, string>;
  /** Dépôts trouvés (après le filtre `only`). */
  repos: string[];
  cancelled: boolean;
}

type Outcome = { report: RepoReport } | { failure: string } | { cancelled: true };

class RunningWorker {
  readonly worker: Worker;
  private stopping = false;
  failure: string | null = null;

  constructor(workerFile: string, input: WorkerInput, memoryLimitMb: number) {
    this.worker = new Worker(workerFile, {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: memoryLimitMb },
      stdout: false,
      stderr: false,
    });
  }

  /** Demande au worker de tuer ses processus git, puis l'arrête. */
  stop(failure: string | null): void {
    if (failure !== null && this.failure === null) this.failure = failure;
    if (this.stopping) return;
    this.stopping = true;
    const terminate = () => void this.worker.terminate().catch(() => {});
    const timer = setTimeout(terminate, ABORT_GRACE_MS);
    this.worker.once("message", (m: WorkerReply) => {
      if (m?.type === "aborted") {
        clearTimeout(timer);
        terminate();
      }
    });
    try {
      this.worker.postMessage({ type: "abort" } satisfies WorkerCommand);
    } catch {
      clearTimeout(timer);
      terminate();
    }
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Mémoire du tas du worker, si le moteur sait la donner (Node ≥ 22). */
  async heapBytes(): Promise<number> {
    const w = this.worker as Worker & { getHeapStatistics?: () => Promise<{ used_heap_size: number }> };
    try {
      return w.getHeapStatistics ? (await w.getHeapStatistics()).used_heap_size : 0;
    } catch {
      return 0;
    }
  }
}

/** Analyse les dépôts donnés, chacun dans son worker. */
export async function analyzeRepos(
  repos: readonly string[],
  options: GitOptions,
  pool: PoolOptions,
): Promise<PoolResult> {
  const parallel = Math.max(1, pool.parallel ?? DEFAULT_PARALLEL);
  const timeoutMs = pool.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryLimitMb = pool.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  const signal = pool.signal;
  const total = repos.length;
  const results = new Map<string, RepoReport>();
  const failed: Record<string, string> = {};
  const running = new Map<string, RunningWorker>();
  const memory: Record<string, number> = {};
  let done = 0;

  const snapshot = (): PoolProgress => ({
    done,
    total,
    running: Object.fromEntries([...running.keys()].map((r) => [r, memory[r] ?? 0])),
    failed: { ...failed },
  });
  const report = () => pool.progress?.(snapshot());

  report(); // premier progrès : done=0, total=N

  const onAbort = () => {
    for (const w of running.values()) w.stop(null);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const monitor = setInterval(() => {
    void Promise.all(
      [...running].map(async ([repo, w]) => {
        memory[repo] = await w.heapBytes();
      }),
    ).then(report);
  }, MONITOR_INTERVAL_MS);

  const analyzeOne = (repo: string): Promise<Outcome> =>
    new Promise((resolve) => {
      let w: RunningWorker;
      try {
        w = new RunningWorker(pool.workerFile, { kind: WORKER_KIND, repo, options }, memoryLimitMb);
      } catch (error) {
        resolve({ failure: String(error) });
        return;
      }
      running.set(repo, w);
      let received: RepoReport | null = null;
      let errorMessage: string | null = null;
      const timer = setTimeout(() => w.stop(t("git.worker.timeout", Math.round(timeoutMs / 1000))), timeoutMs);
      w.worker.on("message", (m: WorkerReply) => {
        if (m?.type === "report") received = m.report;
        else if (m?.type === "error") errorMessage = m.message;
      });
      w.worker.on("error", (error: Error & { code?: string }) => {
        if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
          w.failure ??= t("git.worker.memory", Fmt.bytes(memoryLimitMb * 1024 * 1024));
        } else {
          errorMessage ??= String(error);
        }
      });
      w.worker.once("exit", (code) => {
        clearTimeout(timer);
        running.delete(repo);
        delete memory[repo];
        if (w.failure !== null) resolve({ failure: w.failure });
        else if (received !== null && !w.isStopping) resolve({ report: received });
        else if (signal?.aborted) resolve({ cancelled: true });
        else resolve({ failure: errorMessage ?? t("git.worker.failed", code) });
      });
    });

  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < repos.length && !signal?.aborted) {
      const repo = repos[next++]!;
      const outcome = await analyzeOne(repo);
      done += 1;
      if ("report" in outcome) {
        results.set(repo, outcome.report);
        if (!signal?.aborted) pool.onReport?.(outcome.report);
      } else if ("failure" in outcome) {
        failed[repo] = outcome.failure;
      }
      report();
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(parallel, Math.max(1, repos.length)) }, lane));
  } finally {
    clearInterval(monitor);
    signal?.removeEventListener("abort", onAbort);
  }
  for (const k of Object.keys(memory)) delete memory[k];
  report();
  return {
    reports: repos.flatMap((r) => (results.has(r) ? [results.get(r)!] : [])),
    failed,
    repos: [...repos],
    cancelled: signal?.aborted ?? false,
  };
}

/** Découvre les dépôts des dossiers (filtre `only`), puis les analyse dans le pool. */
export async function analyzeAll(
  folders: readonly string[],
  options: GitOptions,
  classify: Classify,
  pool: PoolOptions,
): Promise<PoolResult> {
  let repos = await discover(folders, classify);
  const only = options.only;
  if (only) repos = repos.filter((r) => r.includes(only));
  return analyzeRepos(repos, options, pool);
}
