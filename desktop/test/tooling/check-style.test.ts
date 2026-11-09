import { describe, expect, test } from "bun:test";
import { checkSource } from "../../scripts/check-style.ts";

describe("règles du design system", () => {
  test("une couleur littérale hors des jetons est refusée", () => {
    const v = checkSource("src/renderer/screens/Home.module.css", ".title { color: #ff0000; }");
    expect(v.map((x) => x.rule)).toEqual(["couleur hors jetons"]);
  });

  test("les jetons peuvent définir des couleurs", () => {
    expect(checkSource("src/renderer/styles/tokens.css", ":root { --fg: #111; }")).toEqual([]);
  });

  test("un élément natif hors de ui/ est refusé, accepté dans ui/", () => {
    expect(checkSource("src/renderer/screens/Git.tsx", "return <select />;")).toHaveLength(1);
    expect(checkSource("src/renderer/ui/Menu.tsx", "return <button />;")).toEqual([]);
  });

  test("l'infobulle native est refusée partout", () => {
    expect(checkSource("src/renderer/ui/Button.tsx", '<span title="x" />')).toHaveLength(1);
  });

  test("le core n'est pas concerné", () => {
    expect(checkSource("src/core/format.ts", "const red = '#f00';")).toEqual([]);
  });
});
