import CairnCore
import Foundation
import Testing

private struct GitCommandFailed: Error, CustomStringConvertible {
    let command: String
    var description: String { "git \(command) a échoué" }
}

@discardableResult
private func git(_ dir: URL, _ args: String...) throws -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    p.arguments = ["-C", dir.path, "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main",
                   "-c", "commit.gpgsign=false"] + args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    try p.run()
    let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw GitCommandFailed(command: args.joined(separator: " ")) }
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func commit(_ dir: URL, _ file: String, _ content: String, _ msg: String) throws {
    try writeText(dir.appendingPathComponent(file), content)
    try git(dir, "add", file)
    try git(dir, "commit", "-q", "-m", msg)
}

private func writeText(_ url: URL, _ s: String) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try s.write(to: url, atomically: true, encoding: .utf8)
}

/// Dépôt cloné avec : branche fusionnée, branche squashée, branche non fusionnée (toutes « gone »),
/// une branche gone extraite dans un worktree conservé, et des worktrees orphelin / fusionné / inactif / à risque.
private func makeFixture(_ dir: URL) throws -> URL {
    let remote = dir.appendingPathComponent("remote.git")
    try FileManager.default.createDirectory(at: remote, withIntermediateDirectories: true)
    try git(remote, "init", "-q", "--bare")
    let repo = dir.appendingPathComponent("work/app")
    try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
    try git(repo, "init", "-q")
    try commit(repo, "README.md", "base\n", "base")
    try git(repo, "remote", "add", "origin", remote.path)
    try git(repo, "push", "-q", "-u", "origin", "main")

    func branch(_ name: String, _ file: String) throws {
        try git(repo, "checkout", "-q", "-b", name, "main")
        try commit(repo, file, "\(name)\n", "feat \(name)")
        try git(repo, "push", "-q", "-u", "origin", name)
    }
    try branch("feat-merged", "a.txt")
    try branch("feat-squash", "b.txt")
    try branch("feat-wip", "c.txt")
    try branch("feat-wt", "d.txt")
    try branch("feat-wt-risk", "e.txt")
    try git(repo, "checkout", "-q", "main")
    try git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feat-merged")
    try git(repo, "merge", "-q", "--squash", "feat-squash")
    try git(repo, "commit", "-q", "-m", "squash b")
    try git(repo, "merge", "-q", "--squash", "feat-wt")
    try git(repo, "commit", "-q", "-m", "squash d")
    try git(repo, "push", "-q", "origin", "main")
    for b in ["feat-merged", "feat-squash", "feat-wip", "feat-wt", "feat-wt-risk"] { try git(repo, "push", "-q", "origin", "--delete", b) }
    try git(repo, "fetch", "-q", "--prune")
    try git(repo, "remote", "set-head", "origin", "main")

    // Worktrees : fusionné (dans .claude/worktrees), à risque, orphelin, inactif.
    try git(repo, "worktree", "add", "-q", repo.appendingPathComponent(".claude/worktrees/wt").path, "feat-wt")
    let risk = dir.appendingPathComponent("work/app-risk")
    try git(repo, "worktree", "add", "-q", risk.path, "feat-wt-risk")
    try writeText(risk.appendingPathComponent("dirty.txt"), "en cours\n")
    let orphan = dir.appendingPathComponent("work/app-orphan")
    try git(repo, "worktree", "add", "-q", "-b", "orphan-branch", orphan.path, "main")
    try FileManager.default.removeItem(at: orphan)
    let old = dir.appendingPathComponent("work/app-old")
    try git(repo, "worktree", "add", "-q", "-b", "old-branch", old.path, "main")
    try commit(old, "old.txt", "x\n", "old work")
    try git(old, "push", "-q", "-u", "origin", "old-branch")
    let past = Date().addingTimeInterval(-60 * 86_400)
    let fm = FileManager.default
    if let e = fm.enumerator(atPath: old.path) {
        for case let f as String in e { try? fm.setAttributes([.modificationDate: past], ofItemAtPath: old.appendingPathComponent(f).path) }
    }
    return repo
}

