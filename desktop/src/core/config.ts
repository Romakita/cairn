// Configuration de Cairn (`~/.cairn/config.toml`, schéma v1) : modèle, lecture validée, écriture sans perte et
// migration v0 (port de Config.swift).
import { existsSync } from "node:fs";
import { t } from "./l10n.ts";
import { expandTilde } from "./paths.ts";
import {
  asArray,
  asInlineTable,
  asInteger,
  asString,
  TOML,
  TOMLDocument,
  type TOMLTable,
  type TOMLValue,
  typeName,
} from "./toml.ts";

export const CONFIG_VERSION = 1;

export const AI_CATEGORIES = ["conversations", "config", "memories", "credentials"] as const;
export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export const PROVIDERS = ["local", "smb"] as const;
export const FREQUENCIES = ["daily", "weekly", "manual"] as const;

export type Provider = (typeof PROVIDERS)[number];
export type Frequency = (typeof FREQUENCIES)[number];

export interface AnalysisConfig {
  bigFileThresholdMB: number;
  bigFolderThresholdGB: number;
}

export interface FolderConfig {
  path: string;
  backup: boolean;
  exclude: string[];
}

export interface HomeConfig {
  include: string[];
  exclude: string[];
}

export interface AIToolConfig {
  id: string;
  categories: string[];
}

export type Retention = { mode: "tiered"; days: number; weeks: number } | { mode: "count"; count: number };

export const RECOMMENDED_RETENTION: Retention = { mode: "tiered", days: 30, weeks: 48 };

export interface DestinationConfig {
  id: string;
  provider: Provider;
  path?: string;
  url?: string;
  username?: string;
  /**
   * Ancienne clé, lue et conservée sans être utilisée : le mot de passe d'un NAS est le mot de passe Internet
   * du Trousseau pour l'hôte de `url` et `username` (celui du Finder s'il existe). Cairn ne l'écrit plus.
   */
  keychain?: string;
  encrypted: boolean;
  retention: Retention;
}

export interface ScheduleConfig {
  frequency: Frequency;
  time: string;
  weekday: string;
  background: boolean;
  onBatteryMinPercent: number;
}

export interface AlertsConfig {
  lowPercent: number;
  lowGB: number;
  criticalPercent: number;
  criticalGB: number;
}

export interface GitConfig {
  fetchBefore: boolean;
  gc: boolean;
  worktreeStaleDays: number;
}

export interface CairnConfig {
  version: number;
  language: string;
  analysis: AnalysisConfig;
  folders: FolderConfig[];
  home: HomeConfig;
  ai: AIToolConfig[];
  destinations: DestinationConfig[];
  schedule: ScheduleConfig;
  alerts: AlertsConfig;
  logRetentionDays: number;
  /** Recherche automatique des mises à jour de l'app (`[updates] check`). */
  checkUpdates: boolean;
  git: GitConfig;
  excludedTools: string[];
}

/** Configuration par défaut (valeurs de la 0.8.0). */
export function defaultConfig(): CairnConfig {
  return {
    version: CONFIG_VERSION,
    language: "auto",
    analysis: { bigFileThresholdMB: 50, bigFolderThresholdGB: 1.0 },
    folders: [],
    home: { include: [], exclude: [] },
    ai: [],
    destinations: [],
    schedule: { frequency: "daily", time: "12:30", weekday: "monday", background: false, onBatteryMinPercent: 20 },
    alerts: { lowPercent: 10.0, lowGB: 20.0, criticalPercent: 5.0, criticalGB: 5.0 },
    logRetentionDays: 90,
    checkUpdates: true,
    git: { fetchBefore: false, gc: true, worktreeStaleDays: 30 },
    excludedTools: [],
  };
}

export function folder(path: string, options: { backup?: boolean; exclude?: string[] } = {}): FolderConfig {
  return { path, backup: options.backup ?? true, exclude: options.exclude ?? [] };
}

export function destination(
  id: string,
  provider: Provider,
  options: Partial<Omit<DestinationConfig, "id" | "provider">> = {},
): DestinationConfig {
  return {
    id,
    provider,
    ...options,
    encrypted: options.encrypted ?? true,
    retention: options.retention ?? RECOMMENDED_RETENTION,
  };
}

