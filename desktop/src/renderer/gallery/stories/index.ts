import type { Story } from "../story.ts";
import { charts, feedback, fields } from "./data.tsx";
import { brand, buttons, palette } from "./foundations.tsx";
import { containers, navigation } from "./layout.tsx";

/**
 * Toutes les stories, groupe par groupe. Le registre est reconstruit à chaque appel : titres et valeurs par défaut
 * suivent la langue choisie.
 */
export function allStories(): Story[] {
  return [
    ...palette(),
    ...buttons(),
    ...navigation(),
    ...containers(),
    ...feedback(),
    ...fields(),
    ...charts(),
    ...brand(),
  ];
}
