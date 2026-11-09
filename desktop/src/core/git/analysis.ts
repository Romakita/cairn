// Analyse d'un dépôt, en lecture seule (port de `GitMaintenance.analyze`, `mergeStatus`, `worktrees`, `estimate`).
// Aucun appel réseau sauf `options.fetch`. Les diffs et historiques passent de git à `git patch-id` en flux.
// Appelée dans un worker_thread du pool (`pool.ts`) : jamais directement depuis le process principal (b23d23f).
import { existsSync } from "../fs.ts";
import { lastModified } from "./discovery.ts";
import { Git } from "./git.ts";
import { selectedBranchByDefault } from "./selection.ts";
import type {
  BranchStatus,
  GitOptions,
  GoneBranch,
  RepoReport,
  ScannerDeps,
  WorktreeInfo,
  WorktreeStatus,
} from "./types.ts";

const MAIN_CANDIDATES = ["main", "master", "develop"] as const;
const DAY_MS = 86_400_000;

/** Format des branches : nom, suivi (`[gone]`), SHA court, date du dernier commit, sujet (séparés par 0x1f). */
export const BRANCH_FORMAT =
  "%(refname:short)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:short)%1f%(subject)";

/** Branche principale : origin/HEAD, sinon main/master/develop (distante puis locale). */
export async function mainRef(git: Git): Promise<string | null> {
  const head = await git.line(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const b of MAIN_CANDIDATES) {
    if (await git.ok(["show-ref", "-q", "--verify", `refs/remotes/origin/${b}`])) return `refs/remotes/origin/${b}`;
  }
  for (const b of MAIN_CANDIDATES) {
    if (await git.ok(["show-ref", "-q", "--verify", `refs/heads/${b}`])) return `refs/heads/${b}`;
  }
  return null;
}

/**
 * Nom court de la branche principale : `refs/remotes/origin/main` et `refs/heads/main` donnent `main`. La branche
 * locale de ce nom est protégée, même extraite dans un worktree lié (01538a8).
 */
export function isMainBranch(name: string, main: string | null): boolean {
  if (main === null) return false;
  let short: string;
  if (main.startsWith("refs/heads/")) short = main.slice("refs/heads/".length);
  else if (main.startsWith("refs/remotes/")) short = main.split("/").slice(3).join("/");
  else short = main;
  return name === short;
}

/**
 * Fusionnée (ancêtre, ou aucun changement), squashée (même patch-id qu'un commit de la principale) ou non fusionnée.
 * Tout échec de git compte comme `unmerged` : une erreur ne doit jamais faire supprimer du travail (46a9475).
 */
export async function mergeStatus(git: Git, ref: string, main: string | null): Promise<BranchStatus> {
  if (main === null) return "unmerged";
  if (await git.ok(["merge-base", "--is-ancestor", ref, main])) return "merged";
  const base = await git.line(["merge-base", ref, main]);
  if (base === null) return "unmerged";
  const quiet = (await git.run(["diff", "--quiet", base, ref])).status;
  if (quiet === 0) return "merged";
  if (quiet !== 1) return "unmerged";
  // Empreinte du diff complet de la branche, calculée de git à git : rien n'est gardé en mémoire.
  let pid: string | null = null;
  await git.pipeLines(["diff", base, ref], ["patch-id", "--stable"], (l) => {
    if (pid === null) pid = l.split(" ")[0] || null;
  });
  if (pid === null) return "unmerged"; // empreinte illisible : prudence
  const prefix = `${pid} `;
  let found = false;
  await git.pipeLines(
    ["log", "-p", "--no-merges", "--format=commit %H", `${base}..${main}`],
    ["patch-id", "--stable"],
    (l) => {
      if (!found && l.startsWith(prefix)) found = true;
    },
  );
  return found ? "squash" : "unmerged";
}

export interface RawWorktree {
  path: string;
  head: string;
  branch: string | null;
  prunable: boolean;
  bare: boolean;
}