/** Chemin avec `~` développé. */
export function folderExpandedPath(f: FolderConfig): string {
  return expandTilde(f.path);
}

/** Le dossier existe (volume monté, dossier présent). */
export function folderIsAvailable(f: FolderConfig): boolean {
  return existsSync(folderExpandedPath(f));
}

/** Langue acceptée par `language` (en plus de `auto`), comme `AppLanguage.parse`. */
function isLanguage(value: string): boolean {
  return ["en", "en-us", "en_us", "fr", "fr-fr", "fr_fr"].includes(value.toLowerCase());
}

// MARK: Problèmes

export type Severity = "error" | "warning";

/** Problème trouvé dans `config.toml`. */
export class ConfigIssue {
  constructor(
    readonly severity: Severity,
    readonly key: string,
    readonly line: number | null,
    readonly message: string,
  ) {}

  get description(): string {
    const where = this.line !== null ? t("config.issue.line", this.line) : "";
    // Clé vide : problème qui concerne tout le fichier (syntaxe, lecture).
    const what = this.key === "" ? this.message : `${this.key}: ${this.message}`;
    return `${this.severity === "error" ? t("config.issue.error") : t("config.issue.warning")} ${where}${what}`;
  }

  toString(): string {
    return this.description;
  }
}

// MARK: Lecture

/** Lecture typée qui accumule les problèmes. */
class Reader {
  readonly issues: ConfigIssue[] = [];

  error(key: string, line: number | null | undefined, message: string): void {
    this.issues.push(new ConfigIssue("error", key, line ?? null, message));
  }

  warning(key: string, line: number | null | undefined, message: string): void {
    this.issues.push(new ConfigIssue("warning", key, line ?? null, message));
  }

  /** Clés inconnues : conservées dans le fichier, signalées en avertissement. */
  known(tbl: TOMLTable, prefix: string, keys: readonly string[]): void {
    for (const k of tbl.keys) {
      if (keys.includes(k)) continue;
      this.warning(
        prefix === "" ? k : `${prefix}.${k}`,
        tbl.valueLine(k) ?? tbl.table(k)?.line,
        t("config.issue.unknown_key"),
      );
    }
  }

  private typed<T>(
    tbl: TOMLTable,
    k: string,
    key: string | undefined,
    type: string,
    get: (v: TOMLValue) => T | undefined,
  ): T | undefined {
    const v = tbl.value(k);
    if (v === undefined) {
      if (tbl.get(k) !== undefined) this.error(key ?? k, tbl.table(k)?.line, t("config.issue.type", type));
      return undefined;
    }
    const x = get(v);
    if (x === undefined) {
      this.error(key ?? k, tbl.valueLine(k), t("config.issue.type_found", type, typeName(v)));
      return undefined;
    }
    return x;
  }

  string(tbl: TOMLTable, k: string, key?: string): string | undefined {
    return this.typed(tbl, k, key, "string", (v) => (v.type === "string" ? v.value : undefined));
  }

  bool(tbl: TOMLTable, k: string, key?: string): boolean | undefined {
    return this.typed(tbl, k, key, "boolean", (v) => (v.type === "bool" ? v.value : undefined));
  }

  int(tbl: TOMLTable, k: string, key?: string): number | undefined {
    return this.typed(tbl, k, key, "integer", (v) => (v.type === "integer" ? v.value : undefined));
  }

  double(tbl: TOMLTable, k: string, key?: string): number | undefined {
    return this.typed(tbl, k, key, "number", (v) =>
      v.type === "double" || v.type === "integer" ? v.value : undefined,
    );
  }

  strings(tbl: TOMLTable, k: string, key?: string): string[] | undefined {
    return this.typed(tbl, k, key, "array of strings", (v) => {
      const a = asArray(v);
      if (!a) return undefined;
      const s = a.flatMap((x) => (x.type === "string" ? [x.value] : []));
      return s.length === a.length ? s : undefined;
    });
  }

  table(tbl: TOMLTable, k: string): TOMLTable | undefined {
    if (tbl.get(k) !== undefined && !tbl.table(k)) this.error(k, tbl.valueLine(k), t("config.issue.type", "table"));
    return tbl.table(k);
  }

