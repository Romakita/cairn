// Vérification réelle (lecture seule) : inventaire des outils et données IA du portage, comparés à la 0.8.0.
//   bun scripts/compare-tools.ts [--app <Cairn.app/Contents/MacOS/Cairn>] [--json]
// Lance `Cairn tools --json --export <tmp>` et `Cairn ai --json` (0.8.0), calcule les mêmes données avec
// src/core/inventory et src/core/ai, puis affiche les différences. Rien n'est écrit dans le home ni dans ~/.cairn :
// la configuration est lue sans migration, les exports vont dans un dossier temporaire supprimé à la fin.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { aiJSON, allToolStats } from "../src/core/ai/index.ts";
import { type CairnConfig, decodeConfig, defaultConfig } from "../src/core/config.ts";
import { brewfile, collect, inventoryJSON, toolsTOML } from "../src/core/inventory/index.ts";
import { CairnPaths } from "../src/core/paths.ts";
import { run } from "../src/core/process.ts";
import { TOMLDocument } from "../src/core/toml.ts";

const args = process.argv.slice(2);
const appIndex = args.indexOf("--app");
const app = appIndex >= 0 && args[appIndex + 1] ? (args[appIndex + 1] as string) : (process.env.CAIRN_SWIFT_CLI ?? "");
const printJSON = args.includes("--json");
if (!app) {
  console.error("binaire de la 0.8.0 introuvable : CAIRN_SWIFT_CLI=<chemin> ou --app <chemin>");
  process.exit(2);
}

// L'inventaire réel, jamais celui des tests.
delete process.env.CAIRN_TOOLS_INVENTORY;

async function readConfig(): Promise<CairnConfig> {
  try {
    return decodeConfig(TOMLDocument.parse(await readFile(new CairnPaths().config, "utf8"))).config;
  } catch {
    return defaultConfig();
  }
}

interface ToolRow {
  name: string;
  status: string;
  source?: string;
  version?: string | null;
  excluded: boolean;
  reasons: unknown[];
}

const key = (t: ToolRow) => `${t.source ?? "missing"}:${t.name}`;

function countBy<T>(items: readonly T[], f: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of items) out[f(x)] = (out[f(x)] ?? 0) + 1;
  return out;
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cairn-compare-"));
  try {
    const config = await readConfig();
    const t0 = Date.now();
    const inv = await collect(config);
    const tInv = Date.now() - t0;
    const t1 = Date.now();
    const stats = await allToolStats();
    const tAI = Date.now() - t1;
    const mine = { tools: JSON.parse(inventoryJSON(inv)), ai: JSON.parse(aiJSON(stats, config)) };

    const swiftExport = path.join(tmp, "export");
    const t2 = Date.now();
    const toolsRun = await run(app, ["tools", "--json", "--export", swiftExport], { stderr: "ignore" });
    const tSwiftInv = Date.now() - t2;
    const aiRun = await run(app, ["ai", "--json"], { stderr: "ignore" });
    if (toolsRun.code !== 0 || aiRun.code !== 0) {
      console.error(`0.8.0 en échec : tools=${toolsRun.code} ai=${aiRun.code}`);
      process.exit(1);
    }
    const theirs = { tools: JSON.parse(toolsRun.stdout), ai: JSON.parse(aiRun.stdout) };

    if (printJSON) console.log(JSON.stringify({ mine, theirs }, null, 2));

    // Inventaire.
    const a = mine.tools.tools as ToolRow[];
    const b = theirs.tools.tools as ToolRow[];
    console.log("== Inventaire des outils ==");
    console.log(`durée : portage ${tInv} ms, 0.8.0 ${tSwiftInv} ms`);
    console.log(
      "par statut  portage :",
      countBy(a, (t) => t.status),
      " 0.8.0 :",
      countBy(b, (t) => t.status),
    );
    console.log(
      "par source  portage :",
      countBy(a, (t) => t.source ?? "-"),
      " 0.8.0 :",
      countBy(b, (t) => t.source ?? "-"),
    );
    const am = new Map(a.map((t) => [key(t), t]));
    const bm = new Map(b.map((t) => [key(t), t]));
    const onlyMine = [...am.keys()].filter((k) => !bm.has(k));
    const onlyTheirs = [...bm.keys()].filter((k) => !am.has(k));
    if (onlyMine.length) console.log("seulement dans le portage :", onlyMine);
    if (onlyTheirs.length) console.log("seulement dans la 0.8.0 :", onlyTheirs);
    let diffs = 0;
    for (const [k, x] of am) {
      const y = bm.get(k);
      if (!y) continue;
      const fx = JSON.stringify([x.status, x.version ?? null, x.excluded, x.reasons]);
      const fy = JSON.stringify([y.status, y.version ?? null, y.excluded, y.reasons]);
      // L'ordre des raisons d'une commande à plusieurs marqueurs suit un dictionnaire Swift (ordre aléatoire).
      const sorted = (r: unknown[]) => JSON.stringify(r.map((v) => JSON.stringify(v)).sort());
      if (fx !== fy && !(x.status === y.status && sorted(x.reasons) === sorted(y.reasons) && x.version === y.version)) {
        diffs++;
        console.log(`diff ${k}\n  portage ${fx}\n  0.8.0   ${fy}`);
      }
    }
    const order = (l: ToolRow[]) => l.map(key).join("\n");
    console.log(`outils communs différents : ${diffs} ; même ordre : ${order(a) === order(b)}`);
    console.log("taps identiques :", JSON.stringify(mine.tools.taps) === JSON.stringify(theirs.tools.taps));
    const theirTOML = await readFile(path.join(swiftExport, "tools.toml"), "utf8");
    const theirBrewfile = await readFile(path.join(swiftExport, "Brewfile"), "utf8");
    console.log("tools.toml identique octet pour octet :", toolsTOML(inv) === theirTOML);
    console.log("Brewfile identique octet pour octet :", brewfile(inv) === theirBrewfile);

    // Outils IA.
    console.log("\n== Outils IA ==");
    console.log(`durée : portage ${tAI} ms`);
    type AIRow = Record<string, unknown> & { id: string };
    const theirsAI = new Map((theirs.ai.tools as AIRow[]).map((t) => [t.id, t]));
    for (const t of mine.ai.tools as AIRow[]) {
      const o = theirsAI.get(t.id);
      if (!o) {
        console.log(`${t.id} : absent de la 0.8.0`);
        continue;
      }
      const fields = [
        "detected",
        "total_bytes",
        "not_copied_bytes",
        "conversations",
        "latest_conversation",
        "selected_categories",
        "credentials_in_keychain",
      ];
      const lines: string[] = [];
      for (const f of fields) {
        const same = JSON.stringify(t[f]) === JSON.stringify(o[f]);
        lines.push(`  ${f}: ${JSON.stringify(t[f])}${same ? "" : `  ≠ 0.8.0 ${JSON.stringify(o[f])}`}`);
      }
      const mc = t.bytes_by_category as Record<string, number>;
      const oc = o.bytes_by_category as Record<string, number>;
      for (const c of new Set([...Object.keys(mc), ...Object.keys(oc)])) {
        const delta = (mc[c] ?? 0) - (oc[c] ?? 0);
        lines.push(`  bytes.${c}: ${mc[c]}${delta === 0 ? "" : `  ≠ 0.8.0 ${oc[c]} (écart ${delta})`}`);
      }
      console.log(`${t.id} :\n${lines.join("\n")}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

await main();
