import { type AppLanguage, parseLanguage } from "../../core/l10n.ts";

export type GalleryTheme = "light" | "dark";

/** Adresse de la galerie : `#/gallery`, `#/gallery/<story>`, options `?theme=dark&lang=fr&capture`. */
export interface GalleryRoute {
  story?: string;
  theme: GalleryTheme;
  language?: AppLanguage;
  /** Story seule, sans la fenêtre du catalogue (captures, export). */
  capture: boolean;
}

export function parseGalleryHash(hash: string): GalleryRoute | null {
  const match = /^#\/gallery(?:\/([^?]*))?(?:\?(.*))?$/.exec(hash);
  if (!match) return null;
  const params = new URLSearchParams(match[2] ?? "");
  return {
    story: match[1] ? decodeURIComponent(match[1]) : undefined,
    theme: params.get("theme") === "dark" ? "dark" : "light",
    language: parseLanguage(params.get("lang")),
    capture: params.has("capture"),
  };
}

export function galleryHash(route: GalleryRoute): string {
  const params = new URLSearchParams();
  if (route.theme === "dark") params.set("theme", "dark");
  if (route.language) params.set("lang", route.language === "fr-FR" ? "fr" : "en");
  if (route.capture) params.set("capture", "");
  const query = params.toString().replace(/=(&|$)/g, "$1");
  return `#/gallery${route.story ? `/${encodeURIComponent(route.story)}` : ""}${query ? `?${query}` : ""}`;
}
