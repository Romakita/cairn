// Modèle de progression d'une sauvegarde, par destination (spec `backup` modifiée, « Simulation, progression et
// journal »). Remplace `BackupProgress` de la 0.8.0, dont les compteurs disparaissaient dès qu'un total était connu.
// Le type est sérialisable (JSON pur, dates en millisecondes) : le main l'envoie tel quel à l'interface par IPC.
//
// Règles :
// - une phase par destination : waiting → preparing → counting → copying → finishing → done | failed | stopped ;
// - pendant tout le comptage (il tourne en même temps que la copie), chaque compteur reste visible (dossier pris
//   dans la pile, fichiers trouvés), que le total d'une sauvegarde précédente soit connu ou non ;
// - le pourcentage utilise le total connu jusqu'à la fin du nouveau comptage, puis le nouveau total ; il est
//   plafonné à 99 et n'atteint 100 qu'à la fin réussie ;
// - la copie indique la partie et le dossier en cours (« dossier n sur N ») ;
// - la finalisation liste ses étapes : liste, empreintes (avec %), version, échantillon, image, compactage/fermeture.

export const BACKUP_PHASES = [
  "waiting",
  "preparing",
  "counting",
  "copying",
  "finishing",
  "done",
  "failed",
  "stopped",
] as const;
export type BackupPhase = (typeof BACKUP_PHASES)[number];

/** Texte à traduire : clé de `locales/*.json` et ses arguments (`{1}`, `{2}`…). */
export interface StepText {
  key: string;
  args: Array<string | number>;
}

/** Un compteur parallèle (rsync -n) : dossier du premier niveau pris dans la pile. */
export interface CounterProgress {
  folder: string;
  found: number;
  current: string;
  done: boolean;
}

export interface CountingProgress {
  counters: CounterProgress[];
  /** Fichiers trouvés jusqu'ici, tous compteurs confondus. */
  found: number;
  /** Total d'une sauvegarde précédente (`runs.json` `fileCounts`), s'il est connu pour toutes les parties. */
  knownTotal: number | null;
  /** Total du nouveau comptage, une fois fini (`null` tant qu'il tourne ou s'il a été interrompu). */
  total: number | null;
  /** Comptage fini ou interrompu (fin de la copie). */
  done: boolean;
}

export interface CopyProgress {
  /** Partie en cours (`folders/x`, `home`…), rang à partir de 1 et nombre de parties. */
  part: string;
  partIndex: number;
  partCount: number;
  /** Dossier du premier niveau en cours : rang à partir de 1, nombre, nom (`null` : fichiers du premier niveau). */
  folderIndex: number;
  folderCount: number;
  folderName: string | null;
  /** rsync dresse la liste du dossier (aucun fichier encore vu), depuis cette date (ms). */
  listing: boolean;
  listingSince: number | null;
  /** Fichiers copiés (nouveaux ou modifiés) et leur taille, toutes parties confondues. */
  files: number;
  bytes: number;
  /** Fichiers examinés (copiés ou liés à la version précédente). */
  processed: number;
  /** Total attendu : nouveau comptage s'il est fini, sinon total connu, sinon `null`. */
  expected: number | null;
  /** 0 à 99 pendant la copie, 100 à la fin réussie ; `null` sans total. */
  percent: number | null;
  current: string;
}

export const FINISH_STEPS = ["listing", "checksums", "version", "sample", "image", "compact", "close"] as const;
export type FinishStepId = (typeof FINISH_STEPS)[number];

export interface FinishStepProgress {
  id: FinishStepId;
  status: "pending" | "running" | "done" | "skipped";
  done: number | null;
  total: number | null;
  /** Avancement de l'étape (0 à 100) quand il est connu. */
  percent: number | null;
  current: string;
}

export type DestinationStatus = "succeeded" | "failed" | "stopped" | "waiting";

/** Résultat affiché d'une destination (sans secret : le mot de passe d'une image neuve n'y figure jamais). */
export interface DestinationResultSummary {
  status: DestinationStatus;
  version: string | null;
  error: string | null;
  warnings: string[];
  filesTransferred: number;
  bytesTransferred: number;
  deletedVersions: string[];
  damagedFiles: string[];
  imageCheck: { ok: boolean; output: string } | null;
  log: string | null;
}