/** `git worktree list --porcelain` ; le premier est le dépôt lui-même. */
export function parseWorktrees(text: string): RawWorktree[] {
  const list: RawWorktree[] = [];
  let cur: RawWorktree | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) list.push(cur);
      cur = { path: line.slice("worktree ".length), head: "", branch: null, prunable: false, bare: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch refs/heads/")) cur.branch = line.slice("branch refs/heads/".length);
    else if (line.startsWith("prunable")) cur.prunable = true;
    else if (line === "bare") cur.bare = true;
  }
  if (cur) list.push(cur);
  return list;
}

async function worktreeList(git: Git): Promise<RawWorktree[]> {
  return parseWorktrees((await git.run(["worktree", "list", "--porcelain"])).out);
}

async function worktreeInfo(
  git: Git,
  w: RawWorktree,
  main: string | null,
  staleDays: number,
  now: Date,
  deps: ScannerDeps,
): Promise<WorktreeInfo> {
  const exists = existsSync(w.path);
  let size = 0;
  let regenerable = 0;
  let modified = 0;
  let untracked = 0;
  let unpushed = 0;
  let last: Date | null = null;
  // Une branche fusionnée ou squashée dans la principale n'a pas de travail « non poussé » à perdre.
  const branchStatus =
    w.branch !== null && !isMainBranch(w.branch, main) ? await mergeStatus(git, `refs/heads/${w.branch}`, main) : null;
  const integrated = branchStatus !== null && branchStatus !== "unmerged";
  if (exists) {
    ({ size, regenerable } = await deps.measure(w.path));
    const wt = new Git(w.path, git.group);
    await wt.run(["status", "--porcelain"], {
      onLine: (l) => {
        if (l === "") return;
        if (l.startsWith("??")) untracked += 1;
        else modified += 1;
      },
    });
    unpushed = integrated
      ? 0
      : Number.parseInt((await wt.line(["rev-list", "--count", "HEAD", "--not", "--remotes"])) ?? "0", 10) || 0;
    last = await lastModified(w.path, deps.classify);
  }
  let staleReason: WorktreeStatus | null = null;
  if (!exists || w.prunable) staleReason = "orphan";
  else if (integrated) staleReason = "merged";
  else if (last && now.getTime() - last.getTime() > staleDays * DAY_MS) staleReason = "stale";
  const atRisk = modified > 0 || untracked > 0 || unpushed > 0;
  const status: WorktreeStatus = atRisk && exists ? "risk" : (staleReason ?? "active");
  return {
    repo: git.repo,
    path: w.path,
    branch: w.branch,
    head: w.head,
    exists: exists && !w.prunable,
    size,
    regenerable,
    lastModified: last,
    modifiedFiles: modified,
    untrackedFiles: untracked,
    unpushedCommits: unpushed,
    status,
    staleReason: status === "risk" ? staleReason : null,
    branchStatus,
  };
}

/** Octets des objets non compressés et des packs (`git count-objects -v`, en Kio). */
export async function objectSizes(git: Git): Promise<{ loose: number; pack: number }> {
  let loose = 0;
  let pack = 0;
  for (const l of (await git.run(["count-objects", "-v"])).out.split("\n")) {
    const p = l.split(":").map((s) => s.trim());
    if (p.length !== 2 || !/^-?\d+$/.test(p[1]!)) continue;
    const v = Number.parseInt(p[1]!, 10);
    if (p[0] === "size") loose = v * 1024;
    else if (p[0] === "size-pack") pack = v * 1024;
  }
  return { loose, pack };
}

/** Octets des objets accessibles seulement par les branches supprimées (`rev-list --disk-usage`). */
export async function estimate(git: Git, names: readonly string[]): Promise<number> {
  if (names.length === 0) return 0;
  const del = new Set(names.map((n) => `refs/heads/${n}`));
  const others: string[] = [];
  await git.run(["for-each-ref", "--format=%(refname)"], {
    onLine: (l) => {
      if (l !== "" && !del.has(l)) others.push(l);
    },
  });
  const input = `${[...[...del].sort(), ...others.map((o) => `^${o}`)].join("\n")}\n`;
  const out = (await git.run(["rev-list", "--stdin", "--objects", "--disk-usage"], { stdin: input })).out.trim();
  return /^\d+$/.test(out) ? Number.parseInt(out, 10) : 0;
}

function parseBranchLine(line: string): string[] | null {
  const f = line.split("\x1f");
  return f.length >= 5 ? f : null;
}

