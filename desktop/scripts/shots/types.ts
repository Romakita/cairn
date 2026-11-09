/** Une capture d'écran de l'app, prise dans le navigateur avec l'API d'exemple (sans disque). */
export interface ScreenShot {
  /** Nom du fichier (sans thème ni extension) : `<zone>.<écran>[.<état>]`. */
  name: string;
  /** Route de l'app (`#/app/<route>`) ou page entière (`#/menubar`). */
  hash: string;
  /** Scénario de l'API d'exemple (`?scenario=`) ; `normal` par défaut. */
  scenario?: string;
  /** Instant figé du scénario, en secondes (`&t=…&frozen=1`) : progression d'une sauvegarde, par exemple. */
  at?: number;
  /** Langue (`&lang=fr`) ; anglais par défaut. */
  lang?: "en" | "fr";
  /** Taille de la fenêtre ; 1280 × 800 par défaut (360 × 520 pour la barre des menus, par exemple). */
  viewport?: { width: number; height: number };
  /** Actions avant la capture (ouvrir un menu, une feuille…), avec le `page` Playwright. */
  before?: (page: import("@playwright/test").Page) => Promise<void>;
}
