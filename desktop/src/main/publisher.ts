// Envoi de l'état aux fenêtres abonnées : un instantané complet, au plus 10 par seconde (le premier changement part
// aussitôt, les suivants sont regroupés). Une fenêtre fermée est retirée.
import type { WebContents } from "electron";
import { type AppSnapshot, NAVIGATE_CHANNEL, type NavigationRequest, SNAPSHOT_CHANNEL } from "../shared/contract.ts";

export const MIN_INTERVAL_MS = 100;

export class SnapshotPublisher {
  private readonly targets = new Set<WebContents>();
  private timer: NodeJS.Timeout | null = null;
  private lastSent = 0;
  private dirty = false;

  constructor(private readonly build: () => AppSnapshot) {}

  /** La fenêtre reçoit désormais chaque nouvel état. */
  add(contents: WebContents): void {
    if (this.targets.has(contents)) return;
    this.targets.add(contents);
    contents.once("destroyed", () => this.targets.delete(contents));
  }

  get size(): number {
    return this.targets.size;
  }

  /**
   * Un élément de l'état a changé : envoi immédiat ou regroupé (≤ 10/s). `urgent` (début ou fin d'une opération)
   * part tout de suite : l'interface ne manque jamais une transition, même pour une opération très courte.
   */
  changed(urgent = false): void {
    this.dirty = true;
    if (urgent) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.flush();
      return;
    }
    if (this.timer) return;
    const wait = Math.max(0, this.lastSent + MIN_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  /** Envoie l'état maintenant s'il a changé. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastSent = Date.now();
    if (this.targets.size === 0) return;
    const snapshot = this.build();
    for (const contents of this.targets) {
      if (!contents.isDestroyed()) contents.send(SNAPSHOT_CHANNEL, snapshot);
    }
  }

  navigate(request: NavigationRequest, only?: WebContents): void {
    for (const contents of only ? [only] : this.targets) {
      if (!contents.isDestroyed()) contents.send(NAVIGATE_CHANNEL, request);
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