extension CairnTests {
    @Suite struct GitTests {
        @Test func branch_statuses_and_protection() throws {
            try withTempDir { dir in
                let repo = try makeFixture(dir)
                let r = GitMaintenance.analyze(repo: repo.path, options: GitOptions())
                let st = Dictionary(uniqueKeysWithValues: r.branches.map { ($0.name, $0.status) })
                #expect(st["feat-merged"] == .merged)
                #expect(st["feat-squash"] == .squash)
                #expect(st["feat-wip"] == .unmerged)
                #expect(st["main"] == nil, "la branche principale n'est jamais proposée")
                let wtBranch = try #require(r.branches.first { $0.name == "feat-wt" })
                #expect(wtBranch.checkedOutInWorktree != nil, "branche extraite dans un worktree")
                #expect(!GitMaintenance.selectedByDefault(wtBranch, options: GitOptions()), "branche d'un worktree gardé non proposée")
                let selected = r.branches.filter { GitMaintenance.selectedByDefault($0, options: GitOptions()) }.map(\.name).sorted()
                #expect(selected == ["feat-merged", "feat-squash"])
                #expect(r.reclaimableBytes >= 0)
            }
        }

        @Test func worktree_statuses() throws {
            try withTempDir { dir in
                let repo = try makeFixture(dir)
                var o = GitOptions()
                o.staleDays = 30
                let r = GitMaintenance.analyze(repo: repo.path, options: o)
                func wt(_ suffix: String) -> WorktreeInfo? { r.worktrees.first { $0.path.hasSuffix(suffix) } }
                #expect(wt("/wt")?.status == .merged)
                #expect(wt("/wt").map { GitMaintenance.selectedByDefault($0, options: o) } == true)
                #expect(wt("app-orphan")?.status == .orphan)
                #expect(wt("app-old")?.status == .stale)
                let risk = wt("app-risk")
                #expect(risk?.status == .risk)
                #expect(risk.map { !GitMaintenance.selectedByDefault($0, options: o) } == true, "un worktree à risque n'est jamais présélectionné")
            }
        }

        @Test(.globalState) func simulation_changes_nothing() throws {
            try withTempDir { dir in
                let repo = try makeFixture(dir)
                let before = try git(repo, "for-each-ref", "--format=%(refname)")
                var out = ""
                let code = CLI.run(["cairn", "git", "--root", dir.appendingPathComponent("work").path, "--lang", "en-US"],
                                   out: { out += $0 + "\n" }, err: { _ in })
                #expect(code == .ok)
                #expect(out.contains("Simulation"), "\(out)")
                #expect(try git(repo, "for-each-ref", "--format=%(refname)") == before)
            }
        }

        @Test func apply_logs_sha_and_branch_can_be_recreated() throws {
            try withTempDir { dir in
                let repo = try makeFixture(dir)
                let shaMerged = try git(repo, "rev-parse", "refs/heads/feat-merged")
                var o = GitOptions()
                o.gc = false
                let r = GitMaintenance.analyze(repo: repo.path, options: o)
                let wts = r.worktrees.filter { GitMaintenance.selectedByDefault($0, options: o) }
                let res = GitMaintenance.apply(repo: repo.path, branches: ["feat-merged", "feat-squash", "feat-wt"], worktrees: wts, options: o)
                #expect(res.failures.isEmpty, "\(res.failures)")
                #expect(res.deletedBranches.sorted() == ["feat-merged", "feat-squash", "feat-wt"])
                #expect(!FileManager.default.fileExists(atPath: repo.appendingPathComponent(".claude/worktrees/wt").path))
                #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("work/app-risk/dirty.txt").path), "le worktree à risque est intact")
                let log = try String(contentsOf: repo.appendingPathComponent(".git/cleanup-deleted-branches.log"), encoding: .utf8)
                #expect(log.contains("feat-merged\t\(shaMerged)"), "\(log)")
                #expect(log.contains("worktree\t"), "\(log)")
                try git(repo, "branch", "feat-merged", shaMerged)
                #expect(try git(repo, "rev-parse", "refs/heads/feat-merged") == shaMerged)
            }
        }

        @Test(.globalState) func cli_apply_worktrees_only_and_tsv_report() throws {
            try withTempDir { dir in
                let repo = try makeFixture(dir)
                let report = dir.appendingPathComponent("report.tsv")
                let code = CLI.run(["cairn", "git", "--root", dir.appendingPathComponent("work").path, "--worktrees-only", "--apply",
                                    "--yes", "--no-gc", "--report", report.path], out: { _ in }, err: { _ in })
                #expect(code == .ok)
                let tsv = try String(contentsOf: report, encoding: .utf8)
                #expect(tsv.hasPrefix("repo\tbranche\tstatut\tsha\tdernier_commit\tsujet\n"))
                #expect(tsv.contains("\tfeat-squash\tsquash\t"), "\(tsv)")
                // Branches intactes (worktrees seulement), worktree à risque gardé, orphelin retiré de git.
                let kept = try git(repo, "branch", "--list", "feat-merged")
                #expect(kept.contains("feat-merged"))
                let list = try git(repo, "worktree", "list")
                #expect(list.contains("app-risk") && !list.contains("app-orphan") && !list.contains("/wt "), "\(list)")
            }
        }

