// Ligne de commande (port de CLITests.swift et des cas CLI de ConfigTests `cli_config_commands`, AnalysisTests
// `cli_analyze_uses_config_folders`, GitTests `simulation_changes_nothing` et `cli_apply_worktrees_only_and_tsv_report`).
// `runCli` est appelé directement, avec des sorties simulées ; tout se passe dans des dossiers temporaires.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { type CliContext, cliContextForApp, Exit, runCli } from "../../src/cli/index.ts";
import { isYes, readHidden, readLine } from "../../src/cli/prompt.ts";
import { pad } from "../../src/cli/shared.ts";
import { loadRunState } from "../../src/core/backup/run-state.ts";
import { listVersions, versionsDir } from "../../src/core/backup/versions.ts";
import { setLanguage } from "../../src/core/l10n.ts";
import { OperationLock } from "../../src/core/lock.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { CAIRN_VERSION } from "../../src/core/version.ts";
import { git, makeFixture, removeDir, tempDir } from "../helpers/git-fixture.ts";
import { nativeAvailable } from "../helpers/native.ts";

const WORKER = path.resolve(import.meta.dir, "../../src/core/git/worker.ts");

interface Run {
  code: number;
  out: string;
  err: string;
}

/** `runCli` avec des sorties simulées (une fin de ligne par appel, comme `print`). */
async function run(args: string[], context: CliContext = {}): Promise<Run> {
  let out = "";
  let err = "";
  const code = await runCli(
    args,
    {
      out: (t) => {
        out += `${t}\n`;
      },
      err: (t) => {
        err += `${t}\n`;
      },
    },
    { gitWorkerFile: WORKER, progress: { isTTY: false, write: () => {} }, ...context },
  );
  return { code, out, err };
}

const dirs: string[] = [];
function temp(): string {
  const d = tempDir("cairn-cli-");
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
  setLanguage("en-US"); // la langue est globale : les autres suites l'attendent en anglais
});

function writeSized(file: string, size: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(size));
}

