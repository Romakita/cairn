// Comptage des fichiers d'une partie (port de `BackupEngine.countFiles`, `WorkPile`, `CountWorker`).
// Les morceaux (dossiers du premier niveau) forment une pile partagée : chacun des 4 compteurs prend le suivant, le
// compte avec `rsync -n` vers un dossier vide (jamais créé), puis prend le suivant jusqu'à ce que la pile soit vide.
// Les exclusions de la partie s'appliquent avant le filtre du morceau : le total est celui d'un seul rsync.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ProcessGroup } from "../process.ts";
import { copyChunks, type RsyncBinary, runRsync } from "./rsync.ts";
import type { BackupPart } from "./types.ts";

/** Nombre de rsync parallèles pour compter les fichiers d'une partie. */
export const COUNT_WORKERS = 4;

/** Un compteur : dossier pris dans la pile, fichiers trouvés, dernier chemin vu, terminé ou non. */
export interface CountWorker {
  folder: string;
  found: number;
  current: string;
  done: boolean;
}

/** Pile de morceaux partagée par les compteurs : chacun prend le suivant dès qu'il a fini. */
export class WorkPile {
  private next = 0;
  constructor(private readonly count: number) {}
  take(): number | null {
    if (this.next >= this.count) return null;
    const i = this.next;
    this.next += 1;
    return i;
  }
}

export interface CountOptions {
  binary: RsyncBinary;
  workers?: number;
  /** Arrêt groupé : la copie finie, annulée ou en échec arrête le comptage. */
  group?: ProcessGroup;
  /** `(rang, état)` à chaque changement d'un compteur. */
  onWorker?: (index: number, worker: CountWorker) => void;
  /** Fichiers trouvés depuis le dernier appel. */
  onFound?: (delta: number) => void;
}

/** Nombre de fichiers de la partie (exclusions comprises) ; rien n'est écrit. Partiel si le groupe est arrêté. */
export async function countFiles(part: BackupPart, options: CountOptions): Promise<number> {
  const items = await copyChunks(part);
  const pile = new WorkPile(items.length);
  const workers = Math.max(1, Math.min(options.workers ?? COUNT_WORKERS, items.length));
  let total = 0;
  const worker = async (w: number): Promise<void> => {
    let found = 0;
    for (;;) {
      if (options.group?.isAborted) break;
      const k = pile.take();
      if (k === null) break;
      const item = items[k]!;
      const label = item.label ?? "";
      options.onWorker?.(w, { folder: label, found, current: "", done: false });
      const empty = path.join(os.tmpdir(), `cairn-count-${randomUUID().toUpperCase()}`);
      const base = found;
      let last = 0;
      let n = 0;
      try {
        const r = await runRsync(
          {
            part,
            dest: empty,
            linkDest: null,
            dryRun: true,
            filters: item.filters,
            deleteExcluded: item.filters.length === 0,
          },
          {
            binary: options.binary,
            group: options.group,
            onProgress: (_copied, examined, current) => {
              options.onFound?.(examined - last);
              last = examined;
              options.onWorker?.(w, { folder: label, found: base + examined, current, done: false });
            },
          },
        );
        n = r.transferred;
      } catch {
        n = 0;
      }
      options.onFound?.(n - last);
      found += n;
      total += n;
    }
    options.onWorker?.(w, { folder: "", found, current: "", done: true });
  };
  await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
  return total;
}
