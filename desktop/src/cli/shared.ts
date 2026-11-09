// Types et outils communs aux commandes `cairn` (port des parties partagées de CLI.swift).
// Aucun import d'Electron : la CLI tourne dans le main Electron, et sous `bun test` en appelant `runCli` directement.
import { readFile } from "node:fs/promises";
import type { BackupServiceDependencies } from "../core/backup/run.ts";
import { type CairnConfig, decodeConfig, defaultConfig } from "../core/config.ts";
import type { ConfigStore } from "../core/config-store.ts";
import type { FullDiskAccess } from "../core/full-disk-access.ts";
import { type JSONValue, prettyJSON } from "../core/json.ts";
import type { RestoreDependencies } from "../core/restore/service.ts";
import { TOMLDocument } from "../core/toml.ts";

/** Codes de sortie : 0 succès, 1 échec, 2 erreur d'usage ou de configuration (`CLI.Exit`). */
export const Exit = { ok: 0, failure: 1, usage: 2 } as const;
export type ExitCode = (typeof Exit)[keyof typeof Exit];

/** Sorties ligne à ligne : le résultat sur `out` (stdout), les messages et la progression sur `err` (stderr). */
export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

/** Sortie d'erreur brute (progression `\r` sans fin de ligne), et si c'est un terminal (🐞 ef55c5b). */
export interface ProgressStream {
  readonly isTTY: boolean;
  write(text: string): void;
}

/**
 * Ce que la CLI ne peut pas deviner sans Electron, et ce que les tests remplacent. Tout est facultatif : les valeurs
 * par défaut sont celles d'un vrai terminal (`process.stderr`, stdin, `/dev/tty`).
 */
export interface CliContext {
  /**
   * Worker du pool git : `dist/git-worker.cjs` dans l'app (le main passe
   * `path.join(app.getAppPath(), "dist/git-worker.cjs")`), `src/core/git/worker.ts` sous `bun test`.
   */
  gitWorkerFile?: string;
  /** Langues préférées du système (`app.getPreferredSystemLanguages()`), pour `language = "auto"`. */
  preferredLanguages?: readonly string[];
  /** Sortie de la progression ; par défaut `process.stderr`. */
  progress?: ProgressStream;
  /** Confirmation `[o/N]` (sautée avec `--yes`). */
  confirm?: (question: string) => Promise<boolean>;
  /** Mot de passe lu sans écho (`null` si annulé ou vide) : restauration, 2ᵉ passe. */
  askPassword?: (prompt: string) => Promise<string | null>;
  /**
   * Remplacements des dépendances de la sauvegarde et de la vérification (`defaultBackupDependencies`) : home, nom de
   * la machine, secrets… (tests). Le home sert aussi de home à restaurer s'il n'est pas donné dans `restore`.
   */
  backup?: Partial<BackupServiceDependencies>;
  /** Remplacements des dépendances de la restauration (home cible, attentes, exécuteur de commandes…). */
  restore?: Partial<RestoreDependencies>;
  /** État de l'Accès complet au disque (par défaut : sondé dans le home, voir `core/full-disk-access.ts`). */
  fullDiskAccess?: () => Promise<FullDiskAccess>;
}

/** Ce que reçoit chaque commande : ses arguments (sans le nom de la commande), la configuration, les sorties. */
export interface CommandEnv {
  args: readonly string[];
  store: ConfigStore;
  io: CliIO;
  context: CliContext;
}

export type Command = (env: CommandEnv) => Promise<ExitCode>;

/** Sortie JSON commune : 2 espaces, clés triées, format de `JSONSerialization` (`printJSON`). */
export function printJSON(value: JSONValue, io: CliIO): void {
  io.out(prettyJSON(value));
}

/** `String(describing: error)` : le message d'une erreur. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readDocument(store: ConfigStore): Promise<TOMLDocument | null> {
  let text: string;
  try {
    text = await readFile(store.file, "utf8");
  } catch {
    return null;
  }
  try {
    return TOMLDocument.parse(text);
  } catch {
    return null;
  }
}

/** Configuration courante, lue sans migration ni écriture (valeurs par défaut sinon) : `CLI.readConfig`. */
export async function readConfig(store: ConfigStore): Promise<CairnConfig> {
  const doc = await readDocument(store);
  if (!doc) return defaultConfig();
  try {
    return decodeConfig(doc).config;
  } catch {
    return defaultConfig();
  }
}

/** Langue de `config.toml`, lue sans migration ni écriture : `CLI.configuredLanguage`. */
export async function configuredLanguage(store: ConfigStore): Promise<string | null> {
  const doc = await readDocument(store);
  if (!doc) return null;
  try {
    const v = doc.tree().value("language");
    return v?.type === "string" ? v.value : null;
  } catch {
    return null;
  }
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * `String.padding(toLength:withPad:" ",startingAt:0)` : complété par des espaces, ou TRONQUÉ à `length` caractères
 * (graphèmes, comme les `Character` de Swift).
 */
export function pad(text: string, length: number): string {
  const chars = Array.from(segmenter.segment(text), (s) => s.segment);
  if (chars.length >= length) return chars.slice(0, length).join("");
  return text + " ".repeat(length - chars.length);
}

/** `--help` ou `-h` parmi les arguments. */
export function wantsHelp(args: readonly string[]): boolean {
  return args.includes("-h") || args.includes("--help");
}
