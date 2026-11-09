// Actions de la page d'une destination et raison de leur indisponibilité (port de `BackupActions`,
// DestinationRemoval.swift) : règle pure partagée avec l'interface (leçon « boutons » : toute action indisponible est
// désactivée avec sa raison).

export type BackupAction = "simulate" | "verify" | "verifyFull" | "backup";
export const BACKUP_ACTIONS: readonly BackupAction[] = ["simulate", "verify", "verifyFull", "backup"];

export interface BackupActionContext {
  /** `null` : pas encore sondée (ne bloque pas). */
  reachable: boolean | null;
  backingUp: boolean;
  verifying: boolean;
  hasBackups: boolean;
}

/** Clé de traduction de la raison pour laquelle l'action est indisponible, `null` si elle est possible. */
export function unavailableReason(action: BackupAction, c: BackupActionContext): string | null {
  // Pendant une sauvegarde, la destination sauvegardée affiche « Arrêter » à la place de « Sauvegarder maintenant ».
  if (c.backingUp) return "backup.unavailable.running";
  if (c.verifying) return "backup.unavailable.verifying";
  if (c.reachable === false) return "backup.unavailable.unreachable";
  if (!c.hasBackups && (action === "verify" || action === "verifyFull")) return "backup.unavailable.nothing_to_verify";
  return null;
}
