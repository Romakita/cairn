// Contrat main ↔ interface (design.md, décision 6) : chaque méthode a un schéma, les arguments invalides sont refusés
// (types, clés inconnues, chemins relatifs, tailles), les patchs de configuration s'appliquent sans toucher au reste,
// et l'API d'exemple implémente tout le contrat sans disque (scénarios, sauvegarde simulée qui avance).
import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/core/config.ts";
import { setLanguage } from "../../src/core/l10n.ts";
import { exampleSettings, toApiError } from "../../src/renderer/api/client.ts";
import { createFixtureApi, type FixtureApi, SCENARIO_IDS, SCENARIOS } from "../../src/renderer/api/fixtures/index.ts";
import { applyPatches } from "../../src/shared/config-patch.ts";
import { type AppSnapshot, CairnApiError, METHOD_NAMES } from "../../src/shared/contract.ts";
import { ARG_SCHEMAS, isMethodName, validateArgs } from "../../src/shared/schemas.ts";

const fixtures: FixtureApi[] = [];
function fixture(scenario: Parameters<typeof createFixtureApi>[0]["scenario"]): FixtureApi {
  const api = createFixtureApi({ scenario, frozen: true });
  fixtures.push(api);
  return api;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  setLanguage("en-US");
});

describe("contract", () => {
  test("une méthode, un schéma, un canal", () => {
    expect(Object.keys(ARG_SCHEMAS).sort()).toEqual([...METHOD_NAMES].sort());
    expect(new Set(METHOD_NAMES).size).toBe(METHOD_NAMES.length);
    expect(isMethodName("startBackup")).toBe(true);
    expect(isMethodName("constructor")).toBe(false);
    expect(isMethodName("__proto__")).toBe(false);
  });

  test("arguments valides acceptés", () => {
    expect(validateArgs("getSnapshot", undefined).ok).toBe(true);
    expect(validateArgs("startBackup", {}).ok).toBe(true);
    expect(validateArgs("startBackup", { destinations: ["nas"], dryRun: true, only: ["folder", "home"] }).ok).toBe(
      true,
    );
    expect(validateArgs("removeNodes", { nodeIds: [1, 2, 3] }).ok).toBe(true);
    expect(validateArgs("listFolders", { path: "~/Projects" }).ok).toBe(true);
    expect(
      validateArgs("saveConfig", {
        patches: [
          { kind: "schedule", schedule: { frequency: "weekly", time: "08:05", weekday: "friday" } },
          { kind: "updates", check: false },
        ],
      }).ok,
    ).toBe(true);
    expect(
      validateArgs("addDestination", {
        destination: {
          provider: "smb",
          url: "smb://nas.local/backups",
          username: "me",
          encrypted: true,
          retention: { mode: "count", count: 12 },
        },
        password: "secret",
      }).ok,
    ).toBe(true);
    expect(validateArgs("openExternal", { url: "https://github.com/Romakita/cairn/releases" }).ok).toBe(true);
    expect(validateArgs("openTarget", { kind: "config" }).ok).toBe(true);
  });

  test("arguments invalides refusés", () => {
    const refused: [Parameters<typeof validateArgs>[0], unknown][] = [
      // Mauvais types.
      ["startBackup", { destinations: 42 }],
      ["startBackup", { dryRun: "yes" }],
      ["startBackup", { only: ["everything"] }],
      ["startBackup", { only: [] }],
      ["removeNodes", { nodeIds: ["/Users/me"] }],
      ["removeNodes", { nodeIds: [-1] }],
      ["removeNodes", { nodeIds: [1.5] }],
      ["removeNodes", { nodeIds: [] }],
      // Clés inconnues : objets stricts.
      ["startBackup", { dryRun: true, shell: "rm -rf ~" }],
      ["removeNodes", { nodeIds: [1], paths: ["/"] }],
      ["openTarget", { kind: "config", file: "/etc/passwd" }],
      // Arguments absents ou d'un autre genre.
      ["scan", undefined],
      ["scan", null],
      ["scan", "/Volumes"],
      ["getSnapshot", { anything: 1 }],
      ["verify", {}],
      // Chemins : absolus seulement, sans caractère nul.
      ["listFolders", { path: "relative/dir" }],
      ["listFolders", { path: "../.." }],
      ["probeLocal", { path: "/tmp/a\0b" }],
      ["scan", { folders: ["Volumes/workspaces"] }],
      ["gitCompact", { repo: "repo" }],
      // URL : https seulement (la liste blanche est vérifiée ensuite par le main).
      ["openExternal", { url: "javascript:alert(1)" }],
      ["openExternal", { url: "file:///etc/passwd" }],
      ["openExternal", { url: "http://github.com/Romakita/cairn" }],
      // Configuration : valeurs hors bornes et genres inconnus.
      ["saveConfig", { patches: [] }],
      ["saveConfig", { patches: [{ kind: "schedule", schedule: { time: "25:00" } }] }],
      ["saveConfig", { patches: [{ kind: "schedule", schedule: { weekday: "funday" } }] }],
      ["saveConfig", { patches: [{ kind: "schedule", schedule: { onBatteryMinPercent: 101 } }] }],
      ["saveConfig", { patches: [{ kind: "git", git: { worktreeStaleDays: 0 } }] }],
      ["saveConfig", { patches: [{ kind: "unknown" }] }],
      ["saveConfig", { patches: [{ kind: "language", language: "de-DE" }] }],
      // Destinations.
      ["addDestination", { destination: { provider: "ftp", encrypted: true, retention: { mode: "count", count: 1 } } }],
      [
        "addDestination",
        {
          destination: { provider: "smb", url: "http://nas", encrypted: true, retention: { mode: "count", count: 1 } },
        },
      ],
      [
        "addDestination",
        { destination: { provider: "local", path: "/x", encrypted: true, retention: { mode: "count", count: 0 } } },
      ],
      ["planRetention", { destination: "nas", retention: { mode: "tiered", days: 4000, weeks: 1 } }],
      [
        "addDestination",
        {
          destination: { provider: "local", path: "/x", encrypted: true, retention: { mode: "count", count: 3 } },
          password: "",
        },
      ],
      ["copyText", { text: "x".repeat(100_001) }],
      ["planRestore", { source: { kind: "folder", path: "relative" } }],
      ["planRestore", { source: { kind: "destination", destination: "nas", image: "../cairn-x.sparsebundle" } }],
      ["planRestore", { source: { kind: "destination", destination: "nas", image: "photos.dmg" } }],
    ];
    for (const [method, args] of refused) {
      const r = validateArgs(method, args);
      if (r.ok) throw new Error(`accepté à tort : ${method} ${JSON.stringify(args)}`);
      expect(r.message).toStartWith(`invalid arguments for ${method}`);
    }
  });

  test("156f978: la source de restauration accepte l'image choisie (« Restaurer cette sauvegarde »)", () => {
    const r = validateArgs("planRestore", {
      source: { kind: "destination", destination: "nas", image: "cairn-MacBook-Air.sparsebundle" },
    });
    expect(r.ok).toBe(true);
  });

  test("le message de refus ne recopie pas les valeurs (mots de passe…)", () => {
    const r = validateArgs("connectSMB", {
      address: "smb://nas/x",
      username: "me",
      password: "hunter2",
      extra: "hunter2",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain("hunter2");
  });

  test("patchs de configuration", () => {
    const base = defaultConfig();
    const next = applyPatches(base, [
      { kind: "schedule", schedule: { frequency: "weekly", weekday: "friday" } },
      { kind: "updates", check: false },
      { kind: "folders", folders: [{ path: "/Volumes/workspaces", backup: true, exclude: ["*.iso"] }] },
    ]);
    expect(next.schedule).toEqual({ ...base.schedule, frequency: "weekly", weekday: "friday" });
    expect(next.checkUpdates).toBe(false);
    expect(next.folders).toEqual([{ path: "/Volumes/workspaces", backup: true, exclude: ["*.iso"] }]);
    // L'original n'est pas modifié.
    expect(base.checkUpdates).toBe(true);
    expect(base.folders).toEqual([]);
  });

  test("erreurs du pont → CairnApiError avec leur code", () => {
    const e = toApiError(new Error("Error invoking remote method 'cairn:x': Error: cairn:locked:another operation"));
    expect(e).toBeInstanceOf(CairnApiError);
    expect(e.code).toBe("locked");
    expect(e.message).toBe("another operation");
    expect(toApiError(new Error("cairn:invalidArguments:invalid arguments for scan: (root)")).code).toBe(
      "invalidArguments",
    );
    expect(toApiError(new Error("boom")).code).toBe("failed");
    expect(toApiError(new Error("cairn:nope:x")).code).toBe("failed");
  });

  test("réglages de l'API d'exemple lus dans l'URL", () => {
    expect(exampleSettings("?scenario=backup-running&lang=fr&t=12&frozen=1")).toEqual({
      scenario: "backup-running",
      language: "fr-FR",
      startAt: 12,
      frozen: true,
    });
    expect(exampleSettings("?scenario=../../etc")).toMatchObject({ scenario: "normal", language: "en-US" });
  });

  test("API d'exemple : toutes les méthodes, chaque scénario se construit", async () => {
    const api = fixture("normal");
    for (const name of METHOD_NAMES) expect(typeof api[name]).toBe("function");
    expect(typeof api.subscribe).toBe("function");
    for (const id of SCENARIO_IDS) {
      const s = SCENARIOS[id].build();
      expect(s.contract).toBe(1);
      expect(s.hub.modules.length).toBe(5);
      // Sérialisable comme un état réel (structured clone par l'IPC).
      expect(structuredClone(s).revision).toBe(s.revision);
    }
    expect(SCENARIOS.empty.build().firstLaunch).toBe(true);
    expect(SCENARIOS["config-invalid"].build().config.hasErrors).toBe(true);
    expect(SCENARIOS["disk-critical"].build().storage.alerts[0]?.level).toBe(2);
    expect(SCENARIOS["git-many-repos"].build().git.progress?.total).toBe(79);
    expect(SCENARIOS["update-available"].build().updates.available?.version).toBe("0.10.0");
    const plan = await api.planRestore({ source: { kind: "destination", destination: "nas" } });
    expect(plan.versions.length).toBeGreaterThan(0);
    expect(plan.parts).toEqual(["tools", "home"]);
    expect(plan.simulated).toBe(false);
  });

  test("API d'exemple : la sauvegarde à deux destinations avance dans le temps", async () => {
    const api = fixture("backup-running");
    const seen: AppSnapshot[] = [];
    api.subscribe((s) => seen.push(s));
    const phases = () => Object.fromEntries(seen.at(-1)!.backup.destinations.map((d) => [d.destination, d.phase]));
    // t = 0 : préparation commune.
    expect(phases()).toEqual({ nas: "preparing", disk: "preparing" });
    api.advance(4);
    // Comptage sur « nas » avec 4 compteurs visibles, « disk » en attente.
    expect(phases()).toEqual({ nas: "counting", disk: "waiting" });
    const nas = seen.at(-1)!.backup.destinations[0]!;
    expect(nas.counting?.counters.length).toBe(4);
    expect(nas.counting?.knownTotal).toBeGreaterThan(0);
    // Pendant la sauvegarde, l'installation d'une mise à jour est bloquée.
    expect(seen.at(-1)!.updates.blocker).not.toBeNull();
    api.advance(8);
    expect(phases()).toEqual({ nas: "copying", disk: "waiting" });
    const copy = seen.at(-1)!.backup.destinations[0]!.copy!;
    expect(copy.folderIndex).toBeGreaterThan(1);
    expect(copy.folderIndex).toBeLessThanOrEqual(copy.folderCount);
    api.advance(10);
    // Finalisation de « nas » pendant que « disk » copie.
    expect(phases()).toEqual({ nas: "finishing", disk: "copying" });
    expect(seen.at(-1)!.backup.destinations[0]!.finishing?.some((s) => s.id === "checksums")).toBe(true);
    api.advance(20);
    expect(phases()).toEqual({ nas: "done", disk: "done" });
    const last = seen.at(-1)!;
    expect(last.backup.running).toBe(false);
    // 0f7a1ce : plus de blocage dès la fin de la sauvegarde.
    expect(last.updates.blocker).toBeNull();
    // Révisions croissantes.
    const revisions = seen.map((s) => s.revision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
  });

  test("API d'exemple : arrêter une destination n'arrête qu'elle", async () => {
    const api = fixture("normal");
    let last: AppSnapshot | null = null;
    api.subscribe((s) => {
      last = s;
    });
    await api.startBackup({ dryRun: true });
    api.advance(5);
    await api.stopBackup({ destination: "nas" });
    const state = last as unknown as AppSnapshot;
    expect(state.backup.destinations.find((d) => d.destination === "nas")?.phase).toBe("stopped");
    expect(state.backup.destinations.find((d) => d.destination === "disk")?.phase).toBe("waiting");
    expect(state.backup.running).toBe(true);
    await expect(api.startBackup({})).rejects.toMatchObject({ code: "busy" });
  });
  test("API d'exemple : restauration sur un Mac neuf, simulée puis appliquée", async () => {
    const api = fixture("restore");
    const source = { kind: "destination" as const, destination: "nas" };
    // Mac neuf : le mot de passe de l'image est demandé avant toute version.
    expect((await api.planRestore({ source })).needsPassword).toBe("image");
    const opened = await api.planRestore({ source, imagePassword: "secret" });
    expect(opened.versions.every((v) => !v.thisMac)).toBe(true);
    expect(opened.details?.archMatches).toBe(false);
    await expect(api.applyRestore({ planId: opened.planId })).rejects.toMatchObject({ code: "notFound" });
    const plan = await api.planRestore({
      source,
      imagePassword: "secret",
      version: opened.version ?? undefined,
      parts: ["tools", "home", "ai", "folders"],
      folders: ["Documents"],
      simulate: true,
    });
    expect(plan.simulated).toBe(true);
    expect(Object.keys(plan.sizes).sort()).toEqual(["ai/claude-code", "ai/codex", "folders/Documents", "home"]);
    // go et ~/.local/bin : à réinstaller à la main, avec leur version.
    expect(plan.steps.filter((x) => x.manual).map((x) => [x.manual?.name, x.manual?.version])).toEqual([
      ["gopls", "v0.16.2"],
      ["llm-helper", null],
    ]);
    await api.applyRestore({ planId: plan.planId });
    let last = await api.getSnapshot();
    expect(last.restore.running).toBe(true);
    api.advance(20);
    last = await api.getSnapshot();
    expect(last.restore.running).toBe(false);
    expect(last.restore.progress?.finished).toBe(true);
    api.dispose();
  });
});