/** Rapport complet d'un dépôt. */
export async function analyze(
  repo: string,
  options: GitOptions,
  deps: ScannerDeps,
  now: Date = new Date(),
  git: Git = new Git(repo),
): Promise<RepoReport> {
  if (options.fetch && ((await git.line(["remote"])) ?? "") !== "") {
    await git.run(["fetch", "--all", "--prune", "--quiet"]);
  }
  const { loose, pack } = await objectSizes(git);
  const main = await mainRef(git);
  const current = await git.line(["symbolic-ref", "-q", "--short", "HEAD"]);
  const raw = await worktreeList(git);
  const checkedOut = new Map<string, string>();
  for (const w of raw.slice(1)) if (w.branch !== null && !checkedOut.has(w.branch)) checkedOut.set(w.branch, w.path);

  const gone: string[][] = [];
  await git.run(["for-each-ref", "refs/heads", `--format=${BRANCH_FORMAT}`], {
    onLine: (l) => {
      const f = parseBranchLine(l);
      if (f?.[1]?.includes("gone")) gone.push(f);
    },
  });
  const branches: GoneBranch[] = [];
  for (const f of gone) {
    const name = f[0]!;
    if (name === current || isMainBranch(name, main)) continue; // jamais la courante ni la principale
    branches.push({
      repo,
      name,
      status: await mergeStatus(git, `refs/heads/${name}`, main),
      sha: f[2]!,
      date: f[3]!,
      subject: f.slice(4).join(" "),
      checkedOutInWorktree: checkedOut.get(name) ?? null,
    });
  }

  const worktrees: WorktreeInfo[] = [];
  for (const w of raw.slice(1)) {
    if (!w.bare) worktrees.push(await worktreeInfo(git, w, main, options.staleDays, now, deps));
  }
  // Branche fusionnée ou squashée d'un worktree, même si son amont existe encore : proposée avec le worktree.
  const known = new Set(branches.map((b) => b.name));
  for (const w of worktrees) {
    const name = w.branch;
    const st = w.branchStatus;
    if (name === null || st === null || st === "unmerged" || known.has(name) || name === current) continue;
    if (isMainBranch(name, main)) continue;
    const l = await git.line(["for-each-ref", `refs/heads/${name}`, `--format=${BRANCH_FORMAT}`]);
    const f = l === null ? null : parseBranchLine(l);
    if (!f) continue;
    branches.push({
      repo,
      name,
      status: st,
      sha: f[2]!,
      date: f[3]!,
      subject: f.slice(4).join(" "),
      checkedOutInWorktree: w.path,
    });
  }

  const toDelete = branches.filter((b) => selectedBranchByDefault(b, options)).map((b) => b.name);
  const lastCommitText = await git.line([
    "for-each-ref",
    "--sort=-committerdate",
    "--count=1",
    "--format=%(committerdate:unix)",
  ]);
  const lastCommit = lastCommitText && /^\d+$/.test(lastCommitText) ? new Date(Number(lastCommitText) * 1000) : null;
  const lastFile = await lastModified(repo, deps.classify);
  const modified = await git.countLines(["status", "--porcelain"]);
  const unpushed =
    Number.parseInt((await git.line(["rev-list", "--count", "--branches", "--not", "--remotes"])) ?? "0", 10) || 0;
  const dates = [lastCommit, lastFile].filter((d): d is Date => d !== null);
  return {
    path: repo,
    gitBytes: loose + pack,
    looseBytes: loose,
    mainRef: main,
    branches,
    worktrees,
    reclaimableBytes: await estimate(git, toDelete),
    lastModified: dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
    modifiedFiles: modified,
    unpushedCommits: unpushed,
  };
}

/** Tailles remesurées après une suppression (`.git`, espace récupérable), sans refaire l'analyse. */
export async function refreshSizes(report: RepoReport, options: GitOptions): Promise<RepoReport> {
  const git = new Git(report.path);
  const { loose, pack } = await objectSizes(git);
  const toDelete = report.branches.filter((b) => selectedBranchByDefault(b, options)).map((b) => b.name);
  return { ...report, gitBytes: loose + pack, looseBytes: loose, reclaimableBytes: await estimate(git, toDelete) };
}