export interface DestinationProgress {
  destination: string;
  dryRun: boolean;
  phase: BackupPhase;
  /** Étape de préparation en cours (inventaire, dossiers régénérables, ouverture de l'image…). */
  preparing: StepText | null;
  counting: CountingProgress | null;
  copy: CopyProgress | null;
  finishing: FinishStepProgress[] | null;
  result: DestinationResultSummary | null;
}

/** Pourcentage plafonné à 99 tant que la sauvegarde n'est pas finie (l'estimation peut être courte). */
export function cappedPercent(processed: number, expected: number | null): number | null {
  if (expected === null || expected <= 0) return null;
  return Math.min(99, Math.floor((processed / expected) * 100));
}

function stepPercent(done: number | null, total: number | null): number | null {
  if (done === null || total === null || total <= 0) return null;
  return Math.min(100, Math.floor((done / total) * 100));
}

/** Phase déduite de l'état : le résultat, puis la finalisation, la copie, le comptage, la préparation. */
export function phaseOf(p: Omit<DestinationProgress, "phase">): BackupPhase {
  if (p.result) {
    switch (p.result.status) {
      case "succeeded":
        return "done";
      case "failed":
        return "failed";
      case "stopped":
        return "stopped";
      case "waiting":
        return "waiting";
    }
  }
  if (p.finishing) return "finishing";
  if (p.counting && !p.counting.done) return "counting";
  if (p.copy) return "copying";
  if (p.preparing) return "preparing";
  return "waiting";
}

export interface TrackerOptions {
  /** Intervalle minimal entre deux envois (hors changement de phase), 100 ms par défaut (10 par seconde). */
  throttleMs?: number;
  now?: () => number;
}

/** Progression d'une destination : l'état est modifié par le moteur, des instantanés sont envoyés à `emit`. */
export class DestinationTracker {
  private state: DestinationProgress;
  private lastEmit = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastPhase: BackupPhase;
  private readonly throttleMs: number;
  private readonly now: () => number;

  constructor(
    destination: string,
    dryRun: boolean,
    private readonly emit: (p: DestinationProgress) => void = () => {},
    options: TrackerOptions = {},
  ) {
    this.throttleMs = options.throttleMs ?? 100;
    this.now = options.now ?? Date.now;
    this.state = {
      destination,
      dryRun,
      phase: "waiting",
      preparing: null,
      counting: null,
      copy: null,
      finishing: null,
      result: null,
    };
    this.lastPhase = "waiting";
  }

  get destination(): string {
    return this.state.destination;
  }

  get finished(): boolean {
    return this.state.result !== null;
  }

  /** Instantané indépendant (sérialisable). */
  snapshot(): DestinationProgress {
    return structuredClone(this.state);
  }

