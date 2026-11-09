import { describe, expect, test } from "bun:test";
import { formatLocalDate, isoDate, parseISODate } from "../../src/core/dates.ts";
import { compactJSON, prettyJSON } from "../../src/core/json.ts";

// Attendus copiés de la sortie de JSONSerialization (Foundation) : mêmes octets que la 0.8.0.
const sample = { b: [1, 2], a: "x/y é", e: [], d: {}, n: null, f: 1.5, t: true, z: { k: [{ q: 1 }] } };

describe("formats JSON et dates compatibles avec la 0.8.0", () => {
  test("JSON indenté comme JSONSerialization", () => {
    expect(prettyJSON(sample)).toBe(
      [
        "{",
        '  "a" : "x\\/y é",',
        '  "b" : [',
        "    1,",
        "    2",
        "  ],",
        '  "d" : {',
        "",
        "  },",
        '  "e" : [',
        "",
        "  ],",
        '  "f" : 1.5,',
        '  "n" : null,',
        '  "t" : true,',
        '  "z" : {',
        '    "k" : [',
        "      {",
        '        "q" : 1',
        "      }",
        "    ]",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  test("JSON compact à clés triées", () => {
    expect(compactJSON(sample)).toBe(
      '{"a":"x\\/y é","b":[1,2],"d":{},"e":[],"f":1.5,"n":null,"t":true,"z":{"k":[{"q":1}]}}',
    );
  });

  test("dates ISO 8601 sans millisecondes, relues avec ou sans", () => {
    expect(isoDate(new Date(1762678200123))).toBe("2025-11-09T08:50:00Z");
    expect(parseISODate("2025-11-09T08:50:00Z")?.getTime()).toBe(1762678200000);
    expect(parseISODate("2025-11-09T08:50:00.123Z")?.getTime()).toBe(1762678200123);
    expect(parseISODate("hier")).toBeNull();
  });

  test("motifs de DateFormatter", () => {
    const d = new Date(2026, 10, 9, 8, 5, 3);
    expect(formatLocalDate(d, "yyyy-MM-dd'T'HHmmss")).toBe("2026-11-09T080503");
    expect(formatLocalDate(d, "yyyyMMdd-HHmmss")).toBe("20261109-080503");
  });
});
