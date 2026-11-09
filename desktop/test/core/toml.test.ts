import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  asArray,
  asBool,
  asDouble,
  asInlineTable,
  asInteger,
  asString,
  renderValue,
  swiftDoubleDescription,
  TOML,
  TOMLDocument,
  TOMLError,
} from "../../src/core/toml.ts";

const sample = `# Configuration de test
version = 1
language = "auto"   # suit macOS

[analysis]
big_file_threshold_mb = 50
ratio = 0.5

# Dossiers suivis
[[folders]]
path = "/Volumes/workspaces"
backup = true
exclude = [
  "*.iso",   # images
  'vidéos',
]

[[folders]]
path = "~/Projets"

[destinations.nas]
retention = { mode = "tiered", days = 30, weeks = 48 }
unknown_key = "gardée"

[ai."claude-code"]
categories = ["conversations", "config"]`;

describe("TOML", () => {
  test("roundtrip_is_lossless", () => {
    const doc = TOMLDocument.parse(sample);
    expect(doc.render()).toBe(sample);
    const withNewline = `${sample}\n`;
    expect(TOMLDocument.parse(withNewline).render()).toBe(withNewline);
  });

  test("reads_values", () => {
    const t = TOMLDocument.parse(sample).tree();
    expect(asInteger(t.value("version"))).toBe(1);
    expect(asString(t.value("language"))).toBe("auto");
    expect(asDouble(t.table("analysis")?.value("ratio"))).toBe(0.5);
    const folders = t.tables("folders");
    expect(folders.length).toBe(2);
    expect(asArray(folders[0]?.value("exclude"))).toEqual([TOML.string("*.iso"), TOML.string("vidéos")]);
    expect(asString(folders[1]?.value("path"))).toBe("~/Projets");
    const retention = asInlineTable(t.table("destinations")?.table("nas")?.value("retention"));
    expect(retention?.[0]?.[0]).toBe("mode");
    expect(asArray(t.table("ai")?.table("claude-code")?.value("categories"))?.length).toBe(2);
    expect(t.table("analysis")?.valueLine("big_file_threshold_mb")).toBe(6);
  });

  test("set_existing_keeps_comments", () => {
    const doc = TOMLDocument.parse(sample);
    doc.set(TOML.string("fr-FR"), ["language"]);
    const out = doc.render();
    expect(out).toContain('language = "fr-FR"   # suit macOS');
    expect(out).toContain("# Configuration de test");
    expect(out).toContain('unknown_key = "gardée"');
    expect(out.split("\n").length).toBe(sample.split("\n").length);
  });

  test("set_in_array_table_and_add_keys", () => {
    const doc = TOMLDocument.parse(sample);
    doc.set(TOML.bool(false), ["backup"], ["folders"], 1);
    doc.set(TOML.integer(2), ["big_folder_threshold_gb"], ["analysis"]);
    doc.set(TOML.string("daily"), ["frequency"], ["schedule"]);
    const t = TOMLDocument.parse(doc.render()).tree();
    const folders = t.tables("folders");
    expect(folders.length).toBe(2);
    expect(asBool(folders[1]?.value("backup"))).toBe(false);
    expect(asBool(folders[0]?.value("backup"))).toBe(true);
    expect(asInteger(t.table("analysis")?.value("big_folder_threshold_gb"))).toBe(2);
    expect(asString(t.table("schedule")?.value("frequency"))).toBe("daily");
  });

  test("append_and_remove_array_table", () => {
    const doc = TOMLDocument.parse(sample);
    const i = doc.appendArrayTable(
      ["folders"],
      [
        ["path", TOML.string("/tmp/x")],
        ["backup", TOML.bool(false)],
      ],
    );
    expect(i).toBe(2);
    let t = TOMLDocument.parse(doc.render()).tree();
    expect(t.tables("folders").map((f) => asString(f.value("path")))).toEqual([
      "/Volumes/workspaces",
      "~/Projets",
      "/tmp/x",
    ]);
    doc.removeArrayTable(["folders"], 1);
    t = TOMLDocument.parse(doc.render()).tree();
    expect(t.tables("folders").map((f) => asString(f.value("path")))).toEqual(["/Volumes/workspaces", "/tmp/x"]);
    expect(doc.render()).toContain("# Dossiers suivis");
  });

  test("set_on_empty_document", () => {
    const doc = TOMLDocument.parse("");
    doc.set(TOML.integer(1), ["version"]);
    doc.set(TOML.string("auto"), ["language"]);
    doc.set(TOML.integer(50), ["big_file_threshold_mb"], ["analysis"]);
    const t = TOMLDocument.parse(doc.render()).tree();
    expect(asInteger(t.value("version"))).toBe(1);
    expect(asString(t.value("language"))).toBe("auto");
    expect(asInteger(t.table("analysis")?.value("big_file_threshold_mb"))).toBe(50);
  });

  test("errors_have_line_numbers", () => {
    const line = (text: string): number | null => {
      try {
        TOMLDocument.parse(text);
        return null;
      } catch (e) {
        return e instanceof TOMLError ? e.line : -1;
      }
    };
    expect(line("a = 1\nb = 1979-05-27\n")).toBe(2); // dates non prises en charge
    expect(line('a = 1\n\nc = """multi"""\n')).toBe(3); // chaînes multilignes
    expect(line("a = 1\na = 2\n")).toBe(2); // clé en double
    expect(line('a = "non fermée\n')).toBe(1);
    expect(line("[t]\nx = [1, 2\n")).toBe(3); // tableau non fermé
  });

  test("strings_escaped_on_write", () => {
    const doc = TOMLDocument.parse("");
    doc.set(TOML.string('a "b" \\ c\nd'), ["s"]);
    expect(asString(TOMLDocument.parse(doc.render()).tree().value("s"))).toBe('a "b" \\ c\nd');
  });

  test("crlf_line_endings", () => {
    // « \r\n » est un seul graphème Swift : le commentaire initial ne doit pas avaler tout le fichier.
    const doc = TOMLDocument.parse('# commentaire\r\nversion = 1\r\n\r\n[t]\r\nx = "a"   # note\r\n');
    expect(doc.tree().value("version")).toEqual(TOML.integer(1));
    expect(asString(doc.tree().table("t")?.value("x"))).toBe("a");
    expect(doc.line(["t"], ["x"])).toBe(5);
    doc.set(TOML.integer(2), ["version"]);
    expect(doc.render().startsWith("# commentaire\r\nversion = 2\r\n")).toBe(true);
    expect(TOMLDocument.parse(doc.render()).tree().value("version")).toEqual(TOML.integer(2));
  });

  // Ajouts propres au port TypeScript.

  test("doubles écrits comme String(Double) de Swift", () => {
    // Attendus copiés de la sortie de `String(d)` (Swift 6).
    const cases: Array<[number, string]> = [
      [1e15, "1000000000000000.0"],
      [2 ** 53, "9007199254740992.0"],
      [2 ** 54, "1.8014398509481984e+16"],
      [1e16, "1e+16"],
      [0.0001, "0.0001"],
      [0.00001, "1e-05"],
      [0.00009999, "9.999e-05"],
      [1.5, "1.5"],
      [100, "100.0"],
      [-0, "-0.0"],
      [1e300, "1e+300"],
      [5e-324, "5e-324"],
      [0.1 + 0.2, "0.30000000000000004"],
      [Number.POSITIVE_INFINITY, "inf"],
    ];
    for (const [d, s] of cases) expect(swiftDoubleDescription(d)).toBe(s);
    expect(renderValue(TOML.double(1))).toBe("1.0");
    expect(renderValue(TOML.double(Number.POSITIVE_INFINITY))).toBe("inf.0");
  });

  test("clé ajoutée après une dernière ligne sans saut de ligne final", () => {
    const doc = TOMLDocument.parse("[t]\nx = 1");
    doc.set(TOML.integer(2), ["y"], ["t"]);
    expect(doc.render()).toBe("[t]\nx = 1\ny = 2\n");
  });

  test("valeur non ASCII remplacée à la bonne position", () => {
    const doc = TOMLDocument.parse('a = "é🙂" # 🙂\nb = 1\n');
    doc.set(TOML.string("x"), ["a"]);
    expect(doc.render()).toBe('a = "x" # 🙂\nb = 1\n');
  });

  test("aller-retour octet pour octet sur une copie de ~/.cairn/config.toml", async () => {
    const real = path.join(os.homedir(), ".cairn", "config.toml");
    const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-toml-"));
    try {
      const copy = path.join(dir, "config.toml");
      try {
        await copyFile(real, copy);
      } catch {
        return; // pas de configuration sur cette machine
      }
      const bytes = await readFile(copy);
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const out = Buffer.from(TOMLDocument.parse(text).render(), "utf8");
      expect(out.equals(bytes)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
