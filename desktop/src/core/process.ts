// Lanceur de processus externes (port de `Process` côté Swift : SystemRunner, Git.run, Git.pipe, rsync, hdiutil).
// Règles (README, parity/platform.md §2.1, régressions 46a9475 et a7d22bf) :
// - chemin absolu et tableau d'arguments, jamais de shell ;
// - tout est asynchrone : stdin est écrit en flux pendant que stdout est lu (sinon les deux processus s'attendent) ;
// - stdout gardé, lu ligne à ligne ou passé en flux ; seules les 20 dernières lignes de stderr sont gardées ;
// - délai d'expiration : SIGTERM puis SIGKILL après 5 s ; on ne signale qu'un processus réellement lancé et vivant.
import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Lignes de stderr gardées pour l'erreur et le journal (rsync, hdiutil…). */
export const STDERR_TAIL_LINES = 20;
/** Délai entre SIGTERM et SIGKILL (un rsync bloqué sur un partage qui ne répond plus ignore SIGTERM). */
export const KILL_GRACE_MS = 5000;

/**
 * PATH élargi de `SystemRunner` (Homebrew, mise, `~/.local/bin`…) : une app lancée depuis le Finder n'a qu'un PATH
 * minimal. Même ordre que la 0.8.0.
 */
export function widePath(home: string = os.homedir()): string {
  return [
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/share/mise/shims`,
    `${home}/.cargo/bin`,
    `${home}/go/bin`,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

/** Environnement de `SystemRunner` : PATH élargi et `HOMEBREW_NO_AUTO_UPDATE=1`, le reste hérité. */
export function systemRunnerEnv(base: NodeJS.ProcessEnv = process.env, home?: string): NodeJS.ProcessEnv {
  return { ...base, PATH: widePath(home), HOMEBREW_NO_AUTO_UPDATE: "1" };
}

/** Exécutable de `SystemRunner` : les commandes (`brew`, `mise`…) sont cherchées dans le PATH élargi par `env`. */
export const ENV_EXECUTABLE = "/usr/bin/env";

export type StdinSource = string | Uint8Array | Readable | AsyncIterable<string | Uint8Array>;

export interface ProcessOptions {
  cwd?: string;
  /** Environnement complet (par défaut celui du processus). */
  env?: NodeJS.ProcessEnv;
  /** Variables ajoutées à `env` (ou à l'environnement hérité). */
  extraEnv?: Record<string, string>;
  /** Entrée standard, écrite en flux en parallèle de la lecture de stdout. Absente : stdin fermé (`/dev/null`). */
  stdin?: StdinSource;
  /** Lecture ligne à ligne de stdout (rien n'est gardé). */
  onLine?: (line: string) => void;
  /** Lecture brute de stdout (rien n'est gardé). */
  onData?: (chunk: Buffer) => void;
  /** Garder stdout dans le résultat (par défaut : oui, sauf avec `onLine` ou `onData`). */
  captureStdout?: boolean;
  /** `tail` (défaut) : 20 dernières lignes gardées ; `ignore` : `/dev/null`. */
  stderr?: "tail" | "ignore";
  /** Nombre de lignes de stderr gardées (défaut 20). */
  stderrLines?: number;
  /** Délai d'expiration en millisecondes : SIGTERM puis SIGKILL après `killGraceMs`. */
  timeoutMs?: number;
  killGraceMs?: number;
  /** Arrêt demandé de l'extérieur : SIGTERM puis SIGKILL. */
  signal?: AbortSignal;
  /** Groupe d'arrêt : un groupe déjà arrêté ne lance plus rien. */
  group?: ProcessGroup;
}

export interface ProcessResult {
  /** Code de sortie, `null` si le processus a été tué par un signal (ou jamais lancé). */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** stdout en UTF-8 si `captureStdout`, sinon chaîne vide. */
  stdout: string;
  /** Dernières lignes de stderr (au plus `stderrLines`). */
  stderrTail: string[];
  timedOut: boolean;
  /** Arrêté par `terminate()`, le signal d'arrêt ou le groupe. */
  cancelled: boolean;
  /** `false` si le groupe était déjà arrêté : rien n'a été lancé. */
  launched: boolean;
}

/** Erreur de lancement (exécutable introuvable, droits…) : `code` est l'errno (`ENOENT`…). */
export class ProcessLaunchError extends Error {
  constructor(
    readonly executable: string,
    readonly code: string | undefined,
    cause: unknown,
  ) {
    super(`cannot launch ${executable}: ${code ?? String(cause)}`, { cause });
    this.name = "ProcessLaunchError";
  }
}

interface Internal {
  /** stdout laissé tel quel, ni lu ni gardé (lu par un autre processus). */
  rawStdout?: boolean;
}

/** Processus lancé (ou refusé par son groupe). */
export class RunningProcess {
  readonly result: Promise<ProcessResult>;
  private child: ChildProcess | null = null;
  private exited = false;
  private cancelled = false;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly executable: string,
    readonly args: readonly string[],
    private readonly options: ProcessOptions = {},
    internal: Internal = {},
  ) {
    if (!path.isAbsolute(executable)) throw new TypeError(`executable must be an absolute path: ${executable}`);
    this.result = this.launch(internal);
  }

  /** pid du processus lancé, `undefined` s'il n'a pas pu l'être. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Lancé et pas encore terminé. */
  get running(): boolean {
    return this.child?.pid !== undefined && !this.exited;
  }

  /** @internal stdout brut, pour `pipe`. */
  get stdoutStream(): Readable | null {
    return this.child?.stdout ?? null;
  }

  /** Envoie un signal, seulement à un processus lancé et vivant (jamais à un pid réutilisé). */
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!this.running || !this.child) return false;
    return this.child.kill(signal);
  }

  /** SIGTERM, puis SIGKILL après `graceMs` s'il tourne encore. */
  terminate(graceMs: number = this.options.killGraceMs ?? KILL_GRACE_MS): void {
    this.cancelled = true;
    this.stop(graceMs);
  }

  suspend(): boolean {
    return this.kill("SIGSTOP");
  }

  resume(): boolean {
    return this.kill("SIGCONT");
  }

  private stop(graceMs: number): void {
    if (!this.running) return;
    this.kill("SIGCONT"); // un processus suspendu ne traite pas SIGTERM
    this.kill("SIGTERM");
    if (!this.killTimer) this.killTimer = setTimeout(() => this.kill("SIGKILL"), graceMs);
  }

  private launch(internal: Internal): Promise<ProcessResult> {
    const o = this.options;
    const group = o.group;
    if (group?.isAborted || o.signal?.aborted) {
      return Promise.resolve({
        code: null,
        signal: null,
        stdout: "",
        stderrTail: [],
        timedOut: false,
        cancelled: true,
        launched: false,
      });
    }
    const stdinMode = o.stdin === undefined ? "ignore" : "pipe";
    const stderrMode = o.stderr === "ignore" ? "ignore" : "pipe";
    const env = { ...(o.env ?? process.env), ...o.extraEnv };
    const child = spawn(this.executable, [...this.args], {
      cwd: o.cwd,
      env,
      shell: false,
      stdio: [stdinMode, "pipe", stderrMode],
    });
    this.child = child;

    return new Promise<ProcessResult>((resolve, reject) => {
      if (child.pid === undefined) {
        child.once("error", (error: NodeJS.ErrnoException) => {
          this.exited = true;
          reject(new ProcessLaunchError(this.executable, error.code, error));
        });
        return;
      }
      group?.add(this);
      let timedOut = false;
      const timers: NodeJS.Timeout[] = [];
      const grace = o.killGraceMs ?? KILL_GRACE_MS;
      if (o.timeoutMs !== undefined) {
        timers.push(
          setTimeout(() => {
            timedOut = true;
            this.stop(grace);
          }, o.timeoutMs),
        );
      }
      const onAbort = () => this.terminate(grace);
      o.signal?.addEventListener("abort", onAbort, { once: true });

      // stdout
      const chunks: Buffer[] = [];
      const capture = o.captureStdout ?? (!o.onLine && !o.onData);
      const pending: Promise<void>[] = [];
      if (child.stdout && !internal.rawStdout) {
        if (o.onLine) {
          const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
          const onLine = o.onLine;
          rl.on("line", (line) => onLine(line));
          pending.push(new Promise((done) => rl.once("close", () => done())));
          if (capture) child.stdout.on("data", (c: Buffer) => chunks.push(c));
        } else {
          child.stdout.on("data", (c: Buffer) => {
            o.onData?.(c);
            if (capture) chunks.push(c);
          });
        }
      }

      // stderr : dernières lignes seulement
      const tail: string[] = [];
      const max = o.stderrLines ?? STDERR_TAIL_LINES;
      if (child.stderr) {
        const rl = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
        rl.on("line", (line) => {
          tail.push(line);
          if (tail.length > max) tail.shift();
        });
        pending.push(new Promise((done) => rl.once("close", () => done())));
      }

      // stdin, en parallèle de la lecture
      if (child.stdin && o.stdin !== undefined) writeStdin(child, o.stdin);

      child.once("close", (code, signal) => {
        this.exited = true;
        for (const t of timers) clearTimeout(t);
        if (this.killTimer) clearTimeout(this.killTimer);
        o.signal?.removeEventListener("abort", onAbort);
        group?.remove(this);
        void Promise.all(pending).then(() =>
          resolve({
            code,
            signal,
            stdout: capture ? Buffer.concat(chunks).toString("utf8") : "",
            stderrTail: tail,
            timedOut,
            cancelled: this.cancelled,
            launched: true,
          }),
        );
      });
    });
  }
}

/** Écrit stdin sans bloquer ; un processus qui se termine sans tout lire (EPIPE) n'est pas une erreur. */
function writeStdin(child: ChildProcess, source: StdinSource): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.on("error", () => {}); // EPIPE : le processus a fermé son entrée
  if (typeof source === "string" || source instanceof Uint8Array) {
    stdin.end(source);
    return;
  }
  const readable = source instanceof Readable ? source : Readable.from(source);
  pipeline(readable, stdin).catch(() => {});
}

/** Lance un processus ; le résultat arrive par `result`. */
export function start(executable: string, args: readonly string[], options: ProcessOptions = {}): RunningProcess {
  return new RunningProcess(executable, args, options);
}

/** Lance un processus et attend sa fin. Rejette seulement si le lancement échoue (`ProcessLaunchError`). */
export function run(executable: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return start(executable, args, options).result;
}

export interface Command {
  executable: string;
  args: readonly string[];
}

/**
 * `first | second` sans rien garder en mémoire (diffs et historiques git peuvent peser des Go) : le stdout du premier
 * est passé en flux au stdin du second, avec contre-pression (tampons bornés). Si le second se termine avant la fin,
 * le premier reçoit SIGPIPE. Les options (sauf `stdin`) s'appliquent au second ; `firstOptions` au premier.
 * (Un descripteur partagé entre les deux enfants serait plus direct, mais Bun, qui fait tourner les tests, ne sait
 * pas passer le flux d'un enfant en stdio d'un autre.)
 */
export async function pipe(
  first: Command,
  second: Command,
  options: Omit<ProcessOptions, "stdin"> = {},
  firstOptions: Omit<ProcessOptions, "onLine" | "onData" | "captureStdout"> = {},
): Promise<{ first: ProcessResult; second: ProcessResult }> {
  const a = new RunningProcess(
    first.executable,
    first.args,
    { ...firstOptions, captureStdout: false },
    {
      rawStdout: true,
    },
  );
  const out = a.stdoutStream;
  if (a.pid === undefined || !out) {
    await a.result; // rejette avec l'erreur de lancement
    throw new Error("unreachable");
  }
  let b: RunningProcess;
  try {
    b = new RunningProcess(second.executable, second.args, { ...options, stdin: out });
  } catch (error) {
    a.terminate();
    throw error;
  }
  const [ra, rb] = await Promise.allSettled([a.result, b.result]);
  if (rb.status === "rejected") {
    a.terminate();
    await a.result.catch(() => {});
    throw rb.reason;
  }
  if (ra.status === "rejected") throw ra.reason;
  return { first: ra.value, second: rb.value };
}

/**
 * Processus d'une opération (sauvegarde, analyse) arrêtés ensemble. Une fois arrêté, le groupe ne lance plus rien :
 * un arrêt demandé avant le lancement d'un processus l'empêche de démarrer (46a9475).
 */
export class ProcessGroup {
  private readonly processes = new Set<RunningProcess>();
  private aborted = false;

  get isAborted(): boolean {
    return this.aborted;
  }

  /** @internal */
  add(p: RunningProcess): void {
    this.processes.add(p);
  }

  /** @internal */
  remove(p: RunningProcess): void {
    this.processes.delete(p);
  }

  /** Arrête tout : SIGTERM, puis SIGKILL après `graceMs`. */
  abort(graceMs: number = KILL_GRACE_MS): void {
    this.aborted = true;
    for (const p of this.processes) p.terminate(graceMs);
  }

  /** Signal à tous les processus vivants (SIGSTOP / SIGCONT pendant la veille). */
  signalAll(signal: NodeJS.Signals): void {
    for (const p of this.processes) p.kill(signal);
  }

  get size(): number {
    return this.processes.size;
  }
}
