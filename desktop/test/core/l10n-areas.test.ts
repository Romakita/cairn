import { describe, expect, test } from "bun:test";
import enCatalog from "../../locales/en.json" with { type: "json" };
import { areaFiles } from "../../src/core/l10n.ts";

describe("traductions des écrans par zone", () => {
  test("chaque zone a les mêmes clés en anglais et en français", () => {
    for (const [area, file] of Object.entries(areaFiles)) {
      expect({ area, keys: Object.keys(file.fr).sort() }).toEqual({ area, keys: Object.keys(file.en).sort() });
    }
  });

  test("une clé de zone n'existe ni dans les catalogues de la 0.8.0 ni dans une autre zone", () => {
    const seen = new Map<string, string>(Object.keys(enCatalog).map((k) => [k, "0.8.0"]));
    const duplicates: string[] = [];
    for (const [area, file] of Object.entries(areaFiles)) {
      for (const key of Object.keys(file.en)) {
        const owner = seen.get(key);
        if (owner) duplicates.push(`${key} (${area} / ${owner})`);
        seen.set(key, area);
      }
    }
    expect(duplicates).toEqual([]);
  });

  test("les jetons {N} sont les mêmes dans les deux langues", () => {
    const tokens = (v: unknown) => [...JSON.stringify(v).matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort();
    for (const file of Object.values(areaFiles)) {
      for (const [key, value] of Object.entries(file.en))
        expect({ key, t: tokens(file.fr[key]) }).toEqual({ key, t: tokens(value) });
    }
  });
});