        @Test func worker_pool_matches_in_process_and_enforces_memory_limit() throws {
            let exe = try #require(builtExecutable("Cairn"), "binaire Cairn introuvable (swift build)").path
            try withTempDir { dir in
                _ = try makeFixture(dir)
                let root = dir.appendingPathComponent("work").path
                let local = GitMaintenance.analyzeAll(folders: [root], options: GitOptions(), executable: nil)
                var last: GitMaintenance.PoolProgress?
                let pooled = GitMaintenance.analyzeAll(folders: [root], options: GitOptions(), executable: exe) { last = $0 }
                #expect(pooled.map(\.path) == local.map(\.path))
                #expect(pooled.first?.branches.map(\.status) == local.first?.branches.map(\.status))
                #expect(pooled.first?.worktrees.map(\.status) == local.first?.worktrees.map(\.status))
                #expect(last?.done == last?.total)
                // Limite de mémoire ridicule : le worker est arrêté, l'analyse continue sans planter.
                var p2: GitMaintenance.PoolProgress?
                let limited = GitMaintenance.analyzeAll(folders: [root], options: GitOptions(), memoryLimit: 1,
                                                       executable: exe) { p2 = $0 }
                // Un worker rapide peut finir avant le premier contrôle (toutes les secondes) : chaque dépôt doit
                // donc soit produire un rapport, soit être signalé en échec — jamais de blocage ni de plantage.
                #expect(limited.count + (p2?.failed.count ?? 0) == p2?.total ?? -1)
            }
        }

        @Test func reports_stream_as_each_repo_finishes() throws {
            // L'écran Git affiche chaque dépôt dès qu'il est analysé : chaque rapport passe par `onReport`, avec un
            // avancement qui commence à 0, et la présélection calculée dépôt par dépôt égale celle de l'ensemble.
            let exe = try #require(builtExecutable("Cairn"), "binaire Cairn introuvable (swift build)").path
            try withTempDir { dir in
                _ = try makeFixture(dir)
                let root = dir.appendingPathComponent("work").path
                for worker in [nil, exe] {
                    let lock = NSLock()
                    var streamed: [RepoReport] = []
                    var first: GitMaintenance.PoolProgress?
                    let all = GitMaintenance.analyzeAll(folders: [root], options: GitOptions(), executable: worker,
                                                        progress: { p in lock.withLock { if first == nil { first = p } } },
                                                        onReport: { r in lock.withLock { streamed.append(r) } })
                    try #require(!all.isEmpty)
                    #expect(Set(streamed.map(\.path)) == Set(all.map(\.path)))
                    #expect(first?.done == 0)
                    #expect(first?.total == all.count)
                    var b = Set<String>(), w = Set<String>()
                    for r in streamed {
                        let one = GitMaintenance.preselection([r], options: GitOptions())
                        b.formUnion(one.branches); w.formUnion(one.worktrees)
                    }
                    let whole = GitMaintenance.preselection(all, options: GitOptions())
                    #expect(b == whole.branches)
                    #expect(w == whole.worktrees)
                    #expect(whole.branches.contains { $0.hasSuffix("#feat-merged") }, "\(whole.branches)")
                }
            }
        }

        @Test func apply_skips_branch_moved_since_analysis() throws {
            try withTempDir { dir in
                let repo = try makeFixture(dir)
                let sha = try git(repo, "rev-parse", "refs/heads/feat-merged")
                var o = GitOptions()
                o.gc = false
                let res = GitMaintenance.apply(repo: repo.path, branches: ["feat-merged"], worktrees: [], options: o,
                                               expectedSHAs: ["feat-merged": "0000000"])
                #expect(res.failures == ["feat-merged"])
                #expect(try git(repo, "rev-parse", "refs/heads/feat-merged") == sha, "branche gardée")
                let ok = GitMaintenance.apply(repo: repo.path, branches: ["feat-merged"], worktrees: [], options: o,
                                              expectedSHAs: ["feat-merged": String(sha.prefix(7))])
                #expect(ok.deletedBranches == ["feat-merged"])
            }
        }
    }
}
