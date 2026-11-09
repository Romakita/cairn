// Tour du planificateur (port de `BackupController.tick` et `notifyOverdue`, sans l'app) : destinations dues, en
// attente, et notices de retard. Le main l'appelle toutes les 60 s, au réveil, au montage d'un volume et au
// changement de réseau ; il fournit la joignabilité, l'alimentation et l'accès à `runs.json`.
import {
  type DestinationRunState,
  emptyDestinationState,
  loadRunState,
  type RunStatePaths,
  saveRunState,
} from "../backup/run-state.ts";
import type { ScheduleConfig } from "../config.ts";
import { type Calendar, localCalendar } from "./calendar.ts";
import { decide, type Power, type ScheduleDecision, shouldNotifyOverdue } from "./schedule.ts";

/** Champs de `runs.json` lus ou écrits ici (le modèle complet `RunState` est celui de `src/core/backup`). */
export interface ScheduleRunFields {
  lastSuccess?: Date | null;
  lastFailure?: Date | null;
  lastOverdueNotice?: Date;
}

/** Vue modifiable de `runs.json` pendant un `RunStatePort.update`. */
export interface RunStateView<D> {
  /** Entrée d'une destination, sans la créer. */
  get(id: string): D | undefined;
  /** Entrée d'une destination, créée avec les valeurs par défaut si absente (comme le subscript de `RunState`). */
  entry(id: string): D;
  /** Retire une destination ; `false` si elle n'y était pas. */
  remove(id: string): boolean;
  ids(): string[];
}

/**
 * Accès à `runs.json`, fourni par `src/core/backup` (`RunState.load` / `save`). `update` relit le fichier, appelle
 * `mutate` et l'écrit seulement si `mutate` renvoie vrai : la lecture précède l'écriture de près, pour ne pas écraser
 * ce qu'une sauvegarde (app ou `cairn backup`) vient d'écrire (46a9475).
 */
export interface RunStatePort<D = ScheduleRunFields> {
  update(mutate: (state: RunStateView<D>) => boolean): Promise<void>;
}

/** `runs.json` sur disque (`backup/run-state.ts`), relu à chaque `update`. */
export function fileRunStatePort(paths: RunStatePaths): RunStatePort<DestinationRunState> {
  return {
    async update(mutate) {
      const state = await loadRunState(paths);
      const view: RunStateView<DestinationRunState> = {
        get: (id) => state.destinations[id],
        entry(id) {
          state.destinations[id] ??= emptyDestinationState();
          return state.destinations[id];
        },
        remove(id) {
          if (!(id in state.destinations)) return false;
          delete state.destinations[id];
          return true;
        },
        ids: () => Object.keys(state.destinations),
      };
      if (mutate(view)) await saveRunState(paths, state);
    },
  };
}

export interface TickInput {
  destinationIds: readonly string[];
  schedule: ScheduleConfig;
  /** État lu au début du tour. */
  state: Record<string, ScheduleRunFields>;
  /** Joignabilité de chaque destination (sondée par l'appelant). */
  reachable: Record<string, boolean>;
  power: Power;
  now: Date;
  /** Une sauvegarde tourne déjà (app ou verrou tenu par la CLI). */
  running: boolean;
  /** `config.toml` contient une erreur : aucune sauvegarde planifiée. */
  configInvalid: boolean;
  calendar?: Calendar;
}

export interface TickPlan {
  /** Destinations à sauvegarder maintenant. */
  due: string[];
  /** Destinations injoignables à ce tour (pour l'état de l'app et les notices de retard). */
  waiting: Record<string, boolean>;
  decisions: Record<string, ScheduleDecision>;
}

/** Décision de chaque destination pour ce tour. */
export function planTick(input: TickInput): TickPlan {
  const plan: TickPlan = { due: [], waiting: {}, decisions: {} };
  if (input.configInvalid || input.running) return plan;
  for (const id of input.destinationIds) {
    const reachable = input.reachable[id] ?? false;
    plan.waiting[id] = !reachable;
    const ds = input.state[id] ?? {};
    const decision = decide(input.schedule, {
      lastSuccess: ds.lastSuccess,
      lastFailure: ds.lastFailure,
      now: input.now,
      running: false,
      power: input.power,
      reachable,
      calendar: input.calendar,
    });
    plan.decisions[id] = decision;
    if (decision === "run") plan.due.push(id);
  }
  return plan;
}

export interface OverdueInput {
  schedule: ScheduleConfig;
  /** Destinations injoignables (seules elles sont signalées en retard). */
  waiting: Record<string, boolean>;
  now: Date;
  calendar?: Calendar;
}

/**
 * Notices de retard : `runs.json` est relu juste avant l'écriture de `lastOverdueNotice` (46a9475), et les décisions
 * se prennent sur cet état relu. `notify` reçoit l'identifiant et la dernière réussite ; renvoie les destinations
 * signalées.
 */
export async function recordOverdueNotices<D extends ScheduleRunFields>(
  port: RunStatePort<D>,
  input: OverdueInput,
  notify: (id: string, lastSuccess: Date | null) => void,
): Promise<string[]> {
  const notified: string[] = [];
  const calendar = input.calendar ?? localCalendar;
  await port.update((state) => {
    notified.length = 0;
    for (const [id, waiting] of Object.entries(input.waiting)) {
      if (!waiting) continue;
      const ds = state.get(id);
      if (!shouldNotifyOverdue(input.schedule, ds?.lastSuccess, ds?.lastOverdueNotice, input.now, calendar)) continue;
      notify(id, ds?.lastSuccess ?? null);
      state.entry(id).lastOverdueNotice = input.now;
      notified.push(id);
    }
    return notified.length > 0;
  });
  return notified;
}
