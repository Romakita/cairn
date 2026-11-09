// Navigation commune : où mène un problème de l'accueil (« Résoudre »), l'indicateur d'état de la barre du haut et
// le lien « Ajouter une destination ». Ne lance jamais d'action : navigation seulement.
import type { HubIssue } from "../../../core/hub-state.ts";
import type { AppSnapshot, NavigationRequest } from "../../../shared/contract.ts";

/**
 * Formulaire d'ajout de destination : l'écran Sauvegardes l'ouvre quand la demande porte `ref: "add"`
 * (convention partagée avec la zone backup).
 */
export const ADD_DESTINATION: NavigationRequest = { route: "backup", ref: "add" };

/** Écran Nettoyable avec les plus gros dossiers régénérables présélectionnés (rien n'est supprimé sans confirmation). */
export function cleanRequest(snapshot: AppSnapshot): NavigationRequest {
  return { route: "clean", preselect: snapshot.analysis.preselection };
}

/** Là où un problème se règle. */
export function resolveIssue(issue: HubIssue, snapshot: AppSnapshot): NavigationRequest {
  switch (issue.kind) {
    case "configInvalid":
    case "folderUnavailable":
      return { route: "settings" };
    case "backupFailed":
    case "destinationOverdue":
    case "versionsDamaged":
      return issue.ref ? { route: "backup", ref: issue.ref } : { route: "backup" };
    case "diskCritical":
    case "diskLow":
      return cleanRequest(snapshot);
  }
}

/** Cible de l'indicateur d'état : sauvegarde en cours, sinon le problème prioritaire, sinon l'accueil. */
export function statusTarget(snapshot: AppSnapshot): NavigationRequest {
  if (snapshot.backup.running) return { route: "backup" };
  if (snapshot.hub.topIssue) return resolveIssue(snapshot.hub.topIssue, snapshot);
  return { route: "home" };
}
