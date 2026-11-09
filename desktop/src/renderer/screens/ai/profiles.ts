// Profils des outils IA livrés avec l'app (mêmes fichiers que le core) : racine, catégories, exclusions, jeton au
// Trousseau. `AIToolView` ne les porte pas encore ; un outil sans profil ici garde un affichage minimal.
import claudeCode from "../../../../resources/ai-tools/claude-code.json" with { type: "json" };
import claudeDesktop from "../../../../resources/ai-tools/claude-desktop.json" with { type: "json" };
import codex from "../../../../resources/ai-tools/codex.json" with { type: "json" };

export interface ProfileInfo {
  root: string;
  categories: Record<string, string[]>;
  exclude: string[];
  credentialsInKeychain: boolean;
}

const PROFILES: Record<string, ProfileInfo> = Object.fromEntries(
  [claudeCode, claudeDesktop, codex].map((p) => [
    p.id,
    { root: p.root, categories: p.categories, exclude: p.exclude, credentialsInKeychain: p.credentials_in_keychain },
  ]),
);

export function profileOf(id: string): ProfileInfo | undefined {
  return PROFILES[id];
}

/** Ordre d'affichage des catégories. */
export const CATEGORY_ORDER = ["conversations", "config", "memories", "credentials"];
