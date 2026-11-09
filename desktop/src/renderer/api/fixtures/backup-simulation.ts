// Sauvegarde simulée vers deux destinations, qui avance dans le temps (secondes depuis le lancement) :
//   0 – 2 s   préparation commune (inventaire, dossiers régénérables) ;
//   2 – 10 s  « nas » : comptage, 4 compteurs visibles, la copie démarre en parallèle ; « disk » : en attente ;
//  10 – 20 s  « nas » : copie, dossier n sur N, pourcentage sur le nouveau total ;
//  20 – 30 s  « nas » : finalisation (liste, empreintes en %, version, fermeture) pendant que « disk » copie ;
//  30 – 36 s  « disk » : finalisation ; puis les deux sont terminées.
// Même modèle que le main (`DestinationProgress`, backup/progress.ts).
import type {
  CounterProgress,
  DestinationProgress,
  DestinationResultSummary,
  FinishStepId,
  FinishStepProgress,
} from "../../../core/backup/progress.ts";

export const SIMULATION_SECONDS = 36;

const FOLDERS = ["cairn", "website", "notes", "scripts", "ios-app", "api", "ml-notebooks", "docs", "infra", "talks"];
const KNOWN_TOTAL = 48_200;
const NEW_TOTAL = 48_950;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ease = (t: number) => clamp(t) * (2 - clamp(t));

function counters(progress: number): CounterProgress[] {
  // Quatre compteurs parallèles, chacun sur un dossier du premier niveau, qui avancent dans la pile.
  return [0, 1, 2, 3].map((i) => {
    const local = clamp(progress * 1.15 - i * 0.05);
    const folder = FOLDERS[Math.min(FOLDERS.length - 1, Math.floor(local * (FOLDERS.length - 1)) + (i % 3))]!;
    return {
      folder,
      found: Math.round(local * (NEW_TOTAL / 4)),
      current: `${folder}/src/components/item-${Math.round(local * 900)}.tsx`,
      done: local >= 1,
    };
  });
}

function result(dest: string, version: string, files: number, bytes: number): DestinationResultSummary {
  return {
    status: "succeeded",
    version,
    error: null,
    warnings: [],
    filesTransferred: files,
    bytesTransferred: bytes,
    deletedVersions: [],
    damagedFiles: [],
    imageCheck: null,
    log: `/Users/demo/.cairn/logs/backup-20261109-100000.log#${dest}`,
  };
}

function finishing(progress: number, steps: readonly FinishStepId[]): FinishStepProgress[] {
  const per = 1 / steps.length;
  return steps.map((id, i) => {
    const local = clamp((progress - i * per) / per);
    const status = local >= 1 ? "done" : local > 0 ? "running" : "pending";
    const withCount = id === "checksums" || id === "listing";
    return {
      id,
      status,
      done: withCount ? Math.round(local * NEW_TOTAL) : null,
      total: withCount ? NEW_TOTAL : null,
      percent: withCount ? Math.floor(local * 100) : null,
      current: status === "running" && withCount ? `cairn/desktop/src/item-${Math.round(local * 900)}.ts` : "",
    };
  });
}

function copy(progress: number, counted: boolean) {
  const expected = counted ? NEW_TOTAL : KNOWN_TOTAL;
  const processed = Math.round(ease(progress) * NEW_TOTAL);
  const folderIndex = Math.min(FOLDERS.length, Math.floor(progress * FOLDERS.length) + 1);
  return {
    part: "folders/workspaces",
    partIndex: 1,
    partCount: 3,
    folderIndex,
    folderCount: FOLDERS.length,
    folderName: FOLDERS[folderIndex - 1] ?? null,
    listing: progress < 0.03,
    listingSince: progress < 0.03 ? Date.now() : null,
    files: Math.round(processed * 0.04),
    bytes: Math.round(processed * 38_000),
    processed,
    expected,
    percent: Math.min(99, Math.floor((processed / expected) * 100)),
    current: `${FOLDERS[folderIndex - 1] ?? ""}/src/item-${processed % 997}.ts`,
  };
}

function base(destination: string): DestinationProgress {
  return {
    destination,
    dryRun: false,
    phase: "waiting",
    preparing: null,
    counting: null,
    copy: null,
    finishing: null,
    result: null,
  };
}

/** Progression de « nas » à l'instant `t` (secondes). */
function nas(t: number): DestinationProgress {
  const p = base("nas");
  if (t < 2) {
    return {
      ...p,
      phase: "preparing",
      preparing: { key: t < 1 ? "backup.prepare.tools" : "backup.prepare.generated", args: ["workspaces/cairn"] },
    };
  }
  if (t < 10) {
    const c = (t - 2) / 8;
    const found = counters(c);
    return {
      ...p,
      phase: "counting",
      counting: {
        counters: found,
        found: found.reduce((n, x) => n + x.found, 0),
        knownTotal: KNOWN_TOTAL,
        total: null,
        done: false,
      },
      copy: copy(((t - 2) / 18) * 0.45, false),
    };
  }
  const counting = { counters: counters(1), found: NEW_TOTAL, knownTotal: KNOWN_TOTAL, total: NEW_TOTAL, done: true };
  if (t < 20) {
    return { ...p, phase: "copying", counting, copy: copy(0.45 + ((t - 10) / 10) * 0.55, true) };
  }
  const steps: FinishStepId[] = ["listing", "checksums", "version", "compact"];
  if (t < 30) {
    return { ...p, phase: "finishing", counting, copy: copy(1, true), finishing: finishing((t - 20) / 10, steps) };
  }
  return {
    ...p,
    phase: "done",
    counting,
    copy: { ...copy(1, true), percent: 100 },
    finishing: finishing(1, steps),
    result: result("nas", "2026-11-09T100000", 1_958, 74_400_000),
  };
}

/** Progression de « disk » : en attente pendant la copie vers « nas », puis copie pendant sa finalisation. */
function disk(t: number): DestinationProgress {
  const p = base("disk");
  if (t < 2) return { ...p, phase: "preparing", preparing: { key: "backup.prepare.parts", args: [] } };
  if (t < 20) return p;
  const counting = { counters: counters(1), found: NEW_TOTAL, knownTotal: KNOWN_TOTAL, total: NEW_TOTAL, done: true };
  if (t < 30) return { ...p, phase: "copying", counting, copy: copy((t - 20) / 10, true) };
  const steps: FinishStepId[] = ["listing", "checksums", "version", "close"];
  if (t < SIMULATION_SECONDS) {
    return {
      ...p,
      phase: "finishing",
      counting,
      copy: copy(1, true),
      finishing: finishing((t - 30) / (SIMULATION_SECONDS - 30), steps),
    };
  }
  return {
    ...p,
    phase: "done",
    counting,
    copy: { ...copy(1, true), percent: 100 },
    finishing: finishing(1, steps),
    result: result("disk", "2026-11-09T100000", 1_958, 74_400_000),
  };
}

/** Progression des deux destinations à l'instant `t` ; `dryRun` marque une simulation. */
export function simulatedProgress(t: number, dryRun = false): DestinationProgress[] {
  return [nas(t), disk(t)].map((d) => ({ ...d, dryRun }));
}

/** La sauvegarde simulée est finie à l'instant `t`. */
export function simulationFinished(t: number): boolean {
  return t >= SIMULATION_SECONDS;
}
