// Accès complet au disque de macOS (spec `backup`, « Accès complet au disque ») : détection sans effet de bord, et
// relevé des éléments dont macOS a refusé la lecture pendant une sauvegarde (lignes d'erreur de rsync).
//
// Détection : lecture d'un dossier que macOS ne laisse lire qu'avec l'Accès complet au disque (base TCC, Safari).
// Lire un dossier n'ouvre aucune fenêtre système et ne modifie rien. EPERM/EACCES → refusé ; dossier lu → accordé ;
// aucun des dossiers n'existe → inconnu (on ne peut rien conclure).
import os from "node:os";
import path from "node:path";
import { readdir } from "./fs-promises.ts";

export type FullDiskAccess = "granted" | "denied" | "unknown";

/** Dossiers protégés sondés, relatifs au home, dans l'ordre. */
export const PROTECTED_PROBES = ["Library/Application Support/com.apple.TCC", "Library/Safari"] as const;

/** Lecture d'un dossier (injectée par les tests) ; lève une erreur avec `code` (`EPERM`, `ENOENT`…). */
export type DirectoryReader = (dir: string) => Promise<unknown>;

const DENIED_CODES = new Set(["EPERM", "EACCES"]);

/** État de l'Accès complet au disque pour ce processus (ou l'app qui l'a lancé, pour la commande `cairn`). */
export async function fullDiskAccess(
  home: string = os.homedir(),
  read: DirectoryReader = (dir) => readdir(dir),
): Promise<FullDiskAccess> {
  for (const probe of PROTECTED_PROBES) {
    try {
      await read(path.join(home, probe));
      return "granted";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== undefined && DENIED_CODES.has(code)) return "denied";
      // ENOENT, ENOTDIR… : dossier absent, on essaie le suivant.
    }
  }
  return "unknown";
}

/** Adresse du réglage « Accès complet au disque » dans Réglages Système (ouverte par le main seulement). */
export const FULL_DISK_ACCESS_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

// MARK: Éléments refusés pendant la copie

const DENIAL = "(?:Operation not permitted|Permission denied)";
/** openrsync (macOS) : `rsync(PID): warning|error: CHEMIN: … : Operation not permitted`. */
const OPENRSYNC = new RegExp(`^rsync\\(\\d+\\): (?:warning|error): (.+?): (?:.*: )?${DENIAL}$`);
/** rsync GNU : `rsync: [sender] opendir "CHEMIN" failed: Permission denied (13)`, `send_files failed to open "…"`. */
const GNU = new RegExp(`^rsync(?:\\(\\d+\\))?: (?:\\[[a-z]+\\] )?[^"]*"(.+)"[^"]*: ${DENIAL} \\(\\d+\\)$`);

/**
 * Chemin dont macOS a refusé la lecture, d'après une ligne d'erreur de rsync (openrsync ou GNU), sinon `null`.
 * EPERM (« Operation not permitted » : protection de la vie privée, Accès complet au disque) et EACCES (« Permission
 * denied » : droits du fichier) sont comptés pareil : dans les deux cas l'élément n'a pas pu être lu.
 */
export function permissionDenied(line: string): string | null {
  const text = line.trimEnd();
  const m = OPENRSYNC.exec(text) ?? GNU.exec(text);
  return m?.[1] ?? null;
}

/** Éléments non lus parce que macOS en a refusé la lecture : nombre total et premiers chemins. */
export interface PermissionDenied {
  count: number;
  examples: string[];
}

/** Nombre de chemins gardés en exemple (le total est compté sans les garder). */
export const MAX_DENIED_EXAMPLES = 10;

export function noPermissionDenied(): PermissionDenied {
  return { count: 0, examples: [] };
}

/** Compte les refus au fil de l'eau, sans garder plus de `MAX_DENIED_EXAMPLES` chemins. */
export class DeniedCounter {
  private total = 0;
  private readonly first: string[] = [];

  add(item: string): void {
    this.total += 1;
    if (this.first.length < MAX_DENIED_EXAMPLES) this.first.push(item);
  }

  merge(other: PermissionDenied): void {
    this.total += other.count;
    for (const e of other.examples) if (this.first.length < MAX_DENIED_EXAMPLES) this.first.push(e);
  }

  get count(): number {
    return this.total;
  }

  value(): PermissionDenied {
    return { count: this.total, examples: [...this.first] };
  }
}
