// Règles d'affichage de l'écran Sauvegardes, sans React : textes de la progression (spec `backup` modifiée), état
// d'une destination dans la sidebar, dates. Tout texte passe par t().
import type {
  BackupPhase,
  CopyProgress,
  DestinationProgress,
  FinishStepProgress,
} from "../../../core/backup/progress.ts";
import type { Retention } from "../../../core/config.ts";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot, BackupResultView, DestinationView } from "../../../shared/contract.ts";

/** Date reçue par l'IPC (Date clonée) ou en millisecondes. */
export function toDate(value: Date | number | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(value: Date | number | string | null | undefined): string | null {
  const d = toDate(value);
  return d ? Fmt.date(d) : null;
}

/** Nom affiché d'une destination par son identifiant. */
export function labelOf(snapshot: AppSnapshot, id: string): string {
  return snapshot.destinations.find((d) => d.id === id)?.label ?? id;
}

/** Adresse lisible : `smb://…` ou chemin. */
export function addressOf(d: DestinationView): string {
  return d.config.provider === "smb" ? (d.config.url ?? d.id) : (d.config.path ?? d.id);
}

export type Reachability = "notChecked" | "reachable" | "waiting";

export function reachability(d: DestinationView): Reachability {
  if (d.waiting || d.reachable === false) return "waiting";
  if (d.reachable === true) return "reachable";
  return "notChecked";
}

/** Pastille de la sidebar : gris non vérifiée, vert joignable, orange en attente. */
export function reachabilityDot(r: Reachability): string {
  return r === "reachable" ? "var(--status-ok)" : r === "waiting" ? "var(--status-attention)" : "var(--status-unknown)";
}

export function reachabilityLabel(r: Reachability): string {
  return t(`backup.ui.badge.${r === "notChecked" ? "not_checked" : r}`);
}

/** Avancement de la destination (0 à 1) pour l'anneau, `undefined` s'il est inconnu (roue). */
export function progressFraction(p: DestinationProgress): number | undefined {
  if (p.phase === "done") return 1;
  if (p.phase === "finishing") {
    const running = p.finishing?.find((s) => s.status === "running");
    return running?.percent !== null && running?.percent !== undefined ? running.percent / 100 : undefined;
  }
  if ((p.phase === "copying" || p.phase === "counting") && p.copy?.percent !== null && p.copy?.percent !== undefined)
    return p.copy.percent / 100;
  return undefined;
}

/** Destination en cours (pas encore de résultat). */
export function isActive(p: DestinationProgress): boolean {
  return p.result === null;
}

/** Phases affichées sur la carte, dans l'ordre (le comptage tourne en même temps que la copie). */
export const SHOWN_PHASES = ["preparing", "counting", "copying", "finishing", "done"] as const;
export type ShownPhase = (typeof SHOWN_PHASES)[number];

/** État de chaque phase affichée : faite, en cours ou à venir. */
export function phaseStates(p: DestinationProgress): Record<ShownPhase, "done" | "current" | "todo"> {
  const counting = p.counting !== null && !p.counting.done;
  const copying = p.copy !== null && p.finishing === null && p.result === null;
  const finished = p.result !== null;
  const after = (phase: ShownPhase) => {
    switch (phase) {
      case "preparing":
        return p.counting !== null || p.copy !== null || p.finishing !== null || finished;
      case "counting":
        return p.counting?.done === true;
      case "copying":
        return p.finishing !== null || (finished && p.copy !== null);
      case "finishing":
        return finished && p.finishing !== null && p.result?.status === "succeeded";
      case "done":
        return p.result?.status === "succeeded";
    }
  };
  const current = (phase: ShownPhase) => {
    switch (phase) {
      case "preparing":
        return p.phase === "preparing";
      case "counting":
        return counting;
      case "copying":
        return copying;
      case "finishing":
        return p.phase === "finishing";
      case "done":
        return false;
    }
  };
  const out = {} as Record<ShownPhase, "done" | "current" | "todo">;
  for (const phase of SHOWN_PHASES) out[phase] = after(phase) ? "done" : current(phase) ? "current" : "todo";
  return out;
}

/** Titre de la carte selon la phase. */
export function progressTitle(p: DestinationProgress): string {
  const dry = p.dryRun;
  switch (p.phase as BackupPhase) {
    case "waiting":
    case "preparing":
      return t("backup.progress.preparing_title");
    case "counting":
    case "copying":
      return dry ? t("backup.ui.title.simulating") : t("backup.progress.title");
    case "finishing":
      return t("backup.progress.finishing_title");
    case "done":
      return dry ? t("backup.ui.title.simulation_done") : t("backup.ui.title.done");
    case "failed":
      return t("backup.ui.title.failed");
    case "stopped":
      return t("backup.ui.title.stopped");
  }
}

/** Résumé chiffré de la copie (13, chiffres tabulaires). */
export function copySummary(p: DestinationProgress): string | null {
  const c = p.copy;
  if (!c) return null;
  if (c.expected !== null)
    return t("backup.progress.files", Fmt.count(c.processed), Fmt.count(c.expected), Fmt.bytes(c.bytes));
  return t("backup.progress.counting", Fmt.count(c.processed), Fmt.count(p.counting?.found ?? 0));
}

/** « Partie 1 sur 3 : folders/workspaces ». */
export function partLine(c: CopyProgress): string {
  if (c.partCount > 1) return t("backup.ui.part_of", c.partIndex, c.partCount, c.part);
  return t("backup.progress.part", c.part);
}

/** Ligne « Copie » : dossier n sur N. */
export function copyRowLabel(c: CopyProgress): string {
  if (c.folderCount <= 1 && c.folderName === null) return t("backup.worker.copy");
  return t("backup.worker.copy_chunk", c.folderIndex, c.folderCount, c.folderName ?? t("backup.worker.root_files"));
}

/** Détail de la ligne « Copie » : fichier courant, ou liste en cours depuis N secondes. */
export function copyRowDetail(c: CopyProgress, now: number): string {
  if (c.listing) {
    if (c.listingSince === null) return t("backup.ui.listing_short");
    return t("backup.ui.listing", Fmt.duration(Math.max(0, (now - c.listingSince) / 1000)));
  }
  return c.current || t("backup.ui.listing_short");
}

/** Ligne « Comptage des fichiers » (visible pendant tout le comptage, total connu ou non). */
export function countingLine(p: DestinationProgress): string | null {
  const c = p.counting;
  if (!c || c.done) return null;
  if (c.knownTotal !== null) return t("backup.ui.counting_known", Fmt.count(c.found), Fmt.count(c.knownTotal));
  return t("backup.ui.counting", Fmt.count(c.found));
}

export function counterLabel(index: number, folder: string, found: number): string {
  return folder
    ? t("backup.ui.counter_folder", index + 1, folder, Fmt.count(found))
    : t("backup.ui.counter", index + 1, Fmt.count(found));
}

/** Texte d'une étape de finalisation. */
export function finishStepLabel(s: FinishStepProgress): string {
  switch (s.id) {
    case "listing":
      return t("backup.finish.listing");
    case "checksums":
      return s.done !== null && s.total !== null
        ? t("backup.ui.finish.checksums_count", Fmt.count(s.done), Fmt.count(s.total))
        : t("backup.ui.finish.checksums");
    case "version":
      return t("backup.finish.version");
    case "sample":
      return t("backup.finish.verify");
    case "image":
      return t("backup.ui.finish.image");
    case "compact":
      return t("backup.ui.finish.compact");
    case "close":
      return t("backup.finish.close");
  }
}

/** Résultat d'une destination : celui de la progression en cours, sinon celui de la dernière exécution. */
export interface ShownResult {
  destination: string;
  dryRun: boolean;
  status: "succeeded" | "failed" | "stopped" | "waiting";
  version: string | null;
  error: string | null;
  warnings: string[];
  filesTransferred: number;
  bytesTransferred: number;
  damagedFiles: string[];
  imageCheck: { ok: boolean; output: string } | null;
  log: string | null;
  /** Volume par partie (`folders/<nom>`, `home`, `ai/<outil>/<catégorie>`, `tools`) ; vide s'il est inconnu. */
  bytesByPart: Record<string, number>;
}

function fromLast(r: BackupResultView, dryRun: boolean): ShownResult {
  return {
    destination: r.destination,
    dryRun,
    status: r.waiting ? "waiting" : r.stopped ? "stopped" : r.error ? "failed" : "succeeded",
    version: r.version,
    error: r.error,
    warnings: [],
    filesTransferred: r.filesTransferred,
    bytesTransferred: r.bytesTransferred,
    damagedFiles: r.damagedFiles,
    imageCheck: r.imageCheck ? { ok: r.imageCheck.ok, output: r.imageCheck.output } : null,
    log: r.log,
    bytesByPart: r.bytesByPart,
  };
}

export function resultFor(snapshot: AppSnapshot, id: string): ShownResult | null {
  const p = snapshot.backup.destinations.find((x) => x.destination === id);
  const last = snapshot.backup.lastResults?.find((r) => r.destination === id);
  if (p?.result) return { destination: id, dryRun: p.dryRun, ...p.result, bytesByPart: last?.bytesByPart ?? {} };
  return last ? fromLast(last, snapshot.backup.dryRun) : null;
}

/** Bornes et défauts de la rétention (mêmes que `config.toml`). */
export const RETENTION_LIMITS = { count: [1, 520], days: [0, 3650], weeks: [0, 520] } as const;
export const RECOMMENDED = { mode: "tiered", days: 30, weeks: 48 } as const satisfies Retention;

export type RetentionChoice = "recommended" | "count" | "custom";

export function retentionChoice(r: Retention): RetentionChoice {
  if (r.mode === "count") return "count";
  return r.days === RECOMMENDED.days && r.weeks === RECOMMENDED.weeks ? "recommended" : "custom";
}

export function sameRetention(a: Retention, b: Retention): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "count" && b.mode === "count") return a.count === b.count;
  return a.mode === "tiered" && b.mode === "tiered" && a.days === b.days && a.weeks === b.weeks;
}

