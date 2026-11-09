// Suppression d'une destination (port de `DestinationRemoval`, DestinationRemoval.swift, et de
// `DestinationDeleteSheet.delete`) : plan (simulation), puis exécution sous le verrou d'opération. Seules les
// sauvegardes de ce Mac sont visées ; celles des autres Mac posées sur la même destination ne sont jamais listées ni
// supprimées. Les mots de passe (image et partage) ne sont jamais retirés du Trousseau (76e40ec) : ce module n'y
// touche pas.
import path from "node:path";
import { type BackupProvider, LocalProvider, SMBProvider } from "../backup/providers.ts";
import { keychainSecrets } from "../backup/secrets.ts";
import { ProviderError } from "../backup/types.ts";
import type { DestinationConfig } from "../config.ts";
import type { ConfigStore } from "../config-store.ts";
import { rm, stat } from "../fs-promises.ts";
import { t } from "../l10n.ts";
import { OperationLock, type StatePaths } from "../lock.ts";
import { machineName } from "../machine.ts";
import { uniqueBytes } from "../retention.ts";
import type { RunStatePort } from "../schedule/tick.ts";

/** Fournisseur d'une destination (`prepare(false)` ne crée rien) ; injectable (montage simulé en test). */
export type ProviderFactory = (d: DestinationConfig) => BackupProvider;

/** Fournisseurs réels : `LocalProvider`, ou `SMBProvider` avec le mot de passe du Trousseau. */
export const defaultProviderFactory: ProviderFactory = (d) =>
  d.provider === "smb" ? new SMBProvider(d, { secrets: keychainSecrets }) : new LocalProvider(d);

/** Une destination SMB passe toujours par une image ; une destination locale seulement si elle est chiffrée. */
export function usesImage(d: Pick<DestinationConfig, "provider" | "encrypted">): boolean {
  return d.provider === "smb" || d.encrypted;
}

export type RemovalItem =
  /** Entrée de `config.toml`. */
  | { kind: "configuration"; id: string }
  /** État des sauvegardes (`runs.json`). */
  | { kind: "state"; id: string }
  /** Image ou dossier de ce Mac sur la destination. */
  | { kind: "backups"; path: string; bytes: number };

export interface RemovalPlan {
  destination: DestinationConfig;
  includeBackups: boolean;
  /** Machine dont les sauvegardes sont visées (ce Mac). */
  machine: string;
  items: RemovalItem[];
  /**
   * Sauvegardes illisibles (destination injoignable, mot de passe absent…) : la suppression avec les sauvegardes est
   * alors impossible.
   */
  backupsUnavailable: string | null;
}

export function canExecuteRemoval(plan: RemovalPlan): boolean {
  return !plan.includeBackups || plan.backupsUnavailable === null;
}

export function removalBackupBytes(plan: RemovalPlan): number {
  return plan.items.reduce((n, i) => (i.kind === "backups" ? n + i.bytes : n), 0);
}

