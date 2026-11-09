// Journal d'une exécution : `~/.cairn/logs/<type>-<yyyyMMdd-HHmmss>.log`, lignes `<ISO 8601> <texte>`
// (port de `RunLog`, Support.swift). Écrit en flux, dans l'ordre des appels ; jamais de secret.
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { formatLocalDate, isoDate } from "../dates.ts";
import type { CairnPaths } from "../paths.ts";

export class RunLog {
  private constructor(
    readonly file: string,
    private readonly stream: WriteStream,
    private readonly clock: () => Date,
  ) {}

  /** Crée le journal (`~/.cairn` en 700 s'il est le premier à le créer). */
  static async open(paths: CairnPaths, type: string, now: Date = new Date(), clock: () => Date = () => new Date()) {
    await paths.prepare(paths.logs);
    const file = path.join(paths.logs, `${type}-${formatLocalDate(now, "yyyyMMdd-HHmmss")}.log`);
    const stream = createWriteStream(file, { flags: "w", encoding: "utf8" });
    await new Promise<void>((resolve, reject) => {
      stream.once("open", () => resolve());
      stream.once("error", reject);
    });
    stream.on("error", () => {}); // disque plein, volume retiré : le journal se tait, la sauvegarde continue
    return new RunLog(file, stream, clock);
  }

  /** Nom du fichier (cité par le manifest). */
  get name(): string {
    return path.basename(this.file);
  }

  write(line: string): void {
    if (this.stream.writableEnded) return;
    this.stream.write(`${isoDate(this.clock())} ${line}\n`);
  }

  close(): Promise<void> {
    if (this.stream.writableEnded) return Promise.resolve();
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}
