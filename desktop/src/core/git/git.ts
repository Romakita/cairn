// Appels à `/usr/bin/git` sans interaction (port de `Git`, GitMaintenance.swift) : pas d'invite de mot de passe,
// ssh en mode batch, messages en anglais (`LC_ALL=C`, sorties analysées), stderr ignoré. Tout est asynchrone
// (`process.ts`) ; les diffs et historiques passent de git à git en flux (`pipeLines`), jamais en mémoire.
import { type ProcessGroup, type ProcessOptions, pipe, run } from "../process.ts";

export const GIT = "/usr/bin/git";
export const GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=10";

/** Environnement de git : celui du processus, plus `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0` et un ssh non interactif. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: base.GIT_SSH_COMMAND ?? GIT_SSH_COMMAND,
  };
}

export interface GitResult {
  /** Code de sortie ; -1 si git a été tué par un signal, 127 s'il n'a pas pu être lancé. */
  status: number;
  out: string;
}

export interface GitRunOptions {
  stdin?: string;
  /** Lecture ligne à ligne : rien n'est gardé (`out` est vide). */
  onLine?: (line: string) => void;
}

export class Git {
  constructor(
    readonly repo: string,
    /** Groupe d'arrêt des processus git (worker arrêté au délai, annulation). */
    readonly group?: ProcessGroup,
  ) {}

  private options(extra: Partial<ProcessOptions> = {}): ProcessOptions {
    return { env: gitEnv(), stderr: "ignore", group: this.group, ...extra };
  }

  async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    try {
      const r = await run(
        GIT,
        ["-C", this.repo, ...args],
        this.options({ stdin: options.stdin, onLine: options.onLine }),
      );
      if (!r.launched) return { status: -1, out: "" };
      return { status: r.code ?? -1, out: r.stdout };
    } catch {
      return { status: 127, out: "" };
    }
  }

  async ok(args: readonly string[]): Promise<boolean> {
    return (await this.run(args)).status === 0;
  }

  /** Sortie sans espaces de bord, `null` en cas d'échec ou de sortie vide. */
  async line(args: readonly string[]): Promise<string | null> {
    const r = await this.run(args);
    const s = r.out.trim();
    return r.status === 0 && s !== "" ? s : null;
  }

  /** Nombre de lignes non vides de la sortie, sans la garder. */
  async countLines(args: readonly string[], predicate: (line: string) => boolean = () => true): Promise<number> {
    let n = 0;
    await this.run(args, {
      onLine: (l) => {
        if (l !== "" && predicate(l)) n += 1;
      },
    });
    return n;
  }

  /**
   * `git <first> | git <second>`, lu ligne à ligne : la sortie de `first` (un diff, un historique) passe de git à
   * git en flux et n'est jamais gardée. Rend `false` si un des deux n'a pas pu être lancé.
   */
  async pipeLines(
    first: readonly string[],
    second: readonly string[],
    onLine: (line: string) => void,
  ): Promise<boolean> {
    try {
      await pipe(
        { executable: GIT, args: ["-C", this.repo, ...first] },
        { executable: GIT, args: ["-C", this.repo, ...second] },
        this.options({ onLine }),
        this.options(),
      );
      return true;
    } catch {
      return false;
    }
  }
}
