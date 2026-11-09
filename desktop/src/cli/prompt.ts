// Saisies interactives de la CLI : confirmation `[o/N]` (`CLI.confirm`) et mot de passe sans écho (`readpassphrase`).
// La confirmation lit une ligne sur l'entrée standard ; le mot de passe est lu sur `/dev/tty` quand l'entrée standard
// n'est pas un terminal (comme `readpassphrase`), pour qu'un script qui redirige stdin puisse quand même le demander.
import { close, open } from "node:fs";
import type { Readable, Writable } from "node:stream";
import tty from "node:tty";
import { promisify } from "node:util";

const openFd = promisify(open);
const closeFd = promisify(close);

/** Réponses acceptées par la confirmation (casse ignorée). */
const YES = new Set(["o", "oui", "y", "yes"]);

/** Réponse acceptée : `o`, `oui`, `y` ou `yes`. */
export function isYes(answer: string | null): boolean {
  return answer !== null && YES.has(answer.toLowerCase());
}

/** Lit une ligne (sans son retour à la ligne) ; `null` en fin de flux sans rien lu (`readLine()` de Swift). */
export function readLine(input: Readable): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (line: string | null) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.pause();
      resolve(line);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      // Le reste est perdu : une seule réponse est attendue.
      finish(buffer.slice(0, i).replace(/\r$/, ""));
    };
    const onEnd = () => finish(buffer === "" ? null : buffer);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
    input.resume();
  });
}

/** Pose la question sur stderr (`question [o/N] `) et lit la réponse sur stdin. */
export async function confirm(
  question: string,
  streams: { input?: Readable; output?: Writable } = {},
): Promise<boolean> {
  (streams.output ?? process.stderr).write(`${question} [o/N] `);
  return isYes(await readLine(streams.input ?? process.stdin));
}

/** Flux d'entrée qui peut passer en mode brut (terminal). */
export interface HiddenInput extends Readable {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/**
 * Lit une saisie sans écho, caractère par caractère : Entrée valide, Retour arrière efface, Ctrl-C et Ctrl-D (ligne
 * vide) annulent. Renvoie `null` si la saisie est annulée ou vide (comme `CLI.askPassword`).
 */
export function readHidden(input: HiddenInput, output: Writable, prompt: string): Promise<string | null> {
  output.write(`${prompt} `);
  const raw = typeof input.setRawMode === "function" && input.isTTY === true;
  if (raw) input.setRawMode?.(true);
  return new Promise((resolve) => {
    let value = "";
    const finish = (result: string | null) => {
      input.off("data", onData);
      input.off("end", onEnd);
      if (raw) input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      resolve(result === "" ? null : result);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n") return finish(value);
        if (ch === "\u0003") return finish(null); // Ctrl-C
        if (ch === "\u0004") {
          if (value === "") return finish(null); // Ctrl-D
          continue;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        value += ch;
      }
    };
    const onEnd = () => finish(value === "" ? null : value);
    input.on("data", onData);
    input.once("end", onEnd);
    input.resume();
  });
}

/**
 * Mot de passe lu sans écho : sur l'entrée standard si c'est un terminal, sinon sur `/dev/tty` (`readpassphrase`).
 * `null` si aucun terminal n'est disponible, si la saisie est annulée ou vide.
 */
export async function askPassword(prompt: string): Promise<string | null> {
  if (process.stdin.isTTY) return readHidden(process.stdin, process.stderr, prompt);
  // Un descripteur par sens : chaque flux ferme le sien en étant détruit (jamais deux fermetures du même numéro).
  let readFd: number;
  let writeFd: number;
  try {
    readFd = await openFd("/dev/tty", "r");
  } catch {
    return null;
  }
  try {
    writeFd = await openFd("/dev/tty", "w");
  } catch {
    await closeFd(readFd).catch(() => {});
    return null;
  }
  const input = new tty.ReadStream(readFd);
  const output = new tty.WriteStream(writeFd);
  try {
    return await readHidden(input, output, prompt);
  } finally {
    input.destroy();
    output.destroy();
  }
}
