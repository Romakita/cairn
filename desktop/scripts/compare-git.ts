// Compare l'analyse git TypeScript (pool de worker_threads) à `cairn git --json` de la 0.8.0, en LECTURE SEULE :
// aucun `--apply`, aucun fetch (forcé à false des deux côtés : `--fetch` n'est jamais passé).
//   bun scripts/compare-git.ts [--root DOSSIER]… [--swift-json FICHIER] [--swift BINAIRE]
// Sans `--swift-json`, lance `<binaire de la 0.8.0> git --root … --json` (`--swift` ou `CAIRN_SWIFT_CLI`).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeAll } from "../src/core/git/pool.ts";
import { defaultGitOptions, type RepoReport, worktreeIsObsolete } from "../src/core/git/types.ts";
import { classify } from "../src/core/regenerable.ts";

interface SwiftRepo {
  path: string;
  branches: Array<{ name: string; status: string }>;
  worktrees: Array<{ path: string; status: string; stale_reason: string | null }>;
}

const args = process.argv.slice(2);
const roots: string[] = [];
let swiftJSON: string | null = null;
let swiftBinary = process.env.CAIRN_SWIFT_CLI ?? "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root") roots.push(args[++i]!);
  else if (args[i] === "--swift-json") swiftJSON = args[++i]!;
  else if (args[i] === "--swift") swiftBinary = args[++i]!;
}
if (roots.length === 0) roots.push("/Volumes/workspaces");

async function swiftRepos(): Promise<{ repos: SwiftRepo[]; seconds: number | null }> {
  if (swiftJSON) return { repos: JSON.parse(await readFile(swiftJSON, "utf8")).repos, seconds: null };
  if (!swiftBinary)
    throw new Error(
      "binaire de la 0.8.0 introuvable : CAIRN_SWIFT_CLI=<chemin> ou --swift-json <fichier>, --swift <chemin>",
    );
  const started = Date.now();
  const rootArgs = roots.flatMap((r) => ["--root", r]);
  const { stdout } = await promisify(execFile)(swiftBinary, ["git", ...rootArgs, "--json"], {
    maxBuffer: 512 * 1024 * 1024,
  });
  return { repos: JSON.parse(stdout).repos, seconds: (Date.now() - started) / 1000 };
}

const started = Date.now();
const ts = await analyzeAll(roots, defaultGitOptions({ fetch: false }), classify, {
  workerFile: path.resolve(import.meta.dir, "../src/core/git/worker.ts"),
  progress: (p) => {
    if (process.stderr.isTTY) process.stderr.write(`${p.done}/${p.total}\r`);
  },
});
const tsSeconds = (Date.now() - started) / 1000;
const swift = await swiftRepos();

const obsoleteSwift = (w: SwiftRepo["worktrees"][number]) =>
  ["orphan", "merged", "stale"].includes(w.status) || w.stale_reason !== null;
const summary = (label: string, repos: number, branches: number, worktrees: number, obsolete: number) =>
  `${label.padEnd(12)} repos=${repos} branches=${branches} worktrees=${worktrees} obsolete=${obsolete}`;

console.log(
  summary(
    "TypeScript",
    ts.reports.length,
    ts.reports.reduce((n, r) => n + r.branches.length, 0),
    ts.reports.reduce((n, r) => n + r.worktrees.length, 0),
    ts.reports.reduce((n, r) => n + r.worktrees.filter(worktreeIsObsolete).length, 0),
  ),
  `(${tsSeconds.toFixed(1)} s, ${Object.keys(ts.failed).length} échec(s))`,
);
console.log(
  summary(
    "Swift 0.8.0",
    swift.repos.length,
    swift.repos.reduce((n, r) => n + r.branches.length, 0),
    swift.repos.reduce((n, r) => n + r.worktrees.length, 0),
    swift.repos.reduce((n, r) => n + r.worktrees.filter(obsoleteSwift).length, 0),
  ),
  swift.seconds === null ? "" : `(${swift.seconds.toFixed(1)} s)`,
);
for (const [repo, reason] of Object.entries(ts.failed)) console.log(`échec ${repo} : ${reason}`);

// Écarts dépôt par dépôt : dépôts manquants, branches (nom:statut) et worktrees (chemin:statut) différents.
const byPath = new Map<string, RepoReport>(ts.reports.map((r) => [r.path, r]));
const swiftPaths = new Set(swift.repos.map((r) => r.path));
for (const r of swift.repos) if (!byPath.has(r.path)) console.log(`absent côté TypeScript : ${r.path}`);
for (const r of ts.reports) if (!swiftPaths.has(r.path)) console.log(`absent côté Swift : ${r.path}`);
let differences = 0;
for (const s of swift.repos) {
  const r = byPath.get(s.path);
  if (!r) continue;
  const a = s.branches.map((b) => `${b.name}:${b.status}`).sort();
  const b = r.branches.map((x) => `${x.name}:${x.status}`).sort();
  const c = s.worktrees.map((w) => `${w.path}:${w.status}`).sort();
  const d = r.worktrees.map((w) => `${w.path}:${w.status}`).sort();
  if (a.join() !== b.join() || c.join() !== d.join()) {
    differences += 1;
    console.log(`écart ${s.path}\n  swift branches=${a.join(" ")} worktrees=${c.join(" ")}`);
    console.log(`  ts    branches=${b.join(" ")} worktrees=${d.join(" ")}`);
  }
}
console.log(`dépôts avec un écart : ${differences}`);
