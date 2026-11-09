// Emplacements de `~/.cairn` (port de `CairnPaths`, Support.swift). `CAIRN_HOME` remplace le dossier (tests,
// comptes de test) ; avec `--config <fichier>`, la racine est le dossier de ce fichier.
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, stat } from "./fs-promises.ts";

/** `~` et `~/…` développés comme `expandingTildeInPath` (le reste est rendu tel quel). */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class CairnPaths {
  readonly root: string;

  constructor(root?: string) {
    if (root !== undefined) {
      this.root = root;
    } else {
      const env = process.env.CAIRN_HOME;
      this.root = env ? env : path.join(os.homedir(), ".cairn");
    }
  }

  /**
   * Variante `--config <fichier>` : l'état, les journaux et le verrou vivent à côté du fichier, dont le dossier n'est
   * pas modifié (pas de `ensure()`). Le chemin est développé (`~`) et rendu absolu.
   */
  static forConfigFile(file: string): { paths: CairnPaths; file: string } {
    const absolute = path.resolve(expandTilde(file));
    return { paths: new CairnPaths(path.dirname(absolute)), file: absolute };
  }

  get config(): string {
    return path.join(this.root, "config.toml");
  }

  get logs(): string {
    return path.join(this.root, "logs");
  }

  get state(): string {
    return path.join(this.root, "state");
  }

  get operationLock(): string {
    return path.join(this.state, "operation.lock");
  }

  /** Crée `~/.cairn` (droits 700), `logs/` et `state/`. */
  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.logs, { recursive: true });
    await mkdir(this.state, { recursive: true });
    await chmod(this.root, 0o700);
  }

  /**
   * Crée un sous-dossier (`logs/`, `state/`…). Une racine absente est d'abord créée en 700 ; une racine existante
   * n'est pas modifiée (avec `--config`, c'est le dossier choisi par l'utilisateur).
   */
  async prepare(dir: string): Promise<void> {
    if (!(await exists(this.root))) await this.ensure();
    await mkdir(dir, { recursive: true });
  }
}
