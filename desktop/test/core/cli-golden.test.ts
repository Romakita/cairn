// Test d'or de la CLI : chaque commande de la 1ʳᵉ passe (aide, version, analyze, config, tools, ai, git) est lancée
// sur un même CAIRN_HOME d'exemple, par la 0.8.0 (binaire Swift dont le chemin est dans `CAIRN_SWIFT_CLI`, construit
// depuis le tag `v0.8.0` : `swift build -c release --product Cairn --package-path <worktree v0.8.0>/Cairn`) et par
// `runCli`, et les sorties (`--json` et quelques sorties texte) et codes de retour doivent être identiques.
//
// Tout se passe dans un dossier temporaire (config, dépôt git, état) : jamais le vrai `~/.cairn`, aucun `--apply`.
// Le test est sauté, avec un message, sans `CAIRN_SWIFT_CLI`.
//
// Normalisations (seulement ce qui varie légitimement d'une exécution à l'autre) :
// - `analyze` : `duration_seconds` (durée de l'analyse) → 0 ;
// - `ai` : données vivantes du vrai home (les outils IA, cette session comprise, écrivent pendant le test) :
//   `latest_conversation` → "<date>" quand les deux en ont une, tailles comparées à 1 % près, nombre de
//   conversations à 2 près. La 0.8.0 lit toujours le vrai home (elle ignore `HOME`) : pas de home d'exemple possible.
// - `tools` : inventaire réel de la machine (lecture seule), sans normalisation.
// - `backup`, `verify`, `restore` : toujours `--only folders` / `--parts folders` vers une destination locale
//   temporaire (jamais le vrai home ni les vraies destinations ; la restauration reste en simulation). Chaque version
//   sauvegarde dans sa propre copie de l'exemple (`side-swift/`, `side-ts/`) ; sont normalisés le nom de la version
//   (horodatage), le chemin du journal (`logs/backup-<date>.log`), la date et le chemin de la source restaurée, la
//   durée de la ligne texte, et le dossier propre à chaque côté (`side-swift` / `side-ts`).
// Langue « auto » : la 0.8.0 suit les langues préférées de macOS ; `runCli` reçoit les mêmes (`AppleLanguages`),
// comme le main lui passe `app.getPreferredSystemLanguages()`.
//
// Écart voulu (pas une normalisation) : rapport TSV avec plusieurs racines. La 0.8.0 retirait le « / » initial des
// chemins (`hasPrefix(root + "/")` avec `root == ""`) ; la version TypeScript garde le chemin absolu.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { runCli } from "../../src/cli/index.ts";
import { setLanguage } from "../../src/core/l10n.ts";
import { git, makeFixture, removeDir, tempDir } from "../helpers/git-fixture.ts";
import { swiftCli } from "../helpers/native.ts";

const APP = swiftCli() ?? "";
const installed = APP !== "";
if (!installed) console.warn("cli-golden : CAIRN_SWIFT_CLI absent (binaire de la 0.8.0) : test d'or sauté");

const WORKER = path.resolve(import.meta.dir, "../../src/core/git/worker.ts");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

let dir = "";
let configFile = "";
/** Langues préférées de macOS (`defaults read -g AppleLanguages`), comme `app.getPreferredSystemLanguages()`. */
let systemLanguages: string[] = [];

