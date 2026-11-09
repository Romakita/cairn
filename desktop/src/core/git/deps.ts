// Classement et mesure du scanner, branchés pour la maintenance git (découverte, worktrees, dernière modification).
// Le worker (`worker.ts`) les importe : des fonctions ne passent pas d'un thread à l'autre. `measure` lance son
// propre worker de parcours (scanner-worker.ts) : imbriqué dans le worker git, il ne bloque ni le main ni ce worker.
import { classify } from "../regenerable.ts";
import { measure } from "../scanner.ts";
import type { ScannerDeps } from "./types.ts";

/** Classement et mesure par défaut : ceux de l'analyse du disque (une seule implémentation). */
export const defaultScannerDeps: ScannerDeps = { classify, measure: (p) => measure(p) };