  retention(v: TOMLValue, key: string, line: number | null): Retention | undefined {
    const pairs = asInlineTable(v);
    if (!pairs) {
      this.error(key, line, t("config.issue.type_found", "table", typeName(v)));
      return undefined;
    }
    // Première occurrence d'une clé (`uniquingKeysWith: { a, _ in a }`).
    const d = new Map<string, TOMLValue>();
    for (const [k, x] of pairs) if (!d.has(k)) d.set(k, x);
    switch (asString(d.get("mode"))) {
      case "tiered": {
        const days = asInteger(d.get("days")) ?? 30;
        const weeks = asInteger(d.get("weeks")) ?? 48;
        if (!(days >= 0 && days <= 3650 && weeks >= 0 && weeks <= 520 && days + weeks > 0)) {
          this.error(key, line, t("config.issue.retention"));
          return undefined;
        }
        return { mode: "tiered", days, weeks };
      }
      case "count": {
        const n = asInteger(d.get("count")) ?? 0;
        if (!(n >= 1 && n <= 520)) {
          this.error(key, line, t("config.issue.range", 1, 520));
          return undefined;
        }
        return { mode: "count", count: n };
      }
      default:
        this.error(key, line, t("config.issue.enum", "tiered, count"));
        return undefined;
    }
  }
}