  private changed(): void {
    this.state.phase = phaseOf(this.state);
    const phaseChanged = this.state.phase !== this.lastPhase;
    this.lastPhase = this.state.phase;
    const now = this.now();
    if (phaseChanged || now - this.lastEmit >= this.throttleMs) {
      this.send();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.send(), Math.max(0, this.throttleMs - (now - this.lastEmit)));
      this.timer.unref?.();
    }
  }

  private send(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.lastEmit = this.now();
    this.emit(this.snapshot());
  }

  /** Envoie tout de suite l'état en attente. */
  flush(): void {
    if (this.timer) this.send();
  }

  /** En attente (destination suivante d'une sauvegarde : la copie vers une autre est en cours). */
  queued(): void {
    this.state.preparing = null;
    this.changed();
  }

  preparing(step: StepText): void {
    this.state.preparing = step;
    this.changed();
  }

  /** Début du comptage (en même temps que la copie). */
  startCounting(knownTotal: number | null): void {
    this.state.preparing = null;
    this.state.counting = { counters: [], found: 0, knownTotal, total: null, done: false };
    this.updateExpected();
    this.changed();
  }

  counter(index: number, value: CounterProgress): void {
    const c = this.state.counting;
    if (!c || c.done) return;
    while (c.counters.length <= index) c.counters.push({ folder: "", found: 0, current: "", done: false });
    c.counters[index] = { ...value };
    this.changed();
  }

  found(delta: number): void {
    const c = this.state.counting;
    if (!c || c.done || delta === 0) return;
    c.found += delta;
    this.changed();
  }

  /** Fin du comptage : `total` du nouveau comptage, `null` s'il a été interrompu (copie finie avant lui). */
  countingDone(total: number | null): void {
    const c = this.state.counting;
    if (!c || c.done) return;
    c.done = true;
    c.total = total;
    this.updateExpected();
    this.changed();
  }

  private expected(): number | null {
    const c = this.state.counting;
    if (!c) return null;
    if (c.done && c.total !== null) return c.total;
    return c.knownTotal;
  }

  private updateExpected(): void {
    const copy = this.state.copy;
    if (!copy) return;
    copy.expected = this.expected();
    copy.percent = cappedPercent(copy.processed, copy.expected);
  }

  /** Avancement de la copie. */
  copy(update: Partial<Omit<CopyProgress, "expected" | "percent" | "listingSince">>): void {
    this.state.preparing = null;
    const prev = this.state.copy;
    const next: CopyProgress = {
      part: "",
      partIndex: 0,
      partCount: 0,
      folderIndex: 1,
      folderCount: 1,
      folderName: null,
      listing: false,
      listingSince: null,
      files: 0,
      bytes: 0,
      processed: 0,
      expected: null,
      percent: null,
      current: "",
      ...prev,
      ...update,
    };
    // Depuis quand rsync dresse la liste de ce dossier : gardé tant que le dossier ne change pas.
    const sameFolder = prev && prev.part === next.part && prev.folderIndex === next.folderIndex;
    next.listingSince = next.listing ? (sameFolder && prev.listing ? prev.listingSince : this.now()) : null;
    this.state.copy = next;
    this.updateExpected();
    this.changed();
  }

  /** Début de la finalisation, avec les étapes prévues. Le comptage est fini (ou interrompu). */
  beginFinishing(steps: readonly FinishStepId[]): void {
    this.countingDone(this.state.counting?.total ?? null);
    this.state.finishing = steps.map((id) => ({
      id,
      status: "pending",
      done: null,
      total: null,
      percent: null,
      current: "",
    }));
    this.changed();
  }

  /** Étape en cours (les précédentes encore en cours sont finies), avec son avancement. */
  step(id: FinishStepId, progress: { done?: number | null; total?: number | null; current?: string } = {}): void {
    if (!this.state.finishing) this.state.finishing = [];
    const steps = this.state.finishing;
    let s = steps.find((x) => x.id === id);
    if (!s) {
      s = { id, status: "pending", done: null, total: null, percent: null, current: "" };
      steps.push(s);
    }
    for (const other of steps) {
      if (other === s) break;
      if (other.status === "running" || other.status === "pending")
        other.status = other.status === "running" ? "done" : "skipped";
    }
    s.status = "running";
    if (progress.done !== undefined) s.done = progress.done;
    if (progress.total !== undefined) s.total = progress.total;
    s.current = progress.current ?? "";
    s.percent = stepPercent(s.done, s.total);
    this.changed();
  }

  /** Remplace une étape prévue (compactage → fermeture après un échec). */
  replaceStep(from: FinishStepId, to: FinishStepId): void {
    const s = this.state.finishing?.find((x) => x.id === from);
    if (s) s.id = to;
  }

  /** Destination terminée : réussie, en échec, arrêtée ou en attente (injoignable). */
  finish(result: DestinationResultSummary): void {
    if (this.state.finishing) {
      for (const s of this.state.finishing) {
        if (s.status === "running") s.status = result.status === "succeeded" ? "done" : "skipped";
        else if (s.status === "pending") s.status = "skipped";
      }
    }
    if (this.state.counting && !this.state.counting.done) this.state.counting.done = true;
    if (result.status === "succeeded" && this.state.copy) this.state.copy.percent = 100;
    this.state.preparing = null;
    this.state.result = structuredClone(result);
    this.changed();
    this.flush();
  }
}

/** Résumé vide (destination passée, injoignable…). */
export function emptyResult(
  status: DestinationStatus,
  extra: Partial<DestinationResultSummary> = {},
): DestinationResultSummary {
  return {
    status,
    version: null,
    error: null,
    warnings: [],
    filesTransferred: 0,
    bytesTransferred: 0,
    deletedVersions: [],
    damagedFiles: [],
    imageCheck: null,
    log: null,
    ...extra,
  };
}
