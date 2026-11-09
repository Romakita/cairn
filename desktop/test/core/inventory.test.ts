// Port d'InventoryTests.swift, des cas inventaire de ConfigWarningTests.swift (6 et 7) et de la lecture des listes
// héritées de RestoreTests.swift (`ToolPlan.read`). Aucun test ne lance brew, mise… : exécuteur factice, home simulé.
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, folder } from "../../src/core/config.ts";
import { ConfigStore } from "../../src/core/config-store.ts";
import {
  brewfile,
  type CLITool,
  type CommandRunner,
  classify,
  cliTool,
  collect,
  commandsFor,
  InventoryParsers,
  installed,
  inventoryJSON,
  projectMarkers,
  readToolLists,
  reasonText,
  BUNDLED_RULES as rules,
  writeInventory,
} from "../../src/core/inventory/index.ts";
import { currentLanguage, setLanguage } from "../../src/core/l10n.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { asInteger, asString, TOMLDocument } from "../../src/core/toml.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cairn-test-"));
  try {
    await body(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** Exécuteur factice : sorties enregistrées par préfixe de commande ; les commandes lancées sont notées. */
function recordingRunner(outputs: Record<string, string>): CommandRunner & { commands: string[] } {
  const commands: string[] = [];
  const runner = async (command: readonly string[]) => {
    const key = command.join(" ");
    commands.push(key);
    for (const [k, v] of Object.entries(outputs)) if (key.startsWith(k)) return { status: 0, output: v };
    return { status: 127, output: "" };
  };
  return Object.assign(runner, { commands });
}

function withLanguage<T>(language: "en-US" | "fr-FR", body: () => T): T {
  const previous = currentLanguage();
  setLanguage(language);
  try {
    return body();
  } finally {
    setLanguage(previous);
  }
}

const none = new Set<string>();
const noHistory = new Map<string, number>();

describe("Inventory", () => {
  test("rules_resource_loads", () => {
    expect(Object.keys(rules.home).length > 0 && Object.keys(rules.projects).length > 0).toBe(true);
    expect(commandsFor("ripgrep")).toEqual(["rg"]);
    expect(commandsFor("@acme/cli")).toEqual(["acme"]);
    expect(commandsFor("php@8.4")).toEqual(["php"]);
  });

  test("parses_brew_mise_npm", () => {
    const brew = InventoryParsers.brewVersions("gh 2.93.0\nripgrep 15.1.0\nphp@8.4 8.4.21\n", rules);
    expect(brew.map((t) => t.name)).toEqual(["gh", "ripgrep", "php@8.4"]);
    expect(brew[1]?.commands).toEqual(["rg"]);
    expect(brew[2]?.version).toBe("8.4.21");
    const mise = InventoryParsers.mise(
      `{"node":[{"version":"24.18.0","requested_version":"24.18.0","active":true}],
        "npm:@fission-ai/openspec":[{"version":"1.16.1","requested_version":"latest","active":true}]}`,
      rules,
    );
    expect(mise.map((t) => t.name)).toEqual(["node", "npm:@fission-ai/openspec"]);
    expect(mise[1]?.commands).toEqual(["openspec"]);
    const npm = InventoryParsers.npmGlobals(
      `{"name":"lib","dependencies":{"npm":{"version":"10"},"corepack":{"version":"0.3"},
        "@anthropic-ai/claude-code":{"version":"2.1.317"}}}`,
      rules,
    );
    expect(npm.map((t) => t.name)).toEqual(["@anthropic-ai/claude-code"]);
    expect(npm[0]?.commands).toEqual(["claude"]);
  });

  test("parses_uv_receipt_with_extras_and_python", () => {
    const t = InventoryParsers.uvReceipt(`[tool]
requirements = [{ name = "ruff", extras = ["lsp"] }]
python = "3.12"
entrypoints = [
    { name = "ruff", install-path = "/Users/x/.local/bin/ruff", from = "ruff" },
]
`);
    expect(t?.name).toBe("ruff");
    expect(t?.source).toBe("uv");
    expect(t?.details.python).toBe("3.12");
    expect(t?.details.extras).toBe("lsp");
    expect(t?.commands).toEqual(["ruff"]);
  });

  test("local_bin_links_attached_to_their_source", () => {
    const tools = InventoryParsers.localBin([
      { name: "ruff", linkTarget: "/Users/x/.local/share/uv/tools/ruff/bin/ruff" },
      { name: "cocoindex", linkTarget: "/Users/x/.local/pipx/venvs/cocoindex/bin/cocoindex" },
      { name: "coderabbit", linkTarget: null },
      { name: "cr", linkTarget: "/Users/x/.local/bin/coderabbit" },
      { name: "mise", linkTarget: null },
    ]);
    expect(tools.map((t) => t.name)).toEqual(["coderabbit", "mise"]);
  });

  test("history_counts_commands", () => {
    const h = InventoryParsers.history(
      ": 1700000000:0;rg foo\n: 1700000001:0;sudo rg bar\nrtk rg baz\ngit status\n./script.sh\n",
    );
    expect(h.get("rg")).toBe(3);
    expect(h.get("git")).toBe(1);
    expect(h.get("./script.sh")).toBeUndefined();
  });

  test("statuses_used_unused_missing", () => {
    const tools = [
      cliTool("gh", "brew", "2", ["gh"]),
      cliTool("ripgrep", "brew", "15", ["rg"]),
      cliTool("cowsay", "brew", "3", ["cowsay"]),
      cliTool("visual-studio-code", "brew", null, ["code"]),
    ];
    const inv = classify({
      tools,
      taps: [],
      homeMarkers: new Set([".config/gh", ".kube"]),
      projectMarkers: new Set(["justfile"]),
      history: new Map([
        ["rg", 5],
        ["cowsay", 1],
      ]),
      excluded: new Set(["cowsay"]),
      rules,
      available: () => false,
    });
    const byName = new Map(inv.entries.map((e) => [e.name, e]));
    expect(byName.get("gh")?.status).toBe("used");
    expect(byName.get("ripgrep")?.status).toBe("used");
    expect(byName.get("cowsay")?.status).toBe("unused");
    expect(byName.get("cowsay")?.excluded).toBe(true);
    expect(byName.get("kubectl")?.status).toBe("missing");
    expect(byName.get("kubectl")?.reasons).toEqual([{ code: "home", file: ".kube" }]);
    expect(byName.get("kubectl")?.reasons.map(reasonText)).toEqual(["~/.kube"]);
    expect(byName.get("just")?.status).toBe("missing");
    expect(inv.entries[0]?.status).toBe("missing"); // les manquants d'abord
    // Puis utilisés, puis non utilisés, chacun par source et par nom.
    const order = { missing: 0, used: 1, unused: 2 };
    const ranks = inv.entries.map((e) => order[e.status]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test("collect_never_includes_casks", async () => {
    await withTempDir(async (home) => {
      const runner = recordingRunner({
        "brew leaves": "gh\n",
        "brew list --versions gh": "gh 2.93.0\n",
        "brew tap": "hashicorp/tap\n",
      });
      const { tools, taps } = await installed(home, runner, rules);
      expect(tools.map((t) => t.name)).toEqual(["gh"]);
      expect(taps).toEqual(["hashicorp/tap"]);
      expect(runner.commands.some((c) => c.includes("cask") || c.startsWith("mas"))).toBe(false);
    });
  });

  test("export_tools_toml_and_brewfile", async () => {
    await withTempDir(async (dir) => {
      const inv = {
        entries: [
          {
            name: "gh",
            tool: cliTool("gh", "brew", "2.93.0", ["gh"]),
            status: "used" as const,
            reasons: [],
            excluded: false,
          },
          {
            name: "cowsay",
            tool: cliTool("cowsay", "brew", "3", ["cowsay"]),
            status: "unused" as const,
            reasons: [],
            excluded: true,
          },
          {
            name: "ruff",
            tool: cliTool("ruff", "uv", null, ["ruff"], { python: "3.12" }),
            status: "used" as const,
            reasons: [],
            excluded: false,
          },
        ],
        taps: ["hashicorp/tap"],
      };
      await writeInventory(inv, dir);
      const bf = await readFile(path.join(dir, "Brewfile"), "utf8");
      expect(bf).toBe('tap "hashicorp/tap"\nbrew "gh"\n');
      expect(bf.includes("cask") || bf.includes("mas")).toBe(false);
      const text = await readFile(path.join(dir, "tools.toml"), "utf8");
      const toml = TOMLDocument.parse(text).tree();
      expect(asInteger(toml.value("version"))).toBe(1);
      expect(toml.tables("brew").map((t) => asString(t.value("name")))).toEqual(["gh"]);
      expect(asString(toml.tables("uv")[0]?.value("python"))).toBe("3.12");
      // Format exact de la 0.8.0 (parity/behavior.md §3.10).
      expect(text).toBe(
        "# Outils CLI exportés par Cairn — relus par `cairn restore` pour la réinstallation.\n\n" +
          'version = 1\ntaps = ["hashicorp/tap"]\n\n[[brew]]\nname = "gh"\nversion = "2.93.0"\ncommands = ["gh"]\n\n' +
          '[[uv]]\nname = "ruff"\npython = "3.12"\ncommands = ["ruff"]\n',
      );
    });
  });

  test("excluded_tool_stays_excluded", async () => {
    await withTempDir(async (dir) => {
      const store = new ConfigStore(new CairnPaths(dir));
      const c = defaultConfig();
      c.excludedTools = ["cowsay"];
      await store.save(c);
      const reloaded = (await store.load()).config;
      const inv = classify({
        tools: [cliTool("cowsay", "brew", null, ["cowsay"])],
        taps: [],
        homeMarkers: none,
        projectMarkers: none,
        history: noHistory,
        excluded: new Set(reloaded.excludedTools),
        rules,
      });
      expect(inv.entries[0]?.excluded).toBe(true);
    });
  });

  // ConfigWarningTests 6 : `cairn tools --json` ne dépend pas de la langue.
  test("tools_json_is_language_independent", () => {
    const inv = classify({
      tools: [cliTool("ripgrep", "brew", "15", ["rg"]), cliTool("kubectl", "brew", "1.31", ["kubectl"])],
      taps: [],
      homeMarkers: new Set([".kube"]),
      projectMarkers: none,
      history: new Map([["rg", 5]]),
      excluded: none,
      rules,
      available: () => true,
    });
    const en = withLanguage("en-US", () => inventoryJSON(inv));
    const fr = withLanguage("fr-FR", () => inventoryJSON(inv));
    expect(en).toBe(fr);
    expect(en.includes('"code" : "history"') && en.includes('"uses" : 5')).toBe(true);
    expect(en.includes('"code" : "home"') && en.includes('"file" : ".kube"')).toBe(true);
    // Le texte, lui, est traduit.
    const rg = inv.entries.find((e) => e.name === "ripgrep");
    const frText = withLanguage("fr-FR", () => rg?.reasons.map(reasonText).join(""));
    const enText = withLanguage("en-US", () => rg?.reasons.map(reasonText).join(""));
    expect(frText).not.toBe(enText);
    expect(frText?.includes("5")).toBe(true);
  });

  test("tools_json_format", () => {
    const inv = classify({
      tools: [cliTool("gh", "brew", null, ["gh"])],
      taps: ["a/b"],
      homeMarkers: none,
      projectMarkers: none,
      history: noHistory,
      excluded: none,
      rules,
    });
    expect(inventoryJSON(inv)).toBe(
      '{\n  "taps" : [\n    "a\\/b"\n  ],\n  "tools" : [\n    {\n      "commands" : [\n        "gh"\n      ],\n' +
        '      "details" : {\n\n      },\n      "excluded" : false,\n      "name" : "gh",\n      "reasons" : [\n\n      ],\n' +
        '      "source" : "brew",\n      "status" : "unused",\n      "version" : null\n    }\n  ]\n}',
    );
  });

  // ConfigWarningTests 7 : versions uv (dist-info), go (`go version -m`), liens de ~/.local/bin.
  test("uv_version_from_dist_info", async () => {
    await withTempDir(async (home) => {
      const tool = path.join(home, ".local/share/uv/tools/serena-agent");
      await put(
        path.join(tool, "uv-receipt.toml"),
        '[tool]\nrequirements = [{ name = "serena-agent" }]\nentrypoints = [{ name = "serena", install-path = "/x/serena", from = "serena-agent" }]\n',
      );
      const site = path.join(tool, "lib/python3.13/site-packages");
      for (const d of ["serena_agent-1.5.3.dist-info", "serena_agent_extra-9.9.dist-info", "anyio-4.13.0.dist-info"]) {
        await mkdir(path.join(site, d), { recursive: true });
      }
      expect(await InventoryParsers.uvVersion("serena-agent", tool)).toBe("1.5.3");
      expect(await InventoryParsers.uvVersion("Serena.Agent", tool)).toBe("1.5.3");
      expect(await InventoryParsers.uvVersion("absent", tool)).toBeNull();
      const { tools } = await installed(home, recordingRunner({}), rules);
      const uv = tools.find((t) => t.source === "uv");
      expect(uv?.name).toBe("serena-agent");
      expect(uv?.version).toBe("1.5.3");
      expect(uv?.commands).toEqual(["serena"]);
    });
  });

  test("go_version_from_build_info", async () => {
    const out =
      "/Users/x/go/bin/gopls: go1.22.0\n\tpath\tgolang.org/x/tools/gopls\n" +
      "\tmod\tgolang.org/x/tools/gopls\tv0.15.0\th1:abc=\n\tdep\tgolang.org/x/mod\tv0.15.0\n";
    expect(InventoryParsers.goVersion(out)).toBe("v0.15.0");
    expect(InventoryParsers.goVersion("x: go1.22\n\tmod\texample.com/x\t(devel)\t\n")).toBeNull();
    await withTempDir(async (home) => {
      await put(path.join(home, "go/bin/gopls"), "x");
      await put(path.join(home, "go/bin/other"), "x");
      const runner = recordingRunner({ [`go version -m ${home}/go/bin/gopls`]: out });
      const { tools } = await installed(home, runner, rules);
      const go = new Map(tools.filter((t) => t.source === "go").map((t) => [t.name, t.version]));
      expect(go.get("gopls")).toBe("v0.15.0");
      expect(go.has("other") && go.get("other") === null).toBe(true); // go absent ou sans info : version inconnue
    });
  });

  test("local_bin_version_from_link_target", () => {
    const tools = InventoryParsers.localBin([
      { name: "claude", linkTarget: "/Users/x/.local/share/claude/versions/2.1.3" },
      { name: "codex", linkTarget: "/Users/x/.codex/packages/standalone/current/bin/codex" },
      { name: "tool", linkTarget: "/opt/tool-v1.2.0/v1.2.0/bin/tool" },
    ]);
    expect(tools.map((t) => t.version)).toEqual(["2.1.3", null, "v1.2.0"]);
  });

  test("local_bin_is_never_run", async () => {
    // ~/.local/bin : exécutables listés sans jamais lancer `--version` ; dossiers, cachés et non exécutables ignorés.
    await withTempDir(async (home) => {
      const bin = path.join(home, ".local/bin");
      await put(path.join(bin, "tool"), '#!/bin/sh\ntouch "$HOME/ran"\n');
      await chmod(path.join(bin, "tool"), 0o755);
      await put(path.join(bin, "notes.txt"), "x");
      await put(path.join(bin, ".hidden"), "x");
      await chmod(path.join(bin, ".hidden"), 0o755);
      await mkdir(path.join(bin, "dir"));
      await mkdir(path.join(home, ".local/share/claude/versions"), { recursive: true });
      await put(path.join(home, ".local/share/claude/versions/2.1.3"), "x");
      await chmod(path.join(home, ".local/share/claude/versions/2.1.3"), 0o755);
      await symlink(path.join(home, ".local/share/claude/versions/2.1.3"), path.join(bin, "claude"));
      const runner = recordingRunner({});
      const { tools } = await installed(home, runner, rules);
      const local = tools.filter((t) => t.source === "local-bin");
      expect(local.map((t) => [t.name, t.version])).toEqual([
        ["claude", "2.1.3"],
        ["tool", null],
      ]);
      expect(runner.commands.some((c) => c.includes(".local/bin"))).toBe(false);
    });
  });

  test("brew_leaves_installed_on_request_only", async () => {
    await withTempDir(async (home) => {
      const runner = recordingRunner({
        "brew leaves --installed-on-request": "gh\n",
        "brew list --versions gh": "gh 2.93.0\n",
      });
      const { tools } = await installed(home, runner, rules);
      expect(tools.filter((t) => t.source === "brew").map((t) => t.name)).toEqual(["gh"]);
      expect(runner.commands).toContain("brew leaves --installed-on-request");
    });
  });

  test("other_sources_cargo_pipx_mise_npm", async () => {
    await withTempDir(async (home) => {
      await put(
        path.join(home, ".cargo/.crates2.json"),
        '{"installs":{"ripgrep 14.1.0 (registry+https://github.com/rust-lang/crates.io-index)":{"bins":["rg"]}}}',
      );
      const runner = recordingRunner({
        "pipx list --short": "cocoindex 0.3.1\n",
        "mise ls --current --json": '{"node":[{"version":"24.1.0","active":true}]}',
        "mise exec -- npm ls -g": '{"dependencies":{"npm":{"version":"10"},"@openai/codex":{"version":"0.5"}}}',
      });
      const { tools } = await installed(home, runner, rules);
      const pick = (t: CLITool) => [t.source, t.name, t.version, t.commands.join(",")];
      expect(tools.map(pick)).toEqual([
        ["mise", "node", "24.1.0", "node,npm,npx"],
        ["npm", "@openai/codex", "0.5", "codex"],
        ["pipx", "cocoindex", "0.3.1", "cocoindex"],
        ["cargo", "ripgrep", "14.1.0", "rg"],
      ]);
    });
  });

  test("project_markers_skip_hidden_and_regenerable", async () => {
    await withTempDir(async (dir) => {
      await put(path.join(dir, "ws/app/justfile"), "");
      await put(path.join(dir, "ws/app/node_modules/x/Cargo.toml"), "");
      await put(path.join(dir, "ws/.hidden/go.mod"), "");
      await put(path.join(dir, "ws/a/b/c/d/e/f/pubspec.yaml"), ""); // profondeur 6
      await put(path.join(dir, "ws/a/b/c/d/e/Makefile"), ""); // profondeur 5
      await symlink(path.join(dir, "other"), path.join(dir, "ws/link"));
      await put(path.join(dir, "other/uv.lock"), "");
      const found = await projectMarkers(
        [path.join(dir, "ws")],
        new Set(["justfile", "Cargo.toml", "go.mod", "pubspec.yaml", "Makefile", "uv.lock"]),
      );
      expect([...found.keys()].sort()).toEqual(["Makefile", "justfile"]);
    });
  });

  test("collect_reads_markers_history_and_exclusions", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      await mkdir(path.join(home, ".kube"), { recursive: true });
      await put(path.join(home, ".zsh_history"), ": 1:0;rg a\n: 2:0;rg b\n");
      await put(path.join(home, ".bash_history"), "rg c\n");
      await put(path.join(dir, "ws/justfile"), "");
      const config = defaultConfig();
      config.folders = [folder(path.join(dir, "ws"))];
      config.excludedTools = ["gh"];
      const runner = recordingRunner({
        "brew leaves": "gh\nripgrep\n",
        "brew list --versions": "gh 2.9\nripgrep 15.1.0\n",
        "brew tap": "",
      });
      const inv = await collect(config, { home, runner });
      const byName = new Map(inv.entries.map((e) => [e.name, e]));
      expect(byName.get("ripgrep")?.reasons).toEqual([{ code: "history", uses: 3 }]);
      expect(byName.get("gh")?.excluded).toBe(true);
      expect(byName.get("kubectl")?.status ?? "available").not.toBe("used");
      const just = byName.get("just");
      if (just) expect(just.reasons).toEqual([{ code: "project", file: "justfile" }]);
    });
  });

  test("collect_is_empty_in_tests_without_runner", async () => {
    // test/setup.ts pose CAIRN_TOOLS_INVENTORY=empty : jamais l'inventaire réel de la machine pendant les tests.
    expect(process.env.CAIRN_TOOLS_INVENTORY).toBe("empty");
    expect(await collect(defaultConfig())).toEqual({ entries: [], taps: [] });
  });

  // RestoreTests : lecture des listes héritées (scripts/backup.sh) et de tools.toml.
  test("reads_legacy_tool_lists", async () => {
    await withTempDir(async (dir) => {
      const m = path.join(dir, "manifest");
      await put(path.join(m, "Brewfile"), 'tap "hashicorp/tap"\nbrew "gh"\nbrew "just"\n');
      await put(path.join(m, "npm-globals.txt"), "@openai/codex\n");
      await put(path.join(m, "uv-tools.txt"), "ruff[lsp]|3.12\n");
      const { tools, taps, brewfile: bf } = await readToolLists(m);
      expect(taps).toEqual(["hashicorp/tap"]);
      expect(bf).toBe(path.join(m, "Brewfile"));
      expect(tools.map((t) => t.name)).toEqual(["gh", "just", "@openai/codex", "ruff"]);
      expect(tools.at(-1)?.details).toEqual({ extras: "lsp", python: "3.12" });
      expect(tools[2]?.commands).toEqual(["codex"]);
    });
  });

  test("reads_mise_config_of_legacy_backup", async () => {
    await withTempDir(async (dir) => {
      await put(
        path.join(dir, "mise-config.toml"),
        '[tools]\nnode = "22"\npython = ["3.12", "3.11"]\n"aqua:cli/cli" = "latest"\nrust = { version = "1.80" }\n',
      );
      await put(path.join(dir, "pipx.json"), '{"venvs":{"zeta":{},"alpha":{}}}');
      const { tools } = await readToolLists(dir);
      const mise = tools.filter((t) => t.source === "mise");
      expect(mise.map((t) => t.name)).toEqual(["node", "python", "aqua:cli/cli", "rust"]);
      expect(mise.map((t) => t.details.requested)).toEqual(["22", "3.12", "latest", "1.80"]);
      expect(mise[1]?.commands).toEqual(["python3"]);
      expect(mise[2]?.commands).toEqual(["cli"]);
      expect(tools.filter((t) => t.source === "pipx").map((t) => t.name)).toEqual(["alpha", "zeta"]);
    });
  });

  test("reads_exported_tools_toml", async () => {
    await withTempDir(async (dir) => {
      const inv = classify({
        tools: [
          cliTool("ruff", "uv", "0.6", ["ruff"], { extras: "lsp", python: "3.12" }),
          cliTool("gh", "brew", "2.9", ["gh"]),
        ],
        taps: ["hashicorp/tap"],
        homeMarkers: none,
        projectMarkers: none,
        history: noHistory,
        excluded: none,
        rules,
      });
      await writeInventory(inv, dir);
      expect(brewfile(inv)).toBe('tap "hashicorp/tap"\nbrew "gh"\n');
      const { tools, taps } = await readToolLists(dir);
      expect(taps).toEqual(["hashicorp/tap"]);
      expect(tools.map((t) => [t.source, t.name])).toEqual([
        ["brew", "gh"],
        ["uv", "ruff"],
      ]);
      expect(tools[1]?.details).toEqual({ version: "0.6", extras: "lsp", python: "3.12" });
    });
  });
});
