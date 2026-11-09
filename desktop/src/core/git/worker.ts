// Point d'entrée d'un worker_thread du pool git (remplace la sous-commande `git-worker` de la 0.8.0, design.md §5).
// Ce fichier est chargé par `new Worker(<chemin>)` : sous `bun test`, le chemin de ce `.ts` ; dans l'app, celui de
// son bundle CommonJS (`bun build src/core/git/worker.ts --target=node --format=cjs`), fourni par l'appelant.
// Aucun chemin n'est calculé ici (ni `__dirname` ni `import.meta`) : un bundle les figerait au chemin des sources.
//
// Protocole : `workerData` = { kind: "cairn-git-worker", repo, options } ; le worker répond par un seul message
// { type: "report", report } ou { type: "error", message }. Le pool envoie { type: "abort" } avant `terminate()` :
// le worker tue alors ses processus git (un `terminate()` seul arrêterait le JavaScript mais laisserait git tourner).
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { ProcessGroup } from "../process.ts";
import { analyze } from "./analysis.ts";
import { defaultScannerDeps } from "./deps.ts";
import { Git } from "./git.ts";
import { isWorkerInput, type WorkerCommand, type WorkerReply } from "./protocol.ts";

/** Corps du worker ; ne fait rien hors d'un worker du pool (le module peut être inclus dans un autre bundle). */
export function runGitWorker(): void {
  const port = parentPort;
  if (isMainThread || !port || !isWorkerInput(workerData)) return;
  const input = workerData;
  const group = new ProcessGroup();
  port.on("message", (command: WorkerCommand) => {
    if (command?.type !== "abort") return;
    group.abort(0);
    group.signalAll("SIGKILL");
    port.postMessage({ type: "aborted" } satisfies WorkerReply);
  });
  analyze(input.repo, input.options, defaultScannerDeps, new Date(), new Git(input.repo, group))
    .then((report) => port.postMessage({ type: "report", report } satisfies WorkerReply))
    .catch((error: unknown) => port.postMessage({ type: "error", message: String(error) } satisfies WorkerReply))
    .finally(() => port.unref()); // plus rien à attendre : le worker se termine et rend sa mémoire
}

runGitWorker();
