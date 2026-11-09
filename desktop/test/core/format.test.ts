import { afterEach, describe, expect, test } from "bun:test";
import { Fmt } from "../../src/core/format.ts";
import { type AppLanguage, currentLanguage, setLanguage } from "../../src/core/l10n.ts";

// Cas de LocalizationTests.regional_formats et ConfigWarningTests.duration_is_localized, plus des valeurs de bord
// relevées sur Foundation (macOS) : arrondi au pair, espaces fines (U+202F) et insécables (U+00A0) du français.

const saved = currentLanguage();
afterEach(() => setLanguage(saved));

function inLanguage(language: AppLanguage, body: () => void): void {
  setLanguage(language);
  body();
}

describe("format", () => {
  test("tailles décimales", () => {
    inLanguage("fr-FR", () => {
      expect(Fmt.bytes(1_234_567_890)).toBe("1,23 Go");
      expect(Fmt.bytes(512)).toBe("512 o");
      expect(Fmt.bytes(1_234_567)).toBe("1,2 Mo");
      expect(Fmt.bytes(999_999_999)).toBe("1 000 Mo");
      expect(Fmt.bytes(1.5e15)).toBe("1,5 Po");
    });
    inLanguage("en-US", () => {
      expect(Fmt.bytes(1_234_567_890)).toBe("1.23 GB");
      expect(Fmt.bytes(512)).toBe("512 bytes");
      expect(Fmt.bytes(0)).toBe("0 bytes");
      expect(Fmt.bytes(-5)).toBe("0 bytes");
      expect(Fmt.bytes(999)).toBe("999 bytes");
      expect(Fmt.bytes(1000)).toBe("1 KB");
      expect(Fmt.bytes(999_499)).toBe("999 KB");
      expect(Fmt.bytes(999_500)).toBe("1,000 KB");
      expect(Fmt.bytes(1500)).toBe("2 KB"); // arrondi au pair
      expect(Fmt.bytes(2500)).toBe("2 KB");
      expect(Fmt.bytes(3500)).toBe("4 KB");
      expect(Fmt.bytes(1_250_000)).toBe("1.2 MB");
      expect(Fmt.bytes(1_255_000)).toBe("1.3 MB");
      expect(Fmt.bytes(12_345_678)).toBe("12.3 MB");
      expect(Fmt.bytes(1_005_000_000)).toBe("1 GB");
      expect(Fmt.bytes(1e18)).toBe("1,000 PB");
    });
  });

  test("durées", () => {
    inLanguage("fr-FR", () => {
      expect(Fmt.duration(12.34)).toBe("12,3 s");
      expect(Fmt.duration(125)).toBe("2 min et 5 s");
      expect(Fmt.duration(3725)).toBe("1 h, 2 min et 5 s");
      expect(Fmt.duration(3660)).toBe("1 h et 1 min");
      expect(Fmt.duration(7200)).toBe("2 h");
      expect(Fmt.duration(172_805)).toBe("48 h et 5 s");
    });
    inLanguage("en-US", () => {
      expect(Fmt.duration(12.34)).toBe("12.3 s");
      expect(Fmt.duration(3725)).toContain("1 hr");
      expect(Fmt.duration(3725)).toBe("1 hr, 2 min, 5 sec");
      expect(Fmt.duration(60)).toBe("1 min");
      expect(Fmt.duration(61)).toBe("1 min, 1 sec");
      expect(Fmt.duration(59.96)).toBe("60.0 s");
      expect(Fmt.duration(-3)).toBe("0.0 s");
      expect(Fmt.duration(119.6)).toBe("2 min");
    });
  });

  test("pourcentages", () => {
    inLanguage("fr-FR", () => {
      expect(Fmt.percent(1234, 10_000)).toBe("12,3 %");
      expect(Fmt.percent(15, 10_000)).toBe("0,2 %");
      expect(Fmt.percent(1, 100_000)).toBe("<0,1 %");
      expect(Fmt.percent(5, 0)).toBe("–");
    });
    inLanguage("en-US", () => {
      expect(Fmt.percent(1, 2)).toBe("50.0%");
      expect(Fmt.percent(0, 2)).toBe("0.0%");
      expect(Fmt.percent(99_999, 100_000)).toBe("100.0%");
      expect(Fmt.percent(1, 100_000)).toBe("<0.1 %");
    });
  });

  test("compteurs et nombres", () => {
    inLanguage("fr-FR", () => {
      expect(Fmt.count(1_234_567)).toBe("1 234 567");
      expect(Fmt.count(-1234)).toBe("-1 234");
      expect(Fmt.number(1234.5, 1)).toBe("1 234,5");
      expect(Fmt.number(12.35, 1)).toBe("12,4");
    });
    inLanguage("en-US", () => {
      expect(Fmt.count(999)).toBe("999");
      expect(Fmt.count(1000)).toBe("1,000");
      expect(Fmt.number(12.25, 1)).toBe("12.2");
      expect(Fmt.number(0.05, 1)).toBe("0.0");
      expect(Fmt.number(2, 2)).toBe("2.00");
    });
  });

  test("dates", () => {
    const morning = new Date(2025, 10, 9, 9, 50);
    const afternoon = new Date(2025, 8, 3, 14, 5);
    const midnight = new Date(2025, 0, 3, 0, 7);
    inLanguage("fr-FR", () => {
      expect(Fmt.date(morning)).toBe("9 nov. 2025 à 9:50");
      expect(Fmt.date(afternoon)).toBe("3 sept. 2025 à 14:05");
      expect(Fmt.date(midnight)).toBe("3 janv. 2025 à 0:07");
    });
    inLanguage("en-US", () => {
      expect(Fmt.date(morning)).toBe("Nov 9, 2025 at 9:50 AM");
      expect(Fmt.date(afternoon)).toBe("Sep 3, 2025 at 2:05 PM");
      expect(Fmt.date(midnight)).toBe("Jan 3, 2025 at 12:07 AM");
    });
  });
});
