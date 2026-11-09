import { afterEach, describe, expect, test } from "bun:test";
import enCatalog from "../../locales/en.json" with { type: "json" };
import {
  type AppLanguage,
  type CatalogEntry,
  catalog,
  configureLanguage,
  currentLanguage,
  missingKeys,
  parseLanguage,
  parseLanguageSetting,
  pluralKeys,
  resolve,
  resolveLanguage,
  setLanguage,
  systemLanguage,
  t,
} from "../../src/core/l10n.ts";

// Port de LocalizationTests.swift (+ le repli de ConfigWarningTests.french_falls_back_to_english_then_key).

const saved = currentLanguage();
afterEach(() => setLanguage(saved));

function withLanguage<T>(language: AppLanguage, body: () => T): T {
  setLanguage(language);
  return body();
}

/** Jetons `{N}` d'une entrée (format et toutes ses formes), triés : équivalent de `formatSpecifiers` en Swift. */
function tokens(entry: CatalogEntry): string[] {
  const texts = JSON.stringify(entry).match(/\{\d+\}/g) ?? [];
  return [...new Set(texts)].sort();
}

describe("localization", () => {
  test("les deux catalogues ont les mêmes clés (934, dont 18 pluriels)", () => {
    const en = Object.keys(catalog("en-US"));
    const fr = Object.keys(catalog("fr-FR"));
    expect(en.length).toBe(934);
    expect(fr.filter((k) => !en.includes(k))).toEqual([]);
    expect(en.filter((k) => !fr.includes(k))).toEqual([]);
    expect(pluralKeys("en-US").sort()).toEqual(pluralKeys("fr-FR").sort());
    expect(pluralKeys("en-US")).toHaveLength(18);
  });

  test("chaque paire a les mêmes jetons", () => {
    const fr = catalog("fr-FR");
    const different = Object.entries(catalog("en-US"))
      .filter(([key, entry]) => JSON.stringify(tokens(entry)) !== JSON.stringify(tokens(fr[key]!)))
      .map(([key]) => key);
    expect(different).toEqual([]);
  });

  test("aucun spécificateur printf ne reste dans les catalogues", () => {
    for (const language of ["en-US", "fr-FR"] as const) {
      const text = JSON.stringify(catalog(language));
      expect(text).not.toMatch(/%(\d+\$)?(lld|ld|d|@|#@)/);
    }
  });

  test("les pluriels ont toujours une forme « other »", () => {
    for (const language of ["en-US", "fr-FR"] as const) {
      for (const key of pluralKeys(language)) {
        const entry = catalog(language)[key]!;
        const forms = typeof entry === "object" && "format" in entry ? Object.values(entry.plurals) : [entry];
        for (const f of forms) expect(typeof (f as Record<string, string>).other).toBe("string");
      }
    }
  });

  test("la langue suit le système", () => {
    expect(systemLanguage(["de-DE", "en-US"])).toBe("en-US");
    expect(systemLanguage(["fr-CA", "en-US"])).toBe("fr-FR");
    expect(systemLanguage(["de-DE"])).toBe("en-US");
    expect(systemLanguage(["en-GB", "fr-FR"])).toBe("en-US");
    expect(systemLanguage([])).toBe("en-US");
    expect(parseLanguage("fr-FR")).toBe("fr-FR");
    expect(parseLanguage("FR_fr")).toBe("fr-FR");
    expect(parseLanguage("en")).toBe("en-US");
    expect(parseLanguage("auto")).toBeUndefined();
    expect(resolveLanguage("auto", ["fr-FR"])).toBe("fr-FR");
    expect(resolveLanguage(undefined, ["de-DE", "fr-BE"])).toBe("fr-FR");
    expect(resolveLanguage("en-US", ["fr-FR"])).toBe("en-US");
    expect(resolveLanguage("klingon", ["fr-FR"])).toBe("fr-FR");
  });

  test("--lang et config.toml : auto, une langue, ou invalide", () => {
    expect(parseLanguageSetting("auto")).toBe("auto");
    expect(parseLanguageSetting("fr")).toBe("fr-FR");
    expect(parseLanguageSetting("en_US")).toBe("en-US");
    expect(parseLanguageSetting("AUTO")).toBeUndefined();
    expect(parseLanguageSetting("de")).toBeUndefined();
    expect(parseLanguageSetting("")).toBeUndefined();
  });

  test("configureLanguage applique la langue résolue", () => {
    expect(configureLanguage("auto", ["fr-CH"])).toBe("fr-FR");
    expect(currentLanguage()).toBe("fr-FR");
    expect(configureLanguage("en", ["fr-FR"])).toBe("en-US");
    expect(currentLanguage()).toBe("en-US");
  });

  test("textes traduits dans la langue active", () => {
    expect(withLanguage("fr-FR", () => t("action.cancel"))).toBe("Annuler");
    expect(withLanguage("en-US", () => t("action.cancel"))).toBe("Cancel");
    expect(withLanguage("fr-FR", () => t("app.title", "Macintosh HD"))).toBe("Stockage — Macintosh HD");
  });

  test("arguments positionnels, %% et arguments contenant des jetons", () => {
    expect(withLanguage("en-US", () => t("alerts.body", "12 GB", "4.5"))).toBe("12 GB free (4.5 %).");
    expect(withLanguage("fr-FR", () => t("gallery.export.done", 12, "/tmp/x"))).toBe(
      "12 images et index.html écrits dans /tmp/x",
    );
    expect(withLanguage("en-US", () => t("app.title", "{1}"))).toBe("Storage — {1}");
  });

  test("pluriels : français singulier pour 0 et 1, anglais pour 1 seulement", () => {
    setLanguage("fr-FR");
    expect(t("list.repos", 0)).toBe("0 dépôt");
    expect(t("list.repos", 1)).toBe("1 dépôt");
    expect(t("list.repos", 2)).toBe("2 dépôts");
    expect(t("list.repos", 1_000_000)).toBe("1000000 dépôts"); // catégorie « many » absente → « other »
    expect(t("hub.title.error", 1)).toBe("Un problème à corriger");
    expect(t("hub.title.error", 3)).toBe("3 problèmes à corriger");
    setLanguage("en-US");
    expect(t("list.repos", 0)).toBe("0 repositories");
    expect(t("list.repos", 1)).toBe("1 repository");
    expect(t("hub.more_causes", 2)).toBe("and 2 more");
  });

  test("pluriels composés : chaque variable suit son argument", () => {
    setLanguage("en-US");
    expect(t("git.done", 1, 3)).toBe("1 branch and 3 worktrees deleted.");
    expect(t("cli.git.summary", 2, "1.2 GB", 1, 0, "300 MB")).toBe(
      "\n2 repositories, .git total 1.2 GB — 1 branch and 0 worktrees to remove, about 300 MB freed (with --prune-now)",
    );
    setLanguage("fr-FR");
    expect(t("cli.git.repo_line", "repo", "1 Go", "2 Mo", 1, "5 Mo", 2)).toBe(
      "repo  .git 1 Go  non compressé 2 Mo  1 branche à supprimer (5 Mo)  2 gardées",
    );
    expect(t("cli.git.confirm", 0, 1, "")).toBe(
      "Supprimer 0 branche et 1 worktree ? Les SHA sont notés dans .git/cleanup-deleted-branches.log.",
    );
  });

  test("clé absente : repli sur la clé", () => {
    expect(t("does.not.exist")).toBe("does.not.exist");
    expect(withLanguage("fr-FR", () => t("does.not.exist"))).toBe("does.not.exist");
    expect(t("toString")).toBe("toString");
  });

  test("le français se replie sur l'anglais, puis sur la clé", () => {
    const tables: Record<AppLanguage, Record<string, string>> = {
      "en-US": { "only.en": "English only" },
      "fr-FR": { both: "Les deux" },
    };
    const lookup = (key: string, language: AppLanguage) => tables[language][key];
    expect(resolve("only.en", "fr-FR", lookup)).toBe("English only");
    expect(resolve("both", "fr-FR", lookup)).toBe("Les deux");
    expect(resolve("nowhere", "fr-FR", lookup)).toBe("nowhere");
  });

  test("missingKeys signale les clés absentes d'une des langues", () => {
    expect(missingKeys(Object.keys(enCatalog))).toEqual([]);
    expect(missingKeys(["action.cancel", "nope.missing", "section.home"])).toEqual(["nope.missing"]);
  });
});
