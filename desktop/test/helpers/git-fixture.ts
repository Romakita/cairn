// Dépôts git de test (port des fixtures de GitTests.swift et StorageWarningTests.swift), toujours dans os.tmpdir().
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Dossier temporaire au chemin réel (`/private/var/…`), tel que git le rapporte. */
export function tempDir(prefix = "cairn-git-"): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** git avec une identité de test, `main` par défaut, sans signature ; lève une erreur si git échoue. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "/usr/bin/git",
    [
      "-C",
      dir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.com",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

export function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function commit(dir: string, file: string, content: string, message: string): void {
  writeText(path.join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message);
}

export function objectExists(repo: string, sha: string): boolean {
  try {
    git(repo, "cat-file", "-e", sha);
    return true;
  } catch {
    return false;
  }
}

/** Date de modification reculée pour tout un dossier (fichiers et dossiers). */
export function touchTree(root: string, date: Date): void {
  for (const e of readdirSync(root, { withFileTypes: true, recursive: true })) {
    try {
      utimesSync(path.join(e.parentPath, e.name), date, date);
    } catch {}
  }
}

/**
 * Dépôt cloné (`<dir>/work/app`) avec : branche fusionnée, squashée, non fusionnée (toutes « gone »), une branche
 * gone extraite dans un worktree conservé, et des worktrees fusionné / à risque / orphelin / inactif.
 */
export function makeFixture(dir: string): string {
  const remote = path.join(dir, "remote.git");
  mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare");
  const repo = path.join(dir, "work/app");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  commit(repo, "README.md", "base\n", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");

  const branch = (name: string, file: string) => {
    git(repo, "checkout", "-q", "-b", name, "main");
    commit(repo, file, `${name}\n`, `feat ${name}`);
    git(repo, "push", "-q", "-u", "origin", name);
  };
  branch("feat-merged", "a.txt");
  branch("feat-squash", "b.txt");
  branch("feat-wip", "c.txt");
  branch("feat-wt", "d.txt");
  branch("feat-wt-risk", "e.txt");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feat-merged");
  git(repo, "merge", "-q", "--squash", "feat-squash");
  git(repo, "commit", "-q", "-m", "squash b");
  git(repo, "merge", "-q", "--squash", "feat-wt");
  git(repo, "commit", "-q", "-m", "squash d");
  git(repo, "push", "-q", "origin", "main");
  for (const b of ["feat-merged", "feat-squash", "feat-wip", "feat-wt", "feat-wt-risk"]) {
    git(repo, "push", "-q", "origin", "--delete", b);
  }
  git(repo, "fetch", "-q", "--prune"); // dépôt local de test, distant local : aucun réseau
  git(repo, "remote", "set-head", "origin", "main");

  // Worktrees : fusionné (dans .claude/worktrees), à risque, orphelin, inactif.
  git(repo, "worktree", "add", "-q", path.join(repo, ".claude/worktrees/wt"), "feat-wt");
  const risk = path.join(dir, "work/app-risk");
  git(repo, "worktree", "add", "-q", risk, "feat-wt-risk");
  writeText(path.join(risk, "dirty.txt"), "en cours\n");
  const orphan = path.join(dir, "work/app-orphan");
  git(repo, "worktree", "add", "-q", "-b", "orphan-branch", orphan, "main");
  rmSync(orphan, { recursive: true, force: true });
  const old = path.join(dir, "work/app-old");
  git(repo, "worktree", "add", "-q", "-b", "old-branch", old, "main");
  commit(old, "old.txt", "x\n", "old work");
  git(old, "push", "-q", "-u", "origin", "old-branch");
  touchTree(old, new Date(Date.now() - 60 * 86_400_000));
  return repo;
}

/** Dépôt local avec une branche `tmp` non fusionnée (son commit n'est accessible que par elle). */
export function repoWithLooseBranch(dir: string): { repo: string; sha: string } {
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  commit(repo, "a.txt", "base\n", "base");
  git(repo, "checkout", "-q", "-b", "tmp");
  commit(repo, "b.txt", "temporaire\n", "temporaire");
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  return { repo, sha };
}
