// Processus de mesure (593f593) : hache un fichier avec `sha256File` et affiche « <empreinte> <croissance en octets> ».
// Lancé à part (Bun, ou le Node d'Electron) pour que les autres tests ne faussent pas la mémoire mesurée.
import { sha256File } from "../../src/core/backup/integrity.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: backup-hash-footprint <file>");
  process.exit(2);
}
const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const base = process.memoryUsage().rss;
let peak = base;
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 5);
const hash = await sha256File(file);
clearInterval(timer);
peak = Math.max(peak, process.memoryUsage().rss);
console.log(`${hash} ${peak - base}`);