/** Décode un document ; les erreurs de syntaxe TOML sont levées (`TOMLError`), celles de schéma renvoyées. */
export function decodeConfig(doc: TOMLDocument): { config: CairnConfig; issues: ConfigIssue[] } {
  const tree = doc.tree();
  const r = new Reader();
  const c = defaultConfig();

  r.known(tree, "", [
    "version",
    "language",
    "analysis",
    "folders",
    "home",
    "ai",
    "destinations",
    "schedule",
    "alerts",
    "logs",
    "git",
    "tools",
    "updates",
  ]);
  c.version = r.int(tree, "version") ?? 0;
  if (c.version > CONFIG_VERSION) {
    r.error("version", tree.valueLine("version"), t("config.issue.version_unsupported", c.version));
  }
  const lang = r.string(tree, "language");
  if (lang !== undefined) {
    if (lang === "auto" || isLanguage(lang)) c.language = lang;
    else r.error("language", tree.valueLine("language"), t("config.issue.enum", "auto, en-US, fr-FR"));
  }

  const analysis = r.table(tree, "analysis");
  if (analysis) {
    r.known(analysis, "analysis", ["big_file_threshold_mb", "big_folder_threshold_gb"]);
    const mb = r.int(analysis, "big_file_threshold_mb", "analysis.big_file_threshold_mb");
    if (mb !== undefined) {
      if (mb > 0) c.analysis.bigFileThresholdMB = mb;
      else
        r.error(
          "analysis.big_file_threshold_mb",
          analysis.valueLine("big_file_threshold_mb"),
          t("config.issue.positive"),
        );
    }
    const gb = r.double(analysis, "big_folder_threshold_gb", "analysis.big_folder_threshold_gb");
    if (gb !== undefined) {
      if (gb > 0) c.analysis.bigFolderThresholdGB = gb;
      else
        r.error(
          "analysis.big_folder_threshold_gb",
          analysis.valueLine("big_folder_threshold_gb"),
          t("config.issue.positive"),
        );
    }
  }

  for (const [i, f] of tree.tables("folders").entries()) {
    const k = `folders[${i}]`;
    r.known(f, k, ["path", "backup", "exclude"]);
    const p = r.string(f, "path", `${k}.path`);
    if (p === undefined || p === "") {
      r.error(`${k}.path`, f.line, t("config.issue.required"));
      continue;
    }
    const entry = folder(p, {
      backup: r.bool(f, "backup", `${k}.backup`) ?? true,
      exclude: r.strings(f, "exclude", `${k}.exclude`) ?? [],
    });
    if (!folderIsAvailable(entry)) r.warning(`${k}.path`, f.valueLine("path"), t("config.issue.folder_unavailable", p));
    c.folders.push(entry);
  }

  const home = r.table(tree, "home");
  if (home) {
    r.known(home, "home", ["include", "exclude"]);
    c.home.include = r.strings(home, "include", "home.include") ?? [];
    c.home.exclude = r.strings(home, "exclude", "home.exclude") ?? [];
  }

  const ai = r.table(tree, "ai");
  if (ai) {
    for (const id of ai.keys) {
      const tool = ai.table(id);
      if (!tool) {
        r.error(`ai.${id}`, null, t("config.issue.type", "table"));
        continue;
      }
      r.known(tool, `ai.${id}`, ["categories"]);
      const cats = r.strings(tool, "categories", `ai.${id}.categories`) ?? [];
      for (const cat of cats) {
        if ((AI_CATEGORIES as readonly string[]).includes(cat)) continue;
        r.error(`ai.${id}.categories`, tool.valueLine("categories"), t("config.issue.enum", AI_CATEGORIES.join(", ")));
      }
      c.ai.push({ id, categories: cats });
    }
  }

  const ids = new Set<string>();
  for (const [i, d] of tree.tables("destinations").entries()) {
    const k = `destinations[${i}]`;
    r.known(d, k, ["id", "provider", "path", "url", "username", "keychain", "encrypted", "retention"]);
    const id = r.string(d, "id", `${k}.id`);
    if (id === undefined || id === "") {
      r.error(`${k}.id`, d.line, t("config.issue.required"));
      continue;
    }
    if (ids.has(id)) r.error(`${k}.id`, d.valueLine("id"), t("config.issue.duplicate", id));
    ids.add(id);
    const ps = r.string(d, "provider", `${k}.provider`);
    if (ps === undefined || !(PROVIDERS as readonly string[]).includes(ps)) {
      r.error(`${k}.provider`, d.valueLine("provider") ?? d.line, t("config.issue.enum", "local, smb"));
      continue;
    }
    const provider = ps as Provider;
    const dest = destination(id, provider);
    const optional = (key: "path" | "url" | "username" | "keychain") => {
      const v = r.string(d, key, `${k}.${key}`);
      if (v !== undefined) dest[key] = v;
    };
    optional("path");
    optional("url");
    optional("username");
    optional("keychain");
    dest.encrypted = r.bool(d, "encrypted", `${k}.encrypted`) ?? true;
    if (provider === "local" && (dest.path ?? "") === "") {
      r.error(`${k}.path`, d.line, t("config.issue.required"));
    } else if (provider === "smb" && !(dest.url ?? "").toLowerCase().startsWith("smb://")) {
      r.error(`${k}.url`, d.valueLine("url") ?? d.line, t("config.issue.smb_url"));
    }
    const ret = d.value("retention");
    if (ret !== undefined) {
      dest.retention = r.retention(ret, `${k}.retention`, d.valueLine("retention")) ?? RECOMMENDED_RETENTION;
    }
    c.destinations.push(dest);
  }

  const s = r.table(tree, "schedule");
  if (s) {
    r.known(s, "schedule", ["frequency", "time", "weekday", "background", "on_battery_min_percent"]);
    const f = r.string(s, "frequency", "schedule.frequency");
    if (f !== undefined) {
      if ((FREQUENCIES as readonly string[]).includes(f)) c.schedule.frequency = f as Frequency;
      else r.error("schedule.frequency", s.valueLine("frequency"), t("config.issue.enum", "daily, weekly, manual"));
    }
    const time = r.string(s, "time", "schedule.time");
    if (time !== undefined) {
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) c.schedule.time = time;
      else r.error("schedule.time", s.valueLine("time"), t("config.issue.time"));
    }
    const wd = r.string(s, "weekday", "schedule.weekday");
    if (wd !== undefined) {
      if ((WEEKDAYS as readonly string[]).includes(wd)) c.schedule.weekday = wd;
      else r.error("schedule.weekday", s.valueLine("weekday"), t("config.issue.enum", WEEKDAYS.join(", ")));
    }
    c.schedule.background = r.bool(s, "background", "schedule.background") ?? false;
    const p = r.int(s, "on_battery_min_percent", "schedule.on_battery_min_percent");
    if (p !== undefined) {
      if (p >= 0 && p <= 100) c.schedule.onBatteryMinPercent = p;
      else
        r.error(
          "schedule.on_battery_min_percent",
          s.valueLine("on_battery_min_percent"),
          t("config.issue.range", 0, 100),
        );
    }
  }

  const a = r.table(tree, "alerts");
  if (a) {
    r.known(a, "alerts", ["low_percent", "low_gb", "critical_percent", "critical_gb"]);
    c.alerts.lowPercent = r.double(a, "low_percent", "alerts.low_percent") ?? c.alerts.lowPercent;
    c.alerts.lowGB = r.double(a, "low_gb", "alerts.low_gb") ?? c.alerts.lowGB;
    c.alerts.criticalPercent = r.double(a, "critical_percent", "alerts.critical_percent") ?? c.alerts.criticalPercent;
    c.alerts.criticalGB = r.double(a, "critical_gb", "alerts.critical_gb") ?? c.alerts.criticalGB;
    if (c.alerts.criticalPercent > c.alerts.lowPercent || c.alerts.criticalGB > c.alerts.lowGB) {
      r.error("alerts", a.line, t("config.issue.alerts_order"));
    }
  }

  const logs = r.table(tree, "logs");
  if (logs) {
    r.known(logs, "logs", ["retention_days"]);
    const d = r.int(logs, "retention_days", "logs.retention_days");
    if (d !== undefined) {
      if (d >= 1) c.logRetentionDays = d;
      else r.error("logs.retention_days", logs.valueLine("retention_days"), t("config.issue.positive"));
    }
  }

  const updates = r.table(tree, "updates");
  if (updates) {
    r.known(updates, "updates", ["check"]);
    c.checkUpdates = r.bool(updates, "check", "updates.check") ?? true;
  }

  const g = r.table(tree, "git");
  if (g) {
    r.known(g, "git", ["fetch_before", "gc", "worktree_stale_days"]);
    c.git.fetchBefore = r.bool(g, "fetch_before", "git.fetch_before") ?? false;
    c.git.gc = r.bool(g, "gc", "git.gc") ?? true;
    const d = r.int(g, "worktree_stale_days", "git.worktree_stale_days");
    if (d !== undefined) {
      if (d >= 1) c.git.worktreeStaleDays = d;
      else r.error("git.worktree_stale_days", g.valueLine("worktree_stale_days"), t("config.issue.positive"));
    }
  }

  const tools = r.table(tree, "tools");
  if (tools) {
    r.known(tools, "tools", ["excluded"]);
    c.excludedTools = r.strings(tools, "excluded", "tools.excluded") ?? [];
  }

  return { config: c, issues: r.issues };
}