/** « Environ 1 an d'historique, 78 versions au plus. » */
export function retentionCoverage(r: Retention): string {
  if (r.mode === "count") return t("backup.ui.retention.count_coverage", r.count);
  const days = r.days + r.weeks * 7;
  const span =
    days >= 365 ? t("backup.retention.years", Fmt.number(days / 365, 1)) : t("backup.retention.days_n", days);
  return t("backup.retention.coverage", span, r.days + r.weeks);
}

/** Le home sauvegardé contient des secrets (~/.ssh, ~/.aws…). */
export function homeHasSecrets(include: readonly string[]): boolean {
  return include.some((p) => /^\.(ssh|aws|gnupg|kube|docker|netrc)(\/|$)/.test(p.replace(/^~\//, "")));
}

/** Volume par partie regroupé pour l'affichage : un dossier, le home, un outil IA, les outils CLI ; du plus gros au
 *  plus petit. `aiName` donne le nom d'un outil IA. */
export function partVolumes(
  bytesByPart: Record<string, number>,
  aiName: (id: string) => string,
): { key: string; label: string; bytes: number }[] {
  const groups = new Map<string, { label: string; bytes: number }>();
  for (const [part, bytes] of Object.entries(bytesByPart)) {
    const [head, name] = part.split("/");
    const key = head === "ai" || head === "folders" ? `${head}/${name ?? ""}` : (head ?? part);
    const label =
      head === "folders"
        ? (name ?? part)
        : head === "ai"
          ? aiName(name ?? "")
          : head === "home"
            ? t("restore.ui.part.home")
            : head === "tools"
              ? t("restore.part.tools")
              : part;
    const g = groups.get(key) ?? { label, bytes: 0 };
    g.bytes += bytes;
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => ({ key, ...g })).sort((a, b) => b.bytes - a.bytes);
}