/** Emplacement des sauvegardes de ce Mac sous la racine de la destination. */
export function backupsPath(
  base: string,
  d: Pick<DestinationConfig, "provider" | "encrypted">,
  machine: string,
): string {
  return usesImage(d) ? path.join(base, `cairn-${machine}.sparsebundle`) : path.join(base, "cairn", machine);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface PlanOptions {
  machine?: string;
  provider?: ProviderFactory;
}

/** Simulation : ce que la suppression retirerait. Monte la destination si besoin (sans rien créer) et la démonte. */
export async function planRemoval(
  d: DestinationConfig,
  includeBackups: boolean,
  options: PlanOptions = {},
): Promise<RemovalPlan> {
  const machine = options.machine ?? (await machineName());
  const plan: RemovalPlan = {
    destination: d,
    includeBackups,
    machine,
    items: [
      { kind: "configuration", id: d.id },
      { kind: "state", id: d.id },
    ],
    backupsUnavailable: null,
  };
  if (!includeBackups) return plan;
  const provider = (options.provider ?? defaultProviderFactory)(d);
  try {
    const base = await provider.prepare(false);
    const p = backupsPath(base, d, machine);
    if (await exists(p)) plan.items.push({ kind: "backups", path: p, bytes: await uniqueBytes([p]) });
  } catch (error) {
    // Rien encore sur la destination : rien à supprimer.
    if (!(error instanceof ProviderError && error.reason === "notCreated")) {
      plan.backupsUnavailable = error instanceof Error ? error.message : String(error);
    }
  } finally {
    await provider.finish();
  }
  return plan;
}

export type RemovalFailureKind = "backupsUnavailable" | "removal";

export class RemovalError extends Error {
  constructor(
    readonly kind: RemovalFailureKind,
    readonly detail: string,
  ) {
    super(
      kind === "backupsUnavailable"
        ? t("destination.delete.error.unavailable", detail)
        : t("destination.delete.error.removal", detail),
    );
    this.name = "RemovalError";
  }
}

export interface ExecuteDeps {
  /** `state/` (verrou d'opération). */
  paths: StatePaths;
  /** Accès à `runs.json` (fourni par `src/core/backup`). */
  runState: RunStatePort<unknown>;
  provider?: ProviderFactory;
}

/**
 * Exécute un plan sous le verrou d'opération (`OperationLockError` si une autre opération tourne) : sauvegardes
 * d'abord, puis état. Si la suppression sur la destination échoue, rien d'autre n'est retiré. L'appelant retire la
 * destination de `config.toml` avant (voir `removeDestination`).
 */
export async function executeRemoval(plan: RemovalPlan, deps: ExecuteDeps): Promise<void> {
  if (!canExecuteRemoval(plan)) throw new RemovalError("backupsUnavailable", plan.backupsUnavailable ?? "");
  const lock = new OperationLock(deps.paths);
  await lock.acquire("remove-destination");
  try {
    if (plan.includeBackups && plan.items.some((i) => i.kind === "backups")) {
      const provider = (deps.provider ?? defaultProviderFactory)(plan.destination);
      try {
        const base = await provider.prepare(false);
        // Chemin recalculé sous la racine montée maintenant (le point de montage peut changer d'une session à
        // l'autre) : seules les sauvegardes de la machine du plan sont visées.
        const current = backupsPath(base, plan.destination, plan.machine);
        if (await exists(current)) await rm(current, { recursive: true });
      } catch (error) {
        if (error instanceof ProviderError) throw new RemovalError("backupsUnavailable", error.message);
        throw new RemovalError("removal", error instanceof Error ? error.message : String(error));
      } finally {
        await provider.finish();
      }
    }
    await deps.runState.update((s) => s.remove(plan.destination.id));
  } finally {
    await lock.release();
  }
}

export interface RemoveDeps extends ExecuteDeps {
  store: ConfigStore;
}

/**
 * Suppression complète, dans l'ordre de la 0.8.0 : la destination sort d'abord de `config.toml` (si l'écriture
 * échoue, rien n'est supprimé), puis le plan est exécuté ; s'il échoue, l'entrée est remise à sa place et l'erreur
 * est relancée.
 */
export async function removeDestination(plan: RemovalPlan, deps: RemoveDeps): Promise<void> {
  if (!canExecuteRemoval(plan)) throw new RemovalError("backupsUnavailable", plan.backupsUnavailable ?? "");
  const id = plan.destination.id;
  const config = (await deps.store.load()).config;
  const index = config.destinations.findIndex((d) => d.id === id);
  if (index < 0) throw new Error(t("destination.delete.error.config"));
  const entry = config.destinations[index]!;
  config.destinations.splice(index, 1);
  await deps.store.save(config);
  try {
    await executeRemoval(plan, deps);
  } catch (error) {
    try {
      const back = (await deps.store.load()).config;
      if (!back.destinations.some((d) => d.id === id)) {
        back.destinations.splice(Math.min(index, back.destinations.length), 0, entry);
        await deps.store.save(back);
      }
    } catch (restore) {
      // L'erreur d'origine reste la cause affichée ; l'échec de la remise en place y est joint.
      throw new AggregateError([error, restore], error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}
