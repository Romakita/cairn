// Notifications de l'app (port de Notifier.swift et de StorageMonitor.notify) : `Notification` d'Electron, jamais
// d'action destructive. Les actions :
// - « Voir le journal » (et le clic) : ouvre le journal cité ;
// - « Nettoyer » : ouvre l'écran Nettoyable avec la présélection, sans rien supprimer ;
// - « Rappeler plus tard » : sourdine de 7 jours du volume.
// Les références sont gardées tant que la notification vit (sinon le ramasse-miettes perd ses gestionnaires).
import { app, Notification } from "electron";
import { t } from "../core/l10n.ts";

export type NotificationAction =
  | { kind: "openLog"; log: string }
  | { kind: "clean"; volume: string }
  | { kind: "snooze"; volume: string };

export interface PostRequest {
  title: string;
  body: string;
  /** Clic sur la notification. */
  onClick?: NotificationAction;
  /** Boutons (dans l'ordre affiché). */
  actions?: { text: string; action: NotificationAction }[];
}

export class Notifier {
  private readonly live = new Set<Notification>();
  /** Notifications envoyées (titres seulement), pour les tests de bout en bout. */
  readonly posted: { title: string; actions: string[] }[] = [];

  constructor(private readonly perform: (action: NotificationAction) => void) {}

  /** Notifications système disponibles (bundle `.app`, macOS). Les tests de bout en bout n'en affichent aucune. */
  get supported(): boolean {
    if (process.env.CAIRN_E2E_USER_DATA && !app.isPackaged) return false;
    try {
      return Notification.isSupported();
    } catch {
      return false;
    }
  }

  post(request: PostRequest): void {
    this.posted.push({ title: request.title, actions: (request.actions ?? []).map((a) => a.text) });
    if (this.posted.length > 50) this.posted.shift();
    if (!this.supported) return;
    const n = new Notification({
      title: request.title,
      body: request.body,
      actions: (request.actions ?? []).map((a) => ({ type: "button" as const, text: a.text })),
    });
    this.live.add(n);
    const forget = () => this.live.delete(n);
    n.on("click", () => {
      if (request.onClick) this.perform(request.onClick);
      forget();
    });
    n.on("action", (_event, index) => {
      const a = request.actions?.[index];
      if (a) this.perform(a.action);
      forget();
    });
    n.on("close", forget);
    n.on("failed", forget);
    n.show();
  }

  /** Notification qui cite un journal : le clic et « Voir le journal » l'ouvrent. */
  postWithLog(title: string, body: string, log: string | null): void {
    const open: NotificationAction | undefined = log ? { kind: "openLog", log } : undefined;
    this.post({
      title,
      body,
      onClick: open,
      actions: open ? [{ text: t("backup.notify.view_log"), action: open }] : [],
    });
  }

  /** Alerte disque : « Nettoyer » ouvre l'écran Nettoyable, « Rappeler plus tard » met le volume en sourdine. */
  postDiskAlert(title: string, body: string, volume: string): void {
    const clean: NotificationAction = { kind: "clean", volume };
    this.post({
      title,
      body,
      onClick: clean,
      actions: [
        { text: t("action.clean"), action: clean },
        { text: t("alerts.snooze"), action: { kind: "snooze", volume } },
      ],
    });
  }
}
