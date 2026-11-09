// Chargement, migration, enregistrement et surveillance de `config.toml` (port de ConfigStore.swift).
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyConfig,
  type CairnConfig,
  CONFIG_VERSION,
  ConfigIssue,
  configVersion,
  decodeConfig,
  migrateConfig,
  newConfigDocument,
} from "./config.ts";
import { t } from "./l10n.ts";
import { CairnPaths } from "./paths.ts";
import { TOMLDocument, TOMLError } from "./toml.ts";

export interface LoadedConfig {
  config: CairnConfig;
  issues: ConfigIssue[];
  document: TOMLDocument;
  migrated: boolean;
  hasErrors: boolean;
}

/** Fichier illisible ou erreur de syntaxe TOML. */
export class ConfigLoadError extends Error {
  private constructor(
    readonly kind: "syntax" | "unreadable",
    message: string,
    readonly syntax: TOMLError | null,
  ) {
    super(message);
    this.name = "ConfigLoadError";
  }

  static syntax(e: TOMLError): ConfigLoadError {
    return new ConfigLoadError("syntax", t("config.issue.syntax", e.line, e.message), e);
  }

  static unreadable(message: string): ConfigLoadError {
    return new ConfigLoadError("unreadable", message, null);
  }

  get description(): string {
    return this.message;
  }

  /** Problème bloquant équivalent : une erreur de syntaxe désactive les sauvegardes comme une erreur de schéma. */
  get issue(): ConfigIssue {
    return this.syntax
      ? new ConfigIssue("error", "", this.syntax.line, this.syntax.message)
      : new ConfigIssue("error", "", null, this.message);
  }
}

