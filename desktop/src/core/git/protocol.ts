// Messages entre le pool (`pool.ts`) et ses workers (`worker.ts`). Fichier sans effet de bord : le pool l'importe
// sans charger le code d'analyse.
import type { GitOptions, RepoReport } from "./types.ts";

export const WORKER_KIND = "cairn-git-worker";

/** `workerData` d'un worker du pool. */
export interface WorkerInput {
  kind: typeof WORKER_KIND;
  repo: string;
  options: GitOptions;
}

/** Réponses du worker : un rapport ou une erreur, et l'accusé d'un arrêt demandé. */
export type WorkerReply =
  | { type: "report"; report: RepoReport }
  | { type: "error"; message: string }
  | { type: "aborted" };

/** Le pool demande au worker de tuer ses processus git avant `terminate()`. */
export type WorkerCommand = { type: "abort" };

export function isWorkerInput(data: unknown): data is WorkerInput {
  return typeof data === "object" && data !== null && (data as { kind?: unknown }).kind === WORKER_KIND;
}
