// Mesure de parité de l'analyse : scanner TypeScript, Cairn 0.8.0 installé (`analyze --json`) et `du -sk`.
// Usage : bun scripts/compare-analyze.ts <dossier>… [--swift <chemin du binaire>] [--workers N]
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { CATEGORIES } from "../src/core/regenerable.ts";
import { bytes, regenerableBytes, ScanContext, scanFolders } from "../src/core/scanner.ts";

const exec = promisify(execFile);
const args = process.argv.slice(2);
let swift = `${os.homedir()}/Applications/Cairn.app/Contents/MacOS/Cairn`;
let workers: number | undefined;
const folders: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--swift") swift = args[++i] ?? swift;
  else if (args[i] === "--workers") workers = Number(args[++i]);
  else folders.push(args[i] as string);
}
if (folders.length === 0) {
  console.error("usage: bun scripts/compare-analyze.ts <folder>… [--swift <binary>] [--workers N]");
  process.exit(2);
}

const gb = (n: number) => `${(n / 1e9).toFixed(3)} GB`;
const gap = (a: number, b: number) => (b === 0 ? "—" : `${(((a - b) / b) * 100).toFixed(3)} %`);

interface SwiftFolder {
  size: number;
  files: number;
  regenerable: number;
  breakdown: Record<string, number>;
  duration_seconds: number;
}

for (const folder of folders) {
  console.log(`\n== ${folder}`);
  const t0 = Date.now();
  const [scanResult] = await scanFolders([folder], new ScanContext(), { workers });
  const tsSeconds = (Date.now() - t0) / 1000;
  const root = scanResult?.result?.root;
  if (!root) {
    console.log("  indisponible");
    continue;
  }

  let sw: SwiftFolder | null = null;
  let swSeconds = 0;
  try {
    const t1 = Date.now();
    const { stdout } = await exec(swift, ["analyze", "--json", folder], { maxBuffer: 256 * 1024 * 1024 });
    swSeconds = (Date.now() - t1) / 1000;
    sw = (JSON.parse(stdout) as { folders: SwiftFolder[] }).folders[0] ?? null;
  } catch (error) {
    console.log(`  0.8.0 indisponible : ${String(error)}`);
  }

  const t2 = Date.now();
  const { stdout: duOut } = await exec("/usr/bin/du", ["-sk", folder], { maxBuffer: 16 * 1024 * 1024 }).catch(
    (e: { stdout?: string }) => ({ stdout: e.stdout ?? "0" }),
  );
  const duSeconds = (Date.now() - t2) / 1000;
  const du = Number(duOut.trim().split("\t")[0]) * 1024;

  const row = (label: string, ts: number, ref: number | undefined) =>
    console.log(
      `  ${label.padEnd(12)} TS ${gb(ts).padStart(14)}  0.8.0 ${ref === undefined ? "—".padStart(14) : gb(ref).padStart(14)}  écart ${ref === undefined ? "—" : gap(ts, ref)}`,
    );
  row("total", root.size, sw?.size);
  row("régénérable", regenerableBytes(root), sw?.regenerable);
  for (const c of CATEGORIES) row(`  ${c}`, bytes(root, c), sw?.breakdown[c]);
  console.log(`  fichiers     TS ${root.fileCount}  0.8.0 ${sw?.files ?? "—"}`);
  console.log(
    `  du -sk       ${gb(du)}  écart TS/du ${gap(root.size, du)}  écart 0.8.0/du ${sw ? gap(sw.size, du) : "—"}`,
  );
  console.log(
    `  durée        TS ${tsSeconds.toFixed(2)} s  0.8.0 ${sw ? `${swSeconds.toFixed(2)} s (interne ${sw.duration_seconds.toFixed(2)} s)` : "—"}  du ${duSeconds.toFixed(2)} s`,
  );
}