// MARK: Écriture

const strings = (values: string[]): TOMLValue => TOML.array(values.map(TOML.string));

export function renderRetention(r: Retention): TOMLValue {
  return r.mode === "tiered"
    ? TOML.inlineTable([
        ["mode", TOML.string("tiered")],
        ["days", TOML.integer(r.days)],
        ["weeks", TOML.integer(r.weeks)],
      ])
    : TOML.inlineTable([
        ["mode", TOML.string("count")],
        ["count", TOML.integer(r.count)],
      ]);
}

function syncArray(doc: TOMLDocument, path: string[], count: number): void {
  while (doc.arrayTableCount(path) > count) doc.removeArrayTable(path, doc.arrayTableCount(path) - 1);
  while (doc.arrayTableCount(path) < count) doc.appendArrayTable(path, []);
}

/** Applique la configuration au document en conservant commentaires, ordre et clés inconnues. */
export function applyConfig(c: CairnConfig, doc: TOMLDocument): void {
  doc.set(TOML.integer(c.version), ["version"]);
  doc.set(TOML.string(c.language), ["language"]);
  doc.set(TOML.integer(c.analysis.bigFileThresholdMB), ["big_file_threshold_mb"], ["analysis"]);
  doc.set(TOML.double(c.analysis.bigFolderThresholdGB), ["big_folder_threshold_gb"], ["analysis"]);

  syncArray(doc, ["folders"], c.folders.length);
  for (const [i, f] of c.folders.entries()) {
    doc.set(TOML.string(f.path), ["path"], ["folders"], i);
    doc.set(TOML.bool(f.backup), ["backup"], ["folders"], i);
    doc.set(strings(f.exclude), ["exclude"], ["folders"], i);
  }

  doc.set(strings(c.home.include), ["include"], ["home"]);
  doc.set(strings(c.home.exclude), ["exclude"], ["home"]);

  // Outil IA désélectionné : sa table `[ai.<id>]` disparaît (le reste du fichier est conservé).
  const kept = new Set(c.ai.map((x) => x.id));
  let existing: string[] = [];
  try {
    existing = [...(doc.tree().table("ai")?.keys ?? [])];
  } catch {
    existing = [];
  }
  for (const id of existing) if (!kept.has(id)) doc.removeTable(["ai", id]);
  for (const tool of c.ai) doc.set(strings(tool.categories), ["categories"], ["ai", tool.id]);

  syncArray(doc, ["destinations"], c.destinations.length);
  for (const [i, d] of c.destinations.entries()) {
    const s = ["destinations"];
    doc.set(TOML.string(d.id), ["id"], s, i);
    doc.set(TOML.string(d.provider), ["provider"], s, i);
    for (const k of ["path", "url", "username", "keychain"] as const) {
      const v = d[k];
      if (v !== undefined) doc.set(TOML.string(v), [k], s, i);
      else doc.remove([k], s, i);
    }
    doc.set(TOML.bool(d.encrypted), ["encrypted"], s, i);
    doc.set(renderRetention(d.retention), ["retention"], s, i);
  }

  doc.set(TOML.string(c.schedule.frequency), ["frequency"], ["schedule"]);
  doc.set(TOML.string(c.schedule.time), ["time"], ["schedule"]);
  doc.set(TOML.string(c.schedule.weekday), ["weekday"], ["schedule"]);
  doc.set(TOML.bool(c.schedule.background), ["background"], ["schedule"]);
  doc.set(TOML.integer(c.schedule.onBatteryMinPercent), ["on_battery_min_percent"], ["schedule"]);

  doc.set(TOML.double(c.alerts.lowPercent), ["low_percent"], ["alerts"]);
  doc.set(TOML.double(c.alerts.lowGB), ["low_gb"], ["alerts"]);
  doc.set(TOML.double(c.alerts.criticalPercent), ["critical_percent"], ["alerts"]);
  doc.set(TOML.double(c.alerts.criticalGB), ["critical_gb"], ["alerts"]);

  doc.set(TOML.integer(c.logRetentionDays), ["retention_days"], ["logs"]);

  doc.set(TOML.bool(c.checkUpdates), ["check"], ["updates"]);

  doc.set(TOML.bool(c.git.fetchBefore), ["fetch_before"], ["git"]);
  doc.set(TOML.bool(c.git.gc), ["gc"], ["git"]);
  doc.set(TOML.integer(c.git.worktreeStaleDays), ["worktree_stale_days"], ["git"]);

  doc.set(strings(c.excludedTools), ["excluded"], ["tools"]);
}

