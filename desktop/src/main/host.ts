// Ce que chaque service du main reçoit de l'app : chemins, configuration courante, notification d'un changement
// d'état, confirmations, notifications et journal d'activité. Implémenté par `CairnApp` (app.ts).
import type { ActivityEvent, ActivityLog } from "../core/activity-log.ts";
import type { CairnConfig, DestinationConfig } from "../core/config.ts";
import type { ConfigStore } from "../core/config-store.ts";
import type { CairnPaths } from "../core/paths.ts";
import type { MessageView, NavigationRequest } from "../shared/contract.ts";
import type { Confirmer } from "./confirm.ts";
import type { Notifier } from "./notifications.ts";

export interface Host {
  readonly paths: CairnPaths;
  readonly store: ConfigStore;
  /** Worker du pool git (`dist/git-worker.cjs`). */
  readonly gitWorkerFile: string;
  readonly notifier: Notifier;
  readonly confirm: Confirmer;
  readonly activity: ActivityLog;
  /** L'état a changé : nouvel instantané à envoyer (regroupé, ≤ 10/s ; `urgent` : début ou fin d'une opération). */
  changed(urgent?: boolean): void;
  /** Dernière configuration valide (par défaut tant qu'aucune n'a été lue). */
  config(): CairnConfig;
  /** Enregistre toute la configuration puis la relit (refusé si le fichier sur disque est invalide). */
  saveConfig(config: CairnConfig): Promise<void>;
  /** `config.toml` contient une erreur : planification bloquée. */
  configInvalid(): boolean;
  /** Message bref affiché par l'interface (texte déjà traduit). */
  message(level: MessageView["level"], text: string): void;
  /** Nom de cette machine (`scutil --get ComputerName`, nettoyé). */
  machine(): Promise<string>;
  /** Une sauvegarde de cette app tourne. */
  isBackingUp(): boolean;
  /** Nom affiché d'une destination (dernier composant du chemin, ou hôte). */
  destinationLabel(d: DestinationConfig): string;
  /** Relevé du disque (après une analyse, une suppression, une opération git, une sauvegarde). */
  checkStorage(): Promise<void>;
  /** Journal d'activité de l'accueil (erreurs ignorées). */
  logActivity(event: Omit<ActivityEvent, "date">): void;
  /** Ouvre la fenêtre principale sur un écran. */
  navigate(request: NavigationRequest): void;
}