/** Enregistrement refusé : le fichier sur disque est invalide, l'écraser ferait perdre les modifications à la main. */
export class ConfigSaveError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(t("config.save.refused", issues[0]?.description ?? ""));
    this.name = "ConfigSaveError";
  }

  get description(): string {
    return this.message;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Texte UTF-8 strict (comme `String(contentsOf:encoding: .utf8)`), BOM compris. */
function decodeUTF8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function mtime(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Surveille un fichier via son dossier parent (écriture directe, remplacement atomique, création). */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private pending = false;

  private constructor(
    private readonly file: string,
    private readonly onChange: () => void,
    private lastStamp: number | null,
  ) {}

  /** @internal */
  static async start(file: string, onChange: () => void): Promise<FileWatcher> {
    const w = new FileWatcher(file, onChange, await mtime(file));
    try {
      w.watcher = fsWatch(path.dirname(file), () => void w.check());
      w.watcher.on("error", () => {});
    } catch {
      w.watcher = null;
    }
    // Les écritures « en place » ne modifient pas le dossier : on vérifie aussi chaque seconde.
    w.timer = setInterval(() => void w.check(), 1000);
    w.timer.unref?.();
    return w;
  }

  private async check(): Promise<void> {
    if (this.checking) {
      this.pending = true;
      return;
    }
    this.checking = true;
    try {
      do {
        this.pending = false;
        const s = await mtime(this.file);
        if (this.timer === null) return;
        if (s !== this.lastStamp) {
          this.lastStamp = s;
          this.onChange();
        }
      } while (this.pending);
    } finally {
      this.checking = false;
    }
  }

  cancel(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export class ConfigStore {
  readonly paths: CairnPaths;
  readonly file: string;
  /** Dossier choisi par l'utilisateur (`--config`) : ses droits ne sont jamais modifiés. */
  readonly chosenFolder: boolean;

  constructor(paths: CairnPaths = new CairnPaths(), file?: string, options: { chosenFolder?: boolean } = {}) {
    this.paths = paths;
    this.file = file ?? paths.config;
    this.chosenFolder = options.chosenFolder ?? false;
  }

  /**
   * `--config <fichier>` : l'état, les journaux et le verrou vivent à côté de ce fichier, dont le dossier garde ses
   * droits.
   */
  static forConfigFile(file: string): ConfigStore {
    const { paths, file: absolute } = CairnPaths.forConfigFile(file);
    return new ConfigStore(paths, absolute, { chosenFolder: true });
  }

  /** Problèmes à afficher pour une erreur de chargement (erreur de syntaxe avec sa ligne, fichier illisible…). */
  static issuesFor(error: unknown): ConfigIssue[] {
    if (error instanceof ConfigLoadError) return [error.issue];
    return [new ConfigIssue("error", "", null, errorMessage(error))];
  }

  async exists(): Promise<boolean> {
    return (await mtime(this.file)) !== null;
  }

  private async readText(): Promise<string> {
    try {
      return decodeUTF8(await readFile(this.file));
    } catch (error) {
      throw ConfigLoadError.unreadable(errorMessage(error));
    }
  }

  /** Charge le fichier. Un fichier d'une version antérieure est migré, avec une copie `config.toml.bak`. */
  async load(): Promise<LoadedConfig> {
    const text = await this.readText();
    let doc: TOMLDocument;
    try {
      doc = TOMLDocument.parse(text);
    } catch (e) {
      if (e instanceof TOMLError) throw ConfigLoadError.syntax(e);
      throw e;
    }

    let migrated = false;
    if (configVersion(doc) < CONFIG_VERSION) {
      const bak = `${this.file}.bak`;
      await rm(bak, { force: true, recursive: true });
      await copyFile(this.file, bak);
      migrateConfig(doc);
      await this.write(doc);
      migrated = true;
    }
    try {
      const { config, issues } = decodeConfig(doc);
      return { config, issues, document: doc, migrated, hasErrors: issues.some((i) => i.severity === "error") };
    } catch (e) {
      if (e instanceof TOMLError) throw ConfigLoadError.syntax(e);
      throw e;
    }
  }

  /**
   * Enregistre la configuration en réécrivant le document existant (commentaires conservés).
   * Refuse (`ConfigSaveError`) si le fichier sur disque contient une erreur : la configuration en mémoire est
   * alors la dernière valide, et l'appliquer écraserait ce que l'utilisateur est en train de corriger à la main.
   */
  async save(config: CairnConfig): Promise<void> {
    let doc: TOMLDocument;
    if (await this.exists()) {
      let text: string;
      try {
        text = await this.readText();
      } catch (e) {
        throw new ConfigSaveError(ConfigStore.issuesFor(e));
      }
      let errors: ConfigIssue[];
      try {
        doc = TOMLDocument.parse(text);
        errors = decodeConfig(doc).issues.filter((i) => i.severity === "error");
      } catch (e) {
        if (e instanceof TOMLError) throw new ConfigSaveError([ConfigLoadError.syntax(e).issue]);
        throw e;
      }
      if (errors.length > 0) throw new ConfigSaveError(errors);
      applyConfig(config, doc);
    } else {
      doc = newConfigDocument(config);
    }
    await this.write(doc);
  }

  /** Écriture atomique (fichier temporaire puis `rename`) ; crée `~/.cairn` (700) si besoin. */
  async write(doc: TOMLDocument): Promise<void> {
    await this.ensureDirectory();
    const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(tmp, doc.render(), { encoding: "utf8", flag: "wx" });
      // Les droits d'un fichier existant sont gardés.
      try {
        await chmod(tmp, (await stat(this.file)).mode & 0o7777);
      } catch {
        // fichier absent : droits par défaut
      }
      await rename(tmp, this.file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /**
   * Crée le dossier du fichier : `~/.cairn` (700, avec `logs/` et `state/`), ou le dossier de `--config` (créé en 700
   * s'il manque, laissé tel quel s'il existe).
   */
  async ensureDirectory(): Promise<void> {
    const dir = path.dirname(this.file);
    if (path.resolve(dir) !== path.resolve(this.paths.root)) await mkdir(dir, { recursive: true });
    else if (this.chosenFolder) await this.paths.prepare(dir);
    else await this.paths.ensure();
  }

  /** Surveille le fichier (y compris les remplacements atomiques des éditeurs) et appelle `onChange`. */
  async watch(onChange: () => void): Promise<FileWatcher> {
    // Le dossier doit exister (et être en 700) avant d'être surveillé.
    try {
      await this.ensureDirectory();
    } catch {
      // surveillance par sondage seulement
    }
    return FileWatcher.start(this.file, onChange);
  }
}