/** 0.8.0, avec un CAIRN_HOME temporaire (l'état vit de toute façon à côté de `--config`). */
async function swift(args: readonly string[]): Promise<Run> {
  const env = { ...process.env, CAIRN_HOME: path.join(dir, "home-swift") };
  try {
    const { stdout, stderr } = await promisify(execFile)(APP, [...args], { env, maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { code: typeof e.code === "number" ? e.code : -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** `runCli`, sorties ligne à ligne comme `print` (une fin de ligne par appel). */
async function typescript(args: readonly string[]): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      out: (t) => {
        stdout += `${t}\n`;
      },
      err: (t) => {
        stderr += `${t}\n`;
      },
    },
    {
      gitWorkerFile: WORKER,
      preferredLanguages: systemLanguages,
      progress: { isTTY: false, write: () => {} },
      // Jamais le vrai home : la sauvegarde et la restauration de la version TypeScript en ont un d'exemple.
      backup: { home: path.join(dir, "home-ts") },
      restore: { home: path.join(dir, "home-ts") },
    },
  );
  return { code, stdout, stderr };
}

/** Lance les deux versions avec `--config <exemple> --lang en-US` (sauf `raw`). */
async function both(args: readonly string[], raw = false): Promise<{ swift: Run; ts: Run }> {
  const full = raw ? args : ["--config", configFile, "--lang", "en-US", ...args];
  return { swift: await swift(full), ts: await typescript(full) };
}

type JSONObject = Record<string, unknown>;

function parse(text: string): JSONObject {
  return JSON.parse(text) as JSONObject;
}

beforeAll(async () => {
  if (!installed) return;
  const { stdout } = await promisify(execFile)("/usr/bin/defaults", ["read", "-g", "AppleLanguages"]).catch(() => ({
    stdout: "",
  }));
  systemLanguages = [...stdout.matchAll(/"?([A-Za-z]{2}[-_A-Za-z0-9]*)"?/g)].map((m) => m[1]!);
  dir = tempDir("cairn-cli-golden-");
  // Dépôt cloné avec branches « gone » et worktrees (work/app, work/app-risk, work/app-old…).
  const repo = makeFixture(dir);
  const work = path.join(dir, "work");
  // Quelques fichiers : un gros fichier (seuil 1 Mo), des dépendances régénérables, des sources.
  mkdirSync(path.join(work, "files/node_modules/pkg"), { recursive: true });
  mkdirSync(path.join(work, "files/src"), { recursive: true });
  writeFileSync(path.join(work, "files/big.bin"), Buffer.alloc(2_000_000));
  writeFileSync(path.join(work, "files/node_modules/pkg/index.js"), Buffer.alloc(300_000, 1));
  writeFileSync(path.join(work, "files/src/main.ts"), "console.log('cairn')\n");
  writeFileSync(path.join(work, "files/package.json"), "{}\n");
  // L'index des worktrees est rafraîchi d'avance : `git status` de la 1ʳᵉ analyse ne change rien pour la 2ᵉ.
  for (const wt of [
    repo,
    path.join(work, "app-risk"),
    path.join(work, "app-old"),
    path.join(repo, ".claude/worktrees/wt"),
  ]) {
    git(wt, "status", "--porcelain");
  }
  configFile = path.join(dir, "config.toml");
  writeFileSync(
    configFile,
    `version = 1
language = "fr-FR"

[analysis]
big_file_threshold_mb = 1
big_folder_threshold_gb = 0.0002
unknown_key = true

[[folders]]
path = "${work}"
backup = true
exclude = ["*.log"]

[[folders]]
path = "/nonexistent-cairn-golden"

[[destinations]]
id = "local"
provider = "local"
path = "${path.join(dir, "dest")}"
encrypted = false
retention = { mode = "count", count = 5 }

[ai.claude-code]
categories = ["config", "memories"]

[schedule]
frequency = "weekly"
weekday = "friday"

[git]
worktree_stale_days = 20

[tools]
excluded = ["jq"]
`,
  );
});

afterEach(() => setLanguage("en-US")); // la langue est globale : les autres suites l'attendent en anglais

afterAll(() => {
  if (dir) removeDir(dir);
});

describe.skipIf(!installed)("cli-golden", () => {
  test("help and version are identical (en and fr)", async () => {
    // Jamais sans argument : la 0.8.0 ouvrirait son interface. `--lang` seul suffit pour « sans commande → aide ».
    for (const args of [
      ["--help"],
      ["help"],
      ["--lang", "fr-FR", "--help"],
      ["--version"],
      ["version"],
      ["--lang", "en-US"],
    ]) {
      const r = await both(args, true);
      expect(r.ts).toEqual(r.swift);
    }
    for (const cmd of ["analyze", "config", "tools", "ai", "git"]) {
      const r = await both([cmd, "--help"]);
      expect(r.ts).toEqual(r.swift);
    }
  }, 30_000);

  test("usage errors: unknown command, unknown option, invalid language", async () => {
    for (const args of [["frobnicate"], ["analyze", "--bogus"], ["git", "--stale-days", "0"], ["config", "nope"]]) {
      const r = await both(args);
      expect(r.ts).toEqual(r.swift);
    }
    const lang = await both(["--lang", "de-DE", "--help"], true);
    expect(lang.ts.code).toBe(2);
    expect(lang.ts.code).toBe(lang.swift.code);
  }, 30_000);

  test("config path, show and validate", async () => {
    for (const args of [
      ["config", "path"],
      ["config", "path", "--json"],
      ["config", "show", "--json"],
      ["config", "show"],
      ["config", "validate", "--json"],
      ["config", "validate"],
    ]) {
      const r = await both(args);
      expect({ args, ...r.ts }).toEqual({ args, ...r.swift });
    }
  }, 30_000);

  test("config validate: missing file, schema error, migration of an old file", async () => {
    const other = path.join(dir, "other.toml");
    const run = async (content: string | null, args: string[]) => {
      const write = () => {
        if (content !== null) writeFileSync(other, content);
      };
      const full = ["--config", other, "--lang", "en-US", ...args];
      write();
      const s = await swift(full);
      write(); // la validation migre le fichier : même point de départ pour les deux
      const t = await typescript(full);
      return { swift: s, ts: t };
    };
    for (const args of [
      ["config", "validate", "--json"],
      ["config", "validate"],
      ["config", "show", "--json"],
    ]) {
      const missing = await run(null, args);
      expect(missing.ts).toEqual(missing.swift);
      const invalid = await run("version = 1\n\n[schedule]\nfrequency = 3\n", args);
      expect(invalid.ts).toEqual(invalid.swift);
      const syntax = await run("version = 1\n[schedule\n", args);
      expect(syntax.ts).toEqual(syntax.swift);
      const old = await run(`root_path = "${dir}/work"\n`, args);
      expect(old.ts).toEqual(old.swift);
    }
  }, 60_000);

  test("analyze --json (configured folders and explicit folder)", async () => {
    const normalize = (text: string) => {
      const obj = parse(text);
      for (const f of obj.folders as JSONObject[]) if ("duration_seconds" in f) f.duration_seconds = 0;
      return obj;
    };
    for (const args of [
      ["analyze", "--json"],
      ["analyze", path.join(dir, "work/files"), "--json"],
    ]) {
      const r = await both(args);
      expect(r.ts.code).toBe(r.swift.code);
      expect(r.ts.stderr).toBe(r.swift.stderr);
      expect(normalize(r.ts.stdout)).toEqual(normalize(r.swift.stdout));
    }
    // Texte : la durée de la ligne de résumé (« …, 0.1 s, 0 errors ») est normalisée.
    const duration = (text: string) => text.replace(/, [\d.,]+ s(ec)?, /g, ", <duration>, ");
    const text = await both(["analyze"]);
    expect(text.ts.code).toBe(text.swift.code);
    expect(text.ts.stderr).toBe(text.swift.stderr);
    expect(duration(text.ts.stdout)).toBe(duration(text.swift.stdout));
    const missing = await both(["analyze", "/nonexistent-cairn-golden"]);
    expect(missing.ts).toEqual(missing.swift);
  }, 60_000);

  test("git --json and text simulation", async () => {
    for (const args of [
      ["git", "--json"],
      ["git", "--json", "--include-unmerged", "--include-at-risk"],
      ["git", "--json", "--worktrees-only", "--stale-days", "90"],
      ["git", "--json", "--only", "nothing-matches"],
      ["git"],
      ["git", "--root", path.join(dir, "work"), "--root", path.join(dir, "work/app")],
    ]) {
      const r = await both(args);
      expect({ args, ...r.ts }).toEqual({ args, ...r.swift });
    }
  }, 120_000);

  test("git --report writes the same TSV", async () => {
    const { readFile } = await import("node:fs/promises");
    const report = async (roots: string[]) => {
      const tsvSwift = path.join(dir, "swift.tsv");
      const tsvTS = path.join(dir, "ts.tsv");
      const rootArgs = roots.flatMap((r) => ["--root", r]);
      const s = await swift(["--config", configFile, "git", "--json", ...rootArgs, "--report", tsvSwift]);
      const t = await typescript(["--config", configFile, "git", "--json", ...rootArgs, "--report", tsvTS]);
      expect(t.code).toBe(s.code);
      return { swift: await readFile(tsvSwift, "utf8"), ts: await readFile(tsvTS, "utf8") };
    };
    // Une seule racine : dépôts relatifs à elle, mêmes octets.
    const single = await report([path.join(dir, "work")]);
    expect(single.ts).toBe(single.swift);
    expect(single.ts).toContain("\napp\tfeat-merged\tmerged\t");
    // Plusieurs racines (dossiers de config.toml) : écart voulu, voir l'en-tête.
    const several = await report([]);
    expect(several.ts).toBe(several.swift.replaceAll(`\n${dir.slice(1)}/`, `\n${dir}/`));
  }, 120_000);

  test("tools --json (real inventory, read only)", async () => {
    const saved = process.env.CAIRN_TOOLS_INVENTORY;
    delete process.env.CAIRN_TOOLS_INVENTORY;
    try {
      const r = await both(["tools", "--json"]);
      expect(r.ts.code).toBe(r.swift.code);
      expect(parse(r.ts.stdout)).toEqual(parse(r.swift.stdout));
      expect(r.ts.stdout).toBe(r.swift.stdout);
      const text = await both(["tools"]);
      expect(text.ts).toEqual(text.swift);
    } finally {
      process.env.CAIRN_TOOLS_INVENTORY = saved;
    }
  }, 120_000);

  test("ai --json (real home, read only)", async () => {
    const r = await both(["ai", "--json"]);
    expect(r.ts.code).toBe(r.swift.code);
    const a = (parse(r.ts.stdout).tools as JSONObject[]) ?? [];
    const b = (parse(r.swift.stdout).tools as JSONObject[]) ?? [];
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    const close = (x: number, y: number) => Math.abs(x - y) <= Math.max(0.01 * Math.max(x, y), 1_000_000);
    for (const [i, x] of a.entries()) {
      const y = b[i]!;
      const fixed = (o: JSONObject) => ({
        id: o.id,
        detected: o.detected,
        selected_categories: o.selected_categories,
        credentials_in_keychain: o.credentials_in_keychain,
        categories: Object.keys(o.bytes_by_category as JSONObject).sort(),
        latest_conversation: o.latest_conversation === null ? null : "<date>",
      });
      expect(fixed(x)).toEqual(fixed(y));
      for (const k of ["total_bytes", "not_copied_bytes"]) {
        expect({ id: x.id, k, ok: close(x[k] as number, y[k] as number), ts: x[k], swift: y[k] }).toMatchObject({
          ok: true,
        });
      }
      const xb = x.bytes_by_category as Record<string, number>;
      const yb = y.bytes_by_category as Record<string, number>;
      for (const k of Object.keys(yb)) {
        expect({ id: x.id, k, ok: close(xb[k] ?? 0, yb[k] ?? 0), ts: xb[k], swift: yb[k] }).toMatchObject({ ok: true });
      }
      expect(Math.abs((x.conversations as number) - (y.conversations as number))).toBeLessThanOrEqual(2);
    }
  }, 120_000);

  test("backup, verify and restore (temporary local destination, folders only)", async () => {
    // Une copie de l'exemple par côté : destination, état et journaux séparés, mêmes fichiers source.
    const side = (name: string) => {
      const root = path.join(dir, name);
      mkdirSync(path.join(root, "src/sub"), { recursive: true });
      for (const i of [1, 2, 3]) writeFileSync(path.join(root, `src/f${i}.bin`), Buffer.alloc(10_000 + i, i));
      writeFileSync(path.join(root, "src/sub/a.txt"), "cairn\n");
      mkdirSync(path.join(root, "src/node_modules/x"), { recursive: true });
      writeFileSync(path.join(root, "src/node_modules/x/index.js"), "x\n");
      const cfg = path.join(root, "config.toml");
      writeFileSync(
        cfg,
        `version = 1\n[[folders]]\npath = "${root}/src"\n[[destinations]]\nid = "local"\nprovider = "local"\npath = "${root}/dest"\nencrypted = false\n`,
      );
      return { root, cfg };
    };
    const S = side("side-swift");
    const T = side("side-ts");
    const normalize = (text: string, root: string) =>
      text
        .replaceAll(root, "<side>")
        .replaceAll(root.replaceAll("/", "\\/"), "<side>") // JSON : `/` échappé
        .replace(/\d{4}-\d{2}-\d{2}T\d{6}/g, "<version>")
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<date>")
        .replace(/(backup|backup-dry-run)-[0-9T:-]+\.log/g, "$1-<date>.log")
        .replace(/ in [\d.,]+ s(ec)?\b/g, " in <duration>")
        .replace(/ of [A-Z][a-z]{2} \d+, \d{4} at \d+:\d{2}\u202f?[AP]M/g, " of <date>");
    // Ajouts de la 0.9 absents de la 0.8.0 (Accès complet au disque) : clés JSON `full_disk_access` et
    // `permission_denied`, avertissement sur stderr quand l'accès est refusé à la machine qui lance les tests.
    const withoutAccess = (x: string) =>
      x
        .replace(/^\s*"full_disk_access" : "\w+",\n/gm, "")
        .replace(/^\s*"permission_denied" : \{[\s\S]*?\n\s*\},\n/gm, "")
        .replace(/^Warning: no Full Disk Access\..*\n/gm, "");
    const pair = async (args: (cfg: string, root: string) => string[]) => {
      const s = await swift(["--lang", "en-US", ...args(S.cfg, S.root)]);
      const t = await typescript(["--lang", "en-US", ...args(T.cfg, T.root)]);
      return {
        swift: { ...s, stdout: normalize(s.stdout, S.root), stderr: normalize(s.stderr, S.root) },
        ts: {
          ...t,
          stdout: withoutAccess(normalize(t.stdout, T.root)),
          stderr: withoutAccess(normalize(t.stderr, T.root)),
        },
      };
    };
    // Erreurs d'usage, détectées avant toute écriture (code 2).
    for (const args of [
      (c: string) => ["backup", "--tool", "no-such-tool", "--config", c],
      (c: string) => ["backup", "--destination", "nope", "--config", c],
      (c: string) => ["backup", "--only", "bogus", "--config", c],
      (_c: string, r: string) => ["backup", "--config", path.join(r, "none.toml")],
      (c: string) => ["verify", "--version", "1999-01-01T000000", "--config", c],
      (c: string) => ["verify", "--destination", "nope", "--config", c],
      (c: string) => ["restore", "--destination", "nope", "--config", c],
    ]) {
      const r = await pair(args);
      expect(r.ts).toEqual(r.swift);
    }
    expect(existsSync(path.join(S.root, "dest"))).toBe(false);
    expect(existsSync(path.join(T.root, "dest"))).toBe(false);
    // Simulation, puis vraie sauvegarde (JSON et texte), vérification complète.
    for (const args of [
      (c: string) => ["backup", "--dry-run", "--only", "folders", "--json", "--config", c],
      (c: string) => ["backup", "--only", "folders", "--json", "--config", c],
      (c: string) => ["backup", "--only", "folders", "--config", c],
      (c: string) => ["backup", "--dry-run", "--only", "folders", "--config", c],
      (c: string) => ["verify", "--full", "--json", "--config", c],
      (c: string) => ["verify", "--config", c],
      (c: string) => ["restore", "--parts", "folders", "--json", "--config", c],
      (c: string, r: string) => ["restore", "--parts", "folders", "--target", `src=${r}/restored`, "--config", c],
      (c: string) => ["restore", "--check", "--json", "--config", c],
      (c: string) => ["restore", "--tool", "codex", "--config", c],
    ]) {
      // Les versions sont nommées à la seconde : deux vraies sauvegardes dans la même seconde se heurteraient.
      const a = args("", "");
      if (a[0] === "backup" && !a.includes("--dry-run")) await new Promise((resolve) => setTimeout(resolve, 1100));
      const r = await pair(args);
      // Progression (stderr) : une ligne par pourcentage, dont le rythme dépend de rsync ; seules les autres lignes
      // sont comparées.
      const quiet = (x: Run) => ({ ...x, stderr: x.stderr.replace(/^local · .*\n/gm, "") });
      expect({ args: args("<cfg>", "<side>"), ...quiet(r.ts) }).toEqual({
        args: args("<cfg>", "<side>"),
        ...quiet(r.swift),
      });
    }
    // Restauration depuis un dossier de version (--from), en simulation : rien n'est écrit.
    const from = async (root: string) => {
      const m = (await import("node:fs")).readdirSync(path.join(root, "dest/cairn"))[0]!;
      const versions = (await import("node:fs")).readdirSync(path.join(root, "dest/cairn", m, "versions")).sort();
      return path.join(root, "dest/cairn", m, "versions", versions.at(-1)!);
    };
    const vs = await from(S.root);
    const vt = await from(T.root);
    const r = await pair((_c, root) => [
      "restore",
      "--from",
      root === S.root ? vs : vt,
      "--parts",
      "folders",
      "--json",
    ]);
    expect(r.ts).toEqual(r.swift);
    expect(existsSync(path.join(S.root, "restored"))).toBe(false);
    expect(existsSync(path.join(T.root, "restored"))).toBe(false);
  }, 180_000);
});
