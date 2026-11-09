// Maintenance git : analyse, statuts, worktrees, découverte (port de GitTests.swift, des cas git de
// StorageWarningTests.swift et de HubTests.full_check_git_options_are_read_only_and_unfiltered).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../../src/core/config.ts";
import { analyze, isMainBranch, parseWorktrees } from "../../src/core/git/analysis.ts";
import { defaultScannerDeps } from "../../src/core/git/deps.ts";
import { discover, lastModified } from "../../src/core/git/discovery.ts";
import { GIT_SSH_COMMAND, gitEnv } from "../../src/core/git/git.ts";
import { tsv } from "../../src/core/git/report-tsv.ts";
import {
  branchesFollowing,
  planFor,
  preselection,
  recap,
  selectedBranchByDefault,
  selectedWorktreeByDefault,
} from "../../src/core/git/selection.ts";
import { branchId, defaultGitOptions, forAnalysis, worktreeId } from "../../src/core/git/types.ts";
import { classify } from "../../src/core/regenerable.ts";
import { commit, git, makeFixture, removeDir, tempDir, touchTree } from "../helpers/git-fixture.ts";

const dirs: string[] = [];
function temp(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("git", () => {
  test("branch statuses and protection", async () => {
    const repo = makeFixture(temp());
    const r = await analyze(repo, defaultGitOptions(), defaultScannerDeps);
    const st = Object.fromEntries(r.branches.map((b) => [b.name, b.status]));
    expect(st["feat-merged"]).toBe("merged");
    expect(st["feat-squash"]).toBe("squash");
    expect(st["feat-wip"]).toBe("unmerged");
    expect(st.main).toBeUndefined(); // la branche principale n'est jamais proposée
    const wtBranch = r.branches.find((b) => b.name === "feat-wt");
    expect(wtBranch?.checkedOutInWorktree).not.toBeNull(); // extraite dans un worktree
    expect(selectedBranchByDefault(wtBranch!, defaultGitOptions())).toBe(false);
    const selected = r.branches
      .filter((b) => selectedBranchByDefault(b, defaultGitOptions()))
      .map((b) => b.name)
      .sort();
    expect(selected).toEqual(["feat-merged", "feat-squash"]);
    expect(r.reclaimableBytes).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("worktree statuses", async () => {
    const repo = makeFixture(temp());
    const o = defaultGitOptions({ staleDays: 30 });
    const r = await analyze(repo, o, defaultScannerDeps);
    const wt = (suffix: string) => r.worktrees.find((w) => w.path.endsWith(suffix));
    expect(wt("/wt")?.status).toBe("merged");
    expect(selectedWorktreeByDefault(wt("/wt")!, o)).toBe(true);
    expect(wt("app-orphan")?.status).toBe("orphan");
    expect(wt("app-old")?.status).toBe("stale");
    const risk = wt("app-risk");
    expect(risk?.status).toBe("risk");
    expect(selectedWorktreeByDefault(risk!, o)).toBe(false); // jamais présélectionné à risque
    expect(risk?.staleReason).toBeNull(); // actif : même --include-at-risk ne le propose pas
    expect(selectedWorktreeByDefault(risk!, { ...o, includeAtRisk: true })).toBe(false);
    expect(risk?.untrackedFiles).toBe(1);
    expect(wt("/wt")?.size).toBeGreaterThan(0);
  }, 30_000);

  test("repository report: last activity, unpushed commits, git size", async () => {
    const repo = makeFixture(temp());
    const r = await analyze(repo, defaultGitOptions({ gc: false }), defaultScannerDeps);
    expect(r.lastModified).not.toBeNull();
    expect(Date.now() - r.lastModified!.getTime()).toBeLessThan(3_600_000); // activité récente
    expect(r.unpushedCommits).toBeGreaterThan(0); // branches locales absentes du distant
    expect(r.gitBytes).toBeGreaterThan(0);
    expect(r.mainRef).toBe("refs/remotes/origin/main");
    expect(r.modifiedFiles).toBe(1); // `.claude/` (le worktree lié) n'est pas suivi
    writeFileSync(path.join(repo, "new.txt"), "x");
    expect((await analyze(repo, defaultGitOptions(), defaultScannerDeps)).modifiedFiles).toBe(2);
  }, 30_000);

  test("discovery uses the scanner classification", async () => {
    const dir = temp();
    for (const p of [
      "app/.git",
      "node_modules/pkg/.git",
      "web/.git",
      "web/build/gen/.git",
      "tools/build/lib/.git",
      ".Trash/old/.git",
      ".Spotlight-V100/x/.git",
    ]) {
      mkdirSync(path.join(dir, p), { recursive: true });
    }
    writeFileSync(path.join(dir, "web/package.json"), "{}");
    writeFileSync(path.join(dir, "file-.git"), ""); // un fichier n'est pas un dépôt
    const repos = (await discover([dir], classify)).map((p) => path.relative(dir, p));
    // node_modules, build à côté d'un package.json, corbeille et métadonnées de volume ignorés ; « build » parcouru.
    expect(repos).toEqual(["app", "tools/build/lib", "web"]);
  });

  test("main branch protection uses the short name", () => {
    expect(isMainBranch("main", "refs/remotes/origin/main")).toBe(true);
    expect(isMainBranch("release/x", "refs/remotes/upstream/release/x")).toBe(true);
    expect(isMainBranch("master", "refs/heads/master")).toBe(true);
    expect(isMainBranch("main-old", "refs/remotes/origin/main")).toBe(false);
    expect(isMainBranch("main", null)).toBe(false);
  });

  test("main branch checked out in a linked worktree is never proposed", async () => {
    const dir = temp();
    const origin = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    git(dir, "init", "-q", "--bare", origin);
    git(repo, "init", "-q");
    commit(repo, "a.txt", "base\n", "base");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "-u", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");
    // Le dépôt principal passe sur une autre branche ; main est extraite dans un worktree lié.
    git(repo, "checkout", "-q", "-b", "dev");
    git(repo, "worktree", "add", "-q", path.join(dir, "repo-main"), "main");
    const r = await analyze(repo, defaultGitOptions(), defaultScannerDeps);
    expect(r.mainRef).toBe("refs/remotes/origin/main");
    expect(r.branches.some((b) => b.name === "main")).toBe(false);
    const w = r.worktrees.find((x) => x.branch === "main");
    expect(w).toBeDefined();
    expect(w?.branchStatus).toBeNull(); // pas de statut de fusion pour la principale
    expect(branchesFollowing(new Set(r.worktrees.map((x) => x.path)), r.branches)).toEqual([]);
  }, 30_000);

  test("merged worktree branch is proposed with its worktree, never alone", async () => {
    const dir = temp();
    const repo = path.join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    commit(repo, "a.txt", "base\n", "base");
    const wtPath = path.join(dir, "repo-feat");
    git(repo, "worktree", "add", "-q", "-b", "feat", wtPath, "main");
    commit(wtPath, "f.txt", "feature\n", "feature");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
    // Branche sans amont (donc pas « gone ») mais fusionnée : proposée avec son worktree.
    const r = await analyze(repo, defaultGitOptions(), defaultScannerDeps);
    const wt = r.worktrees.find((w) => w.path.endsWith("/repo-feat"));
    expect(wt?.status).toBe("merged");
    const feat = r.branches.find((b) => b.name === "feat");
    expect(feat?.status).toBe("merged");
    expect(feat?.checkedOutInWorktree).toBe(wt!.path);
    expect(selectedBranchByDefault(feat!, defaultGitOptions())).toBe(false); // jamais seule
    expect(branchesFollowing(new Set([wt!.path]), r.branches).map((b) => b.name)).toEqual(["feat"]);
    expect(branchesFollowing(new Set(), r.branches)).toEqual([]);
    // Récapitulatif de la sélection (worktree + sa branche).
    const all = recap([r], new Set(r.branches.map(branchId)), new Set([worktreeId(wt!)]));
    expect(all.gitBytes).toBeGreaterThan(0);
    expect(all.deletedBranches).toBe(r.branches.length);
    expect(all.keptBranches).toBe(0);
    expect(all.removedWorktrees).toBe(1);
    const none = recap([r], new Set(), new Set());
    expect(none.keptBranches).toBe(r.branches.length);
    expect(none.keptWorktrees).toBe(1);
    // Présélection CLI et hub : le worktree fusionné et sa branche.
    const pre = preselection([r], defaultGitOptions());
    expect([...pre.worktrees]).toEqual([wt!.path]);
    expect([...pre.branches]).toEqual([branchId(feat!)]);
    expect(planFor(r, defaultGitOptions()).branches.map((b) => b.name)).toEqual(["feat"]);
    expect(planFor(r, defaultGitOptions({ worktreesOnly: true })).branches).toEqual([]);
  }, 30_000);

  test("full check git options are read-only and unfiltered", () => {
    const c = defaultConfig();
    c.git.fetchBefore = true;
    c.git.worktreeStaleDays = 12;
    const screen = defaultGitOptions({ only: "cairn" });
    const check = forAnalysis(screen, c, true);
    expect(check.fetch).toBe(false); // jamais de git fetch pendant « Tout vérifier »
    expect(check.only).toBeNull();
    expect(check.staleDays).toBe(12);
    const explicit = forAnalysis(screen, c, false);
    expect(explicit.fetch).toBe(true); // l'analyse git explicite garde fetch_before
    expect(explicit.only).toBe("cairn");
  });

  test("git environment is non-interactive", () => {
    const env = gitEnv({ PATH: "/usr/bin" });
    expect(env.LC_ALL).toBe("C");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_SSH_COMMAND).toBe(GIT_SSH_COMMAND);
    expect(GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes -o ConnectTimeout=10");
    expect(gitEnv({ GIT_SSH_COMMAND: "ssh -i k" }).GIT_SSH_COMMAND).toBe("ssh -i k"); // réglage de l'utilisateur gardé
  });

  test("worktree porcelain parsing", () => {
    const list = parseWorktrees(
      "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /b\nbare\n\nworktree /o\nHEAD bbb\ndetached\nprunable gitdir file points to non-existent location\n",
    );
    expect(list).toEqual([
      { path: "/r", head: "aaa", branch: "main", prunable: false, bare: false },
      { path: "/b", head: "", branch: null, prunable: false, bare: true },
      { path: "/o", head: "bbb", branch: null, prunable: true, bare: false },
    ]);
  });

  test("last modification skips .git and regenerable folders", async () => {
    const dir = temp();
    const old = new Date(Date.now() - 10 * 86_400_000);
    writeFileSync(path.join(dir, "a.txt"), "a");
    mkdirSync(path.join(dir, "node_modules/x"), { recursive: true });
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    touchTree(dir, old);
    writeFileSync(path.join(dir, "node_modules/x/new.js"), "x");
    writeFileSync(path.join(dir, ".git/new"), "x");
    const last = await lastModified(dir, classify);
    expect(Math.abs(last!.getTime() - old.getTime())).toBeLessThan(2000);
    expect(await lastModified(path.join(dir, "missing"), classify)).toBeNull();
  });

  test("TSV report: header, one line per branch, paths relative to a single root", async () => {
    const dir = temp();
    const repo = makeFixture(dir);
    const r = await analyze(repo, defaultGitOptions(), defaultScannerDeps);
    const root = path.join(dir, "work");
    const text = tsv([r], root);
    expect(text.startsWith("repo\tbranche\tstatut\tsha\tdernier_commit\tsujet\n")).toBe(true);
    expect(text).toContain("app\tfeat-squash\tsquash\t");
    expect(text.trimEnd().split("\n").length).toBe(1 + r.branches.length);
    expect(tsv([r], "")).toContain(`${repo}\tfeat-merged\tmerged\t`);
  }, 30_000);
});