describe("cli", () => {
  test("help in both languages", async () => {
    const en = await run(["--help", "--lang", "en-US"]);
    expect(en.code).toBe(Exit.ok);
    expect(en.out).toContain("Commands:");
    const fr = await run(["--lang", "fr-FR", "--help"]);
    expect(fr.code).toBe(Exit.ok);
    expect(fr.out).toContain("Commandes :");
    for (const args of [["help"], ["-h"], []]) {
      expect(await run([...args, "--lang", "en-US"])).toEqual({ code: Exit.ok, out: en.out, err: "" });
    }
  });

  test("each command has its own help", async () => {
    for (const cmd of ["analyze", "config", "tools", "ai", "git", "backup", "verify", "restore"]) {
      const r = await run([cmd, "--help", "--lang", "en-US"]);
      expect({ cmd, code: r.code }).toEqual({ cmd, code: Exit.ok });
      expect(r.out).toContain("Usage: cairn");
    }
  });

  test("unknown command is a usage error", async () => {
    const r = await run(["frobnicate", "--lang", "en-US"]);
    expect(r.code).toBe(Exit.usage);
    expect(r.err).toContain("Unknown command: frobnicate");
    expect(r.err).toContain("Commands:"); // l'aide suit, sur stderr
    expect(r.out).toBe("");
  });

  test("invalid language and missing option values are usage errors", async () => {
    expect((await run(["--lang", "de-DE", "--help"])).code).toBe(Exit.usage);
    expect((await run(["--help", "--lang"])).code).toBe(Exit.usage);
    expect((await run(["analyze", "--config"])).code).toBe(Exit.usage);
    expect((await run(["--lang", "auto", "--help"])).code).toBe(Exit.ok);
    expect((await run(["git", "--stale-days", "0", "--lang", "en-US"])).err).toContain("--stale-days");
    expect((await run(["git", "--stale-days", "abc"])).code).toBe(Exit.usage);
    expect((await run(["tools", "--export"])).code).toBe(Exit.usage);
  });

  test("unknown option is a usage error, --yes is accepted everywhere", async () => {
    const dir = temp();
    for (const cmd of [["analyze", dir], ["config", "path"], ["ai"], ["tools"]]) {
      expect((await run([...cmd, "--bogus"])).code).toBe(Exit.usage);
      expect((await run([...cmd, "--yes"])).code).toBe(Exit.ok);
      expect((await run([...cmd, "-y"])).code).toBe(Exit.ok);
    }
  }, 30_000); // lance analyze, ai et tools : plusieurs secondes sur une machine chargée

  test("version", async () => {
    const r = await run(["--version"]);
    expect(r).toEqual({ code: Exit.ok, out: `cairn ${CAIRN_VERSION}\n`, err: "" });
    expect((await run(["version"])).out).toBe(r.out);
    expect(CAIRN_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  });

  test("analyze --json is valid", async () => {
    const dir = temp();
    writeSized(path.join(dir, "a/file.bin"), 200_000);
    const r = await run(["analyze", dir, "--json"]);
    expect(r.code).toBe(Exit.ok);
    const obj = JSON.parse(r.out);
    expect(obj.folders).toHaveLength(1);
    expect(obj.folders[0].size).toBeGreaterThanOrEqual(200_000);
    expect(obj.total).toBe(obj.folders[0].size);
    expect(Object.keys(obj.folders[0].breakdown)).toEqual([
      "build",
      "cache",
      "deps",
      "git",
      "ios",
      "python",
      "source",
      "trash",
    ]);
    expect(r.out).toStartWith('{\n  "folders" : [\n'); // JSON au format de Foundation
  });

  test("analyze of a missing folder fails", async () => {
    const r = await run(["analyze", "/nonexistent-cairn-test", "--lang", "en-US"]);
    expect(r.code).toBe(Exit.failure);
    expect(r.err).toContain("Folder not found: /nonexistent-cairn-test");
  });

  test("analyze uses the configured folders without touching config.toml", async () => {
    const dir = temp();
    const data = path.join(dir, "data");
    writeSized(path.join(data, "big.bin"), 2_000_000);
    const cfg = path.join(dir, "c.toml");
    const text = `version = 1\n[analysis]\nbig_file_threshold_mb = 1\n[[folders]]\npath = "${data}"\n[[folders]]\npath = "/nonexistent-cairn"\n`;
    writeFileSync(cfg, text);
    const r = await run(["analyze", "--json", "--config", cfg]);
    expect(r.code).toBe(Exit.ok);
    const folders = JSON.parse(r.out).folders as Array<{ available: boolean; big_objects?: Array<{ kind: string }> }>;
    expect(folders.map((f) => f.available)).toEqual([true, false]);
    expect(folders[0]?.big_objects?.[0]?.kind).toBe("file");
    expect(readFileSync(cfg, "utf8")).toBe(text);
    expect(existsSync(path.join(dir, "state"))).toBe(false); // l'analyse en CLI n'écrit rien à côté
  });

  test("analyze text report and code 1 when no folder is available", async () => {
    const dir = temp();
    writeSized(path.join(dir, "node_modules/x/a.js"), 100_000);
    writeSized(path.join(dir, "src/main.ts"), 10);
    const r = await run(["analyze", dir, "--lang", "en-US"]);
    expect(r.code).toBe(Exit.ok);
    expect(r.out).toContain(`${dir} — `);
    expect(r.out).toContain("Folders:");
    expect(r.out).toContain("Big objects:");
    const cfg = path.join(dir, "c.toml");
    writeFileSync(cfg, 'version = 1\n[[folders]]\npath = "/nonexistent-cairn-a"\n');
    const none = await run(["analyze", "--config", cfg, "--lang", "en-US"]);
    expect(none.code).toBe(Exit.failure);
    expect(none.err).toContain("/nonexistent-cairn-a");
  });

  test("config commands", async () => {
    const dir = temp();
    const file = path.join(dir, "c.toml");
    const r0 = await run(["config", "validate", "--config", file, "--lang", "en-US"]);
    expect(r0.code).toBe(Exit.usage);
    expect(r0.err).toContain("No configuration file");
    const r1 = await run(["config", "show", "--config", file]);
    expect(r1.code).toBe(Exit.ok);
    expect(r1.out).toContain('frequency = "daily"');
    writeFileSync(file, "version = 1\n\n[schedule]\nfrequency = 3\n");
    const r2 = await run(["config", "validate", "--config", file, "--lang", "en-US"]);
    expect(r2.code).toBe(Exit.usage);
    expect(r2.err).toContain("line 4");
    expect(r2.err).toContain("schedule.frequency");
    writeFileSync(file, 'version = 1\nlanguage = "fr-FR"\n');
    const r3 = await run(["config", "validate", "--config", file]);
    expect(r3.code).toBe(Exit.ok);
    expect(r3.out).toContain("Configuration valide"); // la langue de config.toml s'applique
    const r4 = await run(["config", "path", "--config", file]);
    expect(r4.code).toBe(Exit.ok);
    expect(r4.out.trim()).toBe(file);
    expect(JSON.parse((await run(["config", "path", "--json", "--config", file])).out)).toEqual({
      exists: true,
      path: file,
    });
  });

  test("config validate migrates an old file and keeps a .bak", async () => {
    const dir = temp();
    const file = path.join(dir, "c.toml");
    writeFileSync(file, `root_path = "${dir}"\n`);
    const r = await run(["config", "validate", "--json", "--config", file]);
    expect(r.code).toBe(Exit.ok);
    const obj = JSON.parse(r.out);
    expect(obj).toMatchObject({ migrated: true, valid: true, backup: `${file}.bak` });
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(`root_path = "${dir}"\n`);
    expect(readFileSync(file, "utf8")).toContain("version = 1");
  });

  test("config show --json writes doubles like Foundation (%.17g)", async () => {
    const dir = temp();
    const file = path.join(dir, "c.toml");
    writeFileSync(file, "version = 1\n[analysis]\nbig_folder_threshold_gb = 0.1\n[alerts]\nlow_percent = 12.5\n");
    const r = await run(["config", "show", "--json", "--config", file]);
    expect(r.out).toContain('"big_folder_threshold_gb" : 0.10000000000000001');
    expect(r.out).toContain('"low_percent" : 12.5');
    expect(r.out).toContain('"critical_gb" : 5');
  });

  test("language comes from config.toml, --lang wins for this run", async () => {
    const dir = temp();
    const file = path.join(dir, "c.toml");
    writeFileSync(file, 'version = 1\nlanguage = "fr-FR"\n');
    expect((await run(["--config", file, "--help"])).out).toContain("Commandes :");
    expect((await run(["--config", file, "--lang", "en-US", "--help"])).out).toContain("Commands:");
    // « auto » : langues préférées du système passées par le main.
    writeFileSync(file, 'version = 1\nlanguage = "auto"\n');
    expect((await run(["--config", file, "--help"], { preferredLanguages: ["fr-CA"] })).out).toContain("Commandes :");
  });

  test("tools and ai answer in JSON with stable codes", async () => {
    const tools = await run(["tools", "--json"]);
    expect(tools.code).toBe(Exit.ok);
    expect(JSON.parse(tools.out)).toEqual({ taps: [], tools: [] }); // inventaire vide sous test
    const dir = temp();
    const exported = await run(["tools", "--export", path.join(dir, "out"), "--lang", "en-US"]);
    expect(exported.code).toBe(Exit.ok);
    expect(exported.out).toBe("");
    expect(exported.err).toContain("0 tools exported");
    expect(existsSync(path.join(dir, "out/tools.toml"))).toBe(true);
    expect(existsSync(path.join(dir, "out/Brewfile"))).toBe(true);
    const ai = await run(["ai", "--json"]);
    expect(ai.code).toBe(Exit.ok);
    const ids = (JSON.parse(ai.out).tools as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("claude-code");
  }, 60_000);

  test("git simulation changes nothing", async () => {
    const dir = temp();
    const repo = makeFixture(dir);
    const before = git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
    const r = await run(["git", "--root", path.join(dir, "work"), "--lang", "en-US"]);
    expect(r.code).toBe(Exit.ok);
    expect(r.out).toContain("SIMULATION");
    expect(r.out).toContain("Simulation: nothing was changed");
    expect(git(repo, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(before);
    // --apply sans --yes, réponse négative : annulé, rien ne change.
    const cancelled = await run(["git", "--root", path.join(dir, "work"), "--apply", "--lang", "en-US"], {
      confirm: async () => false,
    });
    expect(cancelled.code).toBe(Exit.failure);
    expect(cancelled.err).toContain("Cancelled.");
    expect(git(repo, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(before);
  }, 60_000);

  test("git --json reports branches and worktrees with the default selection", async () => {
    const dir = temp();
    makeFixture(dir);
    const r = await run(["git", "--root", path.join(dir, "work"), "--json"]);
    expect(r.code).toBe(Exit.ok);
    const [repo] = JSON.parse(r.out).repos as Array<{
      branches: Array<{ name: string; status: string; selected: boolean }>;
      worktrees: Array<{ path: string; status: string; selected: boolean }>;
    }>;
    const branch = (n: string) => repo?.branches.find((b) => b.name === n);
    expect(branch("feat-merged")).toMatchObject({ status: "merged", selected: true });
    expect(branch("feat-squash")).toMatchObject({ status: "squash", selected: true });
    expect(branch("feat-wip")).toMatchObject({ status: "unmerged", selected: false });
    const wt = (suffix: string) => repo?.worktrees.find((w) => w.path.endsWith(suffix));
    expect(wt("app-risk")).toMatchObject({ status: "risk", selected: false });
    expect(wt("app-orphan")).toMatchObject({ status: "orphan", selected: true });
  }, 60_000);

  test("git progress goes to stderr only on a terminal (ef55c5b)", async () => {
    const dir = temp();
    makeFixture(dir);
    const root = path.join(dir, "work");
    const written: string[] = [];
    const tty = { isTTY: true, write: (t: string) => void written.push(t) };
    await run(["git", "--root", root, "--lang", "en-US"], { progress: tty });
    expect(written.some((t) => t.endsWith("\r") && t.includes("repositories"))).toBe(true);
    expect(written.at(-1)).toBe("\n");
    written.length = 0;
    await run(["git", "--root", root, "--json"], { progress: tty });
    expect(written).toEqual([]);
    await run(["git", "--root", root], { progress: { isTTY: false, write: (t) => void written.push(t) } });
    expect(written).toEqual([]);
  }, 60_000);

  test.skipIf(!nativeAvailable())(
    "git --apply --worktrees-only --yes writes the TSV report and keeps branches",
    async () => {
      const dir = temp();
      const repo = makeFixture(dir);
      const report = path.join(dir, "report.tsv");
      const r = await run([
        "git",
        "--root",
        path.join(dir, "work"),
        "--worktrees-only",
        "--apply",
        "--yes",
        "--no-gc",
        "--report",
        report,
      ]);
      expect(r.code).toBe(Exit.ok);
      const tsv = readFileSync(report, "utf8");
      expect(tsv).toStartWith("repo\tbranche\tstatut\tsha\tdernier_commit\tsujet\n");
      expect(tsv).toContain("\tfeat-squash\tsquash\t");
      // Branches intactes (worktrees seulement), worktree à risque gardé, orphelin retiré de git.
      expect(git(repo, "branch", "--list", "feat-merged")).toContain("feat-merged");
      const list = git(repo, "worktree", "list");
      expect(list).toContain("app-risk");
      expect(list).not.toContain("app-orphan");
      expect(list).not.toContain("/wt ");
      expect(existsSync(path.join(dir, "work/app-risk/dirty.txt"))).toBe(true);
    },
    60_000,
  );

  test.skipIf(!nativeAvailable())(
    "git --apply refuses while another operation holds the lock",
    async () => {
      const dir = temp();
      const repo = makeFixture(dir);
      const cfg = path.join(dir, "c.toml");
      writeFileSync(cfg, "version = 1\n");
      const lock = new OperationLock({ stateDir: new CairnPaths(dir).state });
      await lock.acquire("backup");
      try {
        const before = git(repo, "for-each-ref", "--format=%(refname)");
        const r = await run(["git", "--config", cfg, "--root", path.join(dir, "work"), "--apply", "--yes"]);
        expect(r.code).toBe(Exit.failure);
        expect(r.err).toContain("A backup or restore is already running.");
        expect(git(repo, "for-each-ref", "--format=%(refname)")).toBe(before);
      } finally {
        await lock.release();
      }
    },
    60_000,
  );

  test("app context points to the bundled git worker", () => {
    expect(cliContextForApp("/Applications/Cairn.app/Contents/Resources/app.asar")).toEqual({
      gitWorkerFile: "/Applications/Cairn.app/Contents/Resources/app.asar/dist/git-worker.cjs",
      preferredLanguages: undefined,
    });
  });
});

describe("cli prompts", () => {
  test("confirmation accepts o, oui, y, yes (any case)", async () => {
    for (const a of ["o", "oui", "y", "yes", "YES", "Oui"]) expect(isYes(a)).toBe(true);
    for (const a of ["", "n", "non", "no", " y", null]) expect(isYes(a)).toBe(false);
    const input = new PassThrough();
    const answer = readLine(input);
    input.write("ou");
    input.write("i\r\nignored\n");
    expect(await answer).toBe("oui");
    const closed = new PassThrough();
    const none = readLine(closed);
    closed.end();
    expect(await none).toBeNull();
  });

  test("hidden input: no echo, backspace, cancel", async () => {
    const read = async (keys: string) => {
      const input = new PassThrough();
      const output = new PassThrough();
      let shown = "";
      output.on("data", (d) => {
        shown += d.toString();
      });
      const value = readHidden(input, output, "Password:");
      input.write(keys);
      return { value: await value, shown };
    };
    expect(await read("secrex\u007ft\r")).toEqual({ value: "secret", shown: "Password: \n" });
    expect((await read("abc\u0003")).value).toBeNull();
    expect((await read("\n")).value).toBeNull();
    expect((await read("\u0004")).value).toBeNull();
  });

  test("padding truncates like String.padding(toLength:)", () => {
    expect(pad("abc", 5)).toBe("abc  ");
    expect(pad("abcdef", 3)).toBe("abc");
    expect(pad("é✓", 3)).toBe("é✓ ");
  });
});

// Port des cas CLI de BackupWarningTests.swift (`cli_verify_*`, `cli_backup_unknown_tool_is_usage_error`,
// `yes_is_accepted_everywhere`, `cli_config_json`, `cli_restore_json`) et RestoreWarningTests.swift
// (`cli_restore_tool_option`). Destination locale temporaire, home d'exemple, machine nommée « test-mac ».
const MACHINE = "test-mac";

interface Sample {
  dir: string;
  src: string;
  dest: string;
  cfg: string;
  context: CliContext;
}

/** Un dossier source et une destination locale non chiffrée (`setup` de BackupWarningTests). */
function sample(files = 3): Sample {
  const dir = temp();
  const src = path.join(dir, "src");
  const dest = path.join(dir, "dest");
  for (let i = 0; i < files; i++) writeSized(path.join(src, `f${i}.bin`), 10_000 + i);
  const cfg = path.join(dir, ".cairn/config.toml");
  mkdirSync(path.dirname(cfg), { recursive: true });
  writeFileSync(
    cfg,
    `version = 1\n[[folders]]\npath = "${src}"\n[[destinations]]\nid = "local"\nprovider = "local"\npath = "${dest}"\nencrypted = false\n`,
  );
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  return { dir, src, dest, cfg, context: { backup: { home, machine: MACHINE }, restore: { home } } };
}

async function backedUp(s: Sample): Promise<string> {
  const r = await run(["backup", "--only", "folders", "--config", s.cfg], s.context);
  expect(r.code).toBe(Exit.ok);
  const dir = versionsDir(s.dest, MACHINE);
  return path.join(dir, (await listVersions(dir)).at(-1)!);
}

/** Abîme un fichier sans changer sa taille. */
function corrupt(file: string): void {
  const size = readFileSync(file).length;
  writeFileSync(file, Buffer.alloc(size, 0x5a));
}

const native = nativeAvailable();

describe("cli backup, verify, restore", () => {
  test("backup: usage errors are detected before anything is written", async () => {
    const s = sample();
    const tool = await run(["backup", "--tool", "no-such-tool", "--config", s.cfg, "--lang", "en-US"], s.context);
    expect(tool.code).toBe(Exit.usage);
    expect(tool.err).toContain("no-such-tool");
    expect((await run(["backup", "--destination", "nope", "--config", s.cfg], s.context)).code).toBe(Exit.usage);
    expect((await run(["backup", "--only", "bogus", "--config", s.cfg], s.context)).code).toBe(Exit.usage);
    const missing = await run(["backup", "--config", path.join(s.dir, "none.toml"), "--lang", "en-US"], s.context);
    expect(missing.code).toBe(Exit.usage);
    expect(missing.err).toContain("No configuration file");
    const empty = path.join(s.dir, "empty.toml");
    writeFileSync(empty, "version = 1\n");
    expect((await run(["backup", "--config", empty, "--lang", "en-US"], s.context)).err).toContain(
      "No backup destination configured.",
    );
    const invalid = path.join(s.dir, "invalid.toml");
    writeFileSync(invalid, "version = 1\n[schedule]\nfrequency = 3\n");
    expect((await run(["backup", "--config", invalid], s.context)).code).toBe(Exit.usage);
    expect(existsSync(s.dest)).toBe(false); // rien n'est lancé
  });

  test.skipIf(!native)(
    "backup --dry-run --yes --json, then a real backup with progress on stderr",
    async () => {
      const s = sample();
      const dry = await run(
        ["backup", "--dry-run", "--only", "folders", "--yes", "--json", "--config", s.cfg],
        s.context,
      );
      expect(dry.code).toBe(Exit.ok);
      const [result] = JSON.parse(dry.out).results;
      expect(result).toMatchObject({ destination: "local", dry_run: true, version: null, error: null, waiting: false });
      expect(result.files_transferred).toBe(3);
      expect(existsSync(s.dest)).toBe(false); // une simulation n'écrit rien
      const real = await run(["backup", "--only", "folders", "--config", s.cfg, "--lang", "en-US"], s.context);
      expect(real.code).toBe(Exit.ok);
      expect(real.out).toMatch(/^local: version \d{4}-\d{2}-\d{2}T\d{6} — 3 files, /);
      expect(real.out).toContain("  folders/src ");
      expect(real.err).toContain("local · counting files…");
      // Une copie de 3 fichiers peut finir en moins de 100 ms, entre deux envois de progression (10 par seconde) :
      // la ligne de pourcentage est alors absente. Quand elle est là, elle a ce format.
      const percentLines = real.err.split("\n").filter((line) => line.includes(" % ("));
      for (const line of percentLines) expect(line).toMatch(/^local · folders\/src · \d+ % \(/);
    },
    60_000,
  );

  test.skipIf(!native)(
    "backup without Full Disk Access: warning first, denied items counted, stable JSON keys",
    async () => {
      // Un échantillon par exécution : deux versions dans la même seconde auraient le même nom.
      const denied = (): { s: Sample; locked: string } => {
        const s = sample();
        const locked = path.join(s.src, "Documents");
        writeSized(path.join(locked, "a.bin"), 100);
        chmodSync(locked, 0);
        return { s, locked };
      };
      const samples: Sample[] = [];
      try {
        const a = denied();
        samples.push(a.s);
        const context: CliContext = { ...a.s.context, fullDiskAccess: async () => "denied" };
        const text = await run(["backup", "--only", "folders", "--config", a.s.cfg, "--lang", "en-US"], context);
        expect(text.code).toBe(Exit.ok); // un succès avec avertissement
        expect(text.err.split("\n")[0]).toStartWith("Warning: no Full Disk Access. Documents, Downloads");
        expect(text.err).toContain("local: 1 item(s) not backed up: macOS denied access (Full Disk Access needed)");
        expect(text.err).toContain(`  ✗ ${a.locked}`);

        const b = denied();
        samples.push(b.s);
        const json = await run(["backup", "--only", "folders", "--json", "--config", b.s.cfg, "--lang", "fr-FR"], {
          ...b.s.context,
          fullDiskAccess: async () => "denied",
        });
        expect(json.code).toBe(Exit.ok);
        expect(json.err).not.toContain("Accès complet au disque");
        const out = JSON.parse(json.out);
        expect(out.full_disk_access).toBe("denied");
        expect(out.results[0].permission_denied).toEqual({ count: 1, examples: [b.locked] });

        // Accès accordé, rien de refusé : ni avertissement, ni élément compté.
        const c = sample();
        samples.push(c);
        const ok = await run(["backup", "--only", "folders", "--json", "--config", c.cfg], {
          ...c.context,
          fullDiskAccess: async () => "granted",
        });
        const okOut = JSON.parse(ok.out);
        expect(okOut.full_disk_access).toBe("granted");
        expect(okOut.results[0].permission_denied).toEqual({ count: 0, examples: [] });
      } finally {
        // Copié sans droit de lecture dans la version aussi : rétabli partout pour le nettoyage.
        for (const s of samples) execFileSync("/bin/chmod", ["-R", "u+rwx", s.dir]);
      }
    },
    60_000,
  );

  test.skipIf(!native)(
    "backup and verify refuse while another operation holds the lock",
    async () => {
      const s = sample();
      await backedUp(s);
      const lock = new OperationLock({ stateDir: new CairnPaths(path.dirname(s.cfg)).state });
      await lock.acquire("backup");
      try {
        for (const cmd of [["backup", "--only", "folders"], ["verify"]]) {
          const r = await run([...cmd, "--config", s.cfg, "--lang", "en-US"], s.context);
          expect(r.code).toBe(Exit.failure);
          expect(r.err).toContain("already running");
        }
      } finally {
        await lock.release();
      }
    },
    60_000,
  );

  test.skipIf(!native)(
    "verify writes the state and JSON, damaged file → code 1, no duplicate",
    async () => {
      const s = sample();
      const v = await backedUp(s);
      corrupt(path.join(v, "folders/src/f0.bin"));
      const r = await run(["verify", "--full", "--json", "--yes", "--config", s.cfg], s.context);
      expect(r.code).toBe(Exit.failure);
      const [first] = JSON.parse(r.out).results;
      expect(first.version).toBe(path.basename(v));
      expect(first.damaged).toEqual(["folders/src/f0.bin"]);
      expect(first.checked).toBeGreaterThanOrEqual(3);
      const paths = new CairnPaths(path.dirname(s.cfg));
      const ds = (await loadRunState(paths)).destinations.local;
      expect(ds?.lastVerification).toBeInstanceOf(Date);
      expect(ds?.damagedVersions).toEqual([path.basename(v)]);
      await run(["verify", "--full", "--config", s.cfg], s.context);
      expect((await loadRunState(paths)).destinations.local?.damagedVersions).toEqual([path.basename(v)]);
      const text = await run(["verify", "--config", s.cfg, "--lang", "en-US"], s.context);
      expect(text.out).toContain(`local ${path.basename(v)}: `);
      expect(text.err).toContain("  ✗ folders/src/f0.bin");
    },
    60_000,
  );

  test.skipIf(!native)(
    "verify: unknown version is a usage error",
    async () => {
      const s = sample();
      await backedUp(s);
      const r = await run(
        ["verify", "--version", "1999-01-01T000000", "--config", s.cfg, "--lang", "en-US"],
        s.context,
      );
      expect(r.code).toBe(Exit.usage);
      expect(r.err).toContain("Unknown version");
      expect((await run(["verify", "--destination", "nope", "--config", s.cfg], s.context)).code).toBe(Exit.usage);
    },
    60_000,
  );

  test.skipIf(!native)(
    "restore --json is a simulation; --check reports tools",
    async () => {
      const s = sample();
      const v = await backedUp(s);
      const target = path.join(s.dir, "restored");
      const r = await run(
        ["restore", "--from", v, "--parts", "folders", "--target", `src=${target}`, "--json"],
        s.context,
      );
      expect(r.code).toBe(Exit.ok);
      const obj = JSON.parse(r.out);
      expect(obj.apply).toBe(false);
      expect(obj.source.kind).toBe("cairn");
      expect(obj.source.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(obj.bytes_by_part["folders/src"]).toBeGreaterThan(0);
      expect(obj.folders).toEqual({ src: target });
      expect(Array.isArray(obj.steps)).toBe(true);
      expect(existsSync(target)).toBe(false); // simulation : aucun fichier restauré
      const checked = await run(["restore", "--from", v, "--check", "--json"], s.context);
      expect(checked.code).toBe(Exit.ok);
      expect(JSON.parse(checked.out).check).toEqual({ present: [], missing: [] });
      // Depuis la destination configurée : la dernière version de ce Mac ; une version inconnue → code 2.
      const fromDest = await run(["restore", "--parts", "folders", "--json", "--config", s.cfg], s.context);
      expect(JSON.parse(fromDest.out).source.path).toBe(v);
      const unknown = await run(["restore", "--version", "1999-01-01T000000", "--config", s.cfg], s.context);
      expect(unknown.code).toBe(Exit.usage);
      expect((await run(["restore", "--target", "nothing", "--from", v], s.context)).code).toBe(Exit.usage);
    },
    60_000,
  );

  test.skipIf(!native)(
    "restore --apply: confirmation, then files restored into a temporary target",
    async () => {
      const s = sample();
      const v = await backedUp(s);
      const target = path.join(s.dir, "restored");
      const args = [
        "restore",
        "--from",
        v,
        "--parts",
        "folders",
        "--target",
        `src=${target}`,
        "--apply",
        "--lang",
        "en-US",
      ];
      const cancelled = await run(args, { ...s.context, confirm: async () => false });
      expect(cancelled.code).toBe(Exit.failure);
      expect(cancelled.err).toContain("Cancelled.");
      expect(existsSync(path.join(target, "f0.bin"))).toBe(false);
      const asked: string[] = [];
      const done = await run(args, {
        ...s.context,
        confirm: async (q) => {
          asked.push(q);
          return true;
        },
      });
      expect(done.code).toBe(Exit.ok);
      expect(asked[0]).toContain("Restore now?");
      expect(readFileSync(path.join(target, "f1.bin")).length).toBe(10_001);
      expect(done.out).toContain("  ✓ folders/src");
    },
    60_000,
  );

  test("restore --tool: only that AI tool, unknown tool is a usage error", async () => {
    const dir = temp();
    const bk = path.join(dir, "legacy");
    writeSized(path.join(bk, "home/.zshrc"), 100);
    writeSized(path.join(bk, "home/.claude/projects/p/s.jsonl"), 200_000);
    writeSized(path.join(bk, "home/.codex/config.toml"), 50_000);
    writeSized(path.join(bk, "ai/claude-desktop/Claude/config.json"), 30_000);
    mkdirSync(path.join(bk, "manifest"), { recursive: true });
    writeFileSync(
      path.join(bk, "manifest/system.txt"),
      "date=2026-11-01 10:00:00\nhost=Old Mac\nhome=/Users/old\narch=arm64\n",
    );
    writeFileSync(path.join(bk, "manifest/Brewfile"), 'brew "gh"\n');
    const home = path.join(dir, "home");
    mkdirSync(home, { recursive: true });
    const context: CliContext = { restore: { home } };
    const ok = await run(["restore", "--from", bk, "--parts", "ai", "--tool", "codex", "--json"], context);
    expect(ok.code).toBe(Exit.ok);
    const steps = JSON.parse(ok.out).steps as Array<{ step: string; detail: string }>;
    expect(steps.find((x) => x.step === "ai")?.detail).toBe("codex");
    const bad = await run(["restore", "--from", bk, "--tool", "aider", "--lang", "en-US"], context);
    expect(bad.code).toBe(Exit.usage);
    expect(bad.err).toContain("aider");
    expect(existsSync(path.join(home, ".codex"))).toBe(false); // simulation
  });

  test("restore: a folder that is not a backup fails", async () => {
    const dir = temp();
    const r = await run(["restore", "--from", dir, "--lang", "en-US"]);
    expect(r.code).toBe(Exit.failure);
    expect(r.err).toContain("Not a Cairn version nor a backup.sh backup");
  });
});
