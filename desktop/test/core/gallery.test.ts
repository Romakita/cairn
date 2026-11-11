// Catalogue des composants : port de GalleryTests.every_component_has_a_story (0.8.0). Chaque composant exporté par
// `src/renderer/ui/index.ts` a au moins une story (`component: "<Nom>"`) dans `src/renderer/gallery/stories/`.
// Lecture des sources (pas d'import) : le test ne dépend ni de React ni des modules CSS.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const renderer = path.resolve(import.meta.dir, "../../src/renderer");

/** Composants exportés : noms en PascalCase (les constantes en capitales et les types sont ignorés). */
function exportedComponents(): string[] {
  const index = readFileSync(path.join(renderer, "ui/index.ts"), "utf8");
  const names = new Set<string>();
  for (const m of index.matchAll(/^export\s+\{([^}]*)\}\s+from/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim();
      if (!name || name.startsWith("type ")) continue;
      if (/^[A-Z][a-z0-9]+[A-Za-z0-9]*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

function storyComponents(): Set<string> {
  const dir = path.join(renderer, "gallery/stories");
  const out = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
    const source = readFileSync(path.join(dir, file), "utf8");
    for (const m of source.matchAll(/component:\s*"([A-Za-z0-9]+)"/g)) out.add(m[1]!);
  }
  return out;
}

describe("gallery", () => {
  test("every_component_has_a_story", () => {
    const components = exportedComponents();
    expect(components.length).toBeGreaterThan(20);
    const stories = storyComponents();
    expect(components.filter((c) => !stories.has(c))).toEqual([]);
  });
});