/** En-tête d'un nouveau fichier (mêmes octets que la 0.8.0). */
export const NEW_CONFIG_HEADER =
  "# Configuration de Cairn — modifiable à la main ou depuis les réglages de l'app.\n" +
  "# Les mots de passe ne sont jamais écrits ici : ils sont dans le Trousseau macOS.\n" +
  "# NAS (smb) : l'entrée du Trousseau est celle de l'hôte de `url` et de `username`.\n";

/** Nouveau fichier commenté. */
export function newConfigDocument(c: CairnConfig): TOMLDocument {
  const doc = TOMLDocument.parse(NEW_CONFIG_HEADER);
  applyConfig(c, doc);
  return doc;
}

// MARK: Migration

/** Version déclarée par le document (0 si absente). */
export function configVersion(doc: TOMLDocument): number {
  try {
    return asInteger(doc.tree().value("version")) ?? 0;
  } catch {
    return 0;
  }
}

/** Migre un document v0 (ancienne app : `root_path`, pas de `version`) vers la version courante. */
export function migrateConfig(doc: TOMLDocument): void {
  let v = configVersion(doc);
  if (v < 1) {
    let root: string | undefined;
    try {
      root = asString(doc.tree().value("root_path"));
    } catch {
      root = undefined;
    }
    if (root !== undefined) {
      doc.remove(["root_path"]);
      if (doc.arrayTableCount(["folders"]) === 0) {
        doc.appendArrayTable(
          ["folders"],
          [
            ["path", TOML.string(root)],
            ["backup", TOML.bool(true)],
          ],
        );
      }
    }
    v = 1;
  }
  doc.set(TOML.integer(v), ["version"]);
}
