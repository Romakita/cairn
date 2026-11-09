import type { ReactNode } from "react";
import { s } from "./sample-text.ts";

/** Groupes de stories, dans l'ordre du catalogue (mêmes ids que la 0.8.0). */
export const STORY_GROUPS = [
  "palette",
  "buttons",
  "navigation",
  "containers",
  "feedback",
  "fields",
  "charts",
  "brand",
] as const;
export type StoryGroup = (typeof STORY_GROUPS)[number];

/** Réglage d'une story : libellé `gallery.control.<key>`, option traduite par `gallery.option.<option>`. */
export type StoryControl =
  | { kind: "text"; key: string; default: string }
  | { kind: "toggle"; key: string; default: boolean }
  | { kind: "number"; key: string; min: number; max: number; step?: number; default: number }
  | { kind: "choice"; key: string; options: readonly string[]; default: string };

export type StoryValue = string | number | boolean;
export type StoryValues = Readonly<Record<string, StoryValue>>;

export interface Story {
  /** Identifiant stable (nom des captures), par exemple `feedback.badge_tones`. */
  id: string;
  group: StoryGroup;
  /** Composant présenté. */
  component: string;
  /** Largeur du cadre d'aperçu par défaut. */
  width?: number;
  controls?: readonly StoryControl[];
  render: (values: StoryValues) => ReactNode;
}

export function defaultValues(story: Story): Record<string, StoryValue> {
  return Object.fromEntries((story.controls ?? []).map((c) => [c.key, c.default]));
}

export const storyTitle = (story: Story): string => s(`gallery.story.${story.id}`);
export const groupTitle = (group: StoryGroup): string => s(`gallery.group.${group}`);

/** Lecture typée d'une valeur de contrôle. */
export const text = (v: StoryValues, key: string): string => String(v[key] ?? "");
export const bool = (v: StoryValues, key: string): boolean => v[key] === true;
export const num = (v: StoryValues, key: string): number => Number(v[key] ?? 0);
