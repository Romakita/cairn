import CairnCore
import Darwin
import Foundation
import Testing

// Lot avertissements : maintenance git, analyse, alertes, barre des menus.

private struct GitCommandFailed: Error, CustomStringConvertible {
    let args: [String]
    var description: String { "git \(args.joined(separator: " ")) a échoué" }
}

@discardableResult
private func run(_ dir: URL, _ args: String...) throws -> String {
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
    guard p.terminationStatus == 0 else { throw GitCommandFailed(args: args) }
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func commit(_ dir: URL, _ file: String, _ msg: String) throws {
    try Data((msg + "\n").utf8).write(to: dir.appendingPathComponent(file))
    try run(dir, "add", file)
    try run(dir, "commit", "-q", "-m", msg)
}

private func objectExists(_ repo: URL, _ sha: String) -> Bool {
    (try? run(repo, "cat-file", "-e", sha)) != nil
}

/// Dépôt local avec une branche `tmp` non fusionnée (son commit n'est accessible que par elle).
private func repoWithLooseBranch(_ dir: URL) throws -> (URL, String) {
    let repo = dir.appendingPathComponent("repo")
    try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
    try run(repo, "init", "-q")
    try commit(repo, "a.txt", "base")
    try run(repo, "checkout", "-q", "-b", "tmp")
    try commit(repo, "b.txt", "temporaire")
    let sha = try run(repo, "rev-parse", "HEAD")
    try run(repo, "checkout", "-q", "main")
    return (repo, sha)
}

private func utcCalendar() -> Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
}

private func node(_ name: String, _ category: CairnCore.Category, _ size: Int64) -> Node {
    let n = Node(name: name, path: "/r/" + name, isDirectory: true, category: category)
    n.size = size
    return n
}

extension CairnTests {
    @Suite struct StorageWarningTests {
        @Test func discover_uses_scanner_classification() throws {
            try withTempDir { dir in
                let fm = FileManager.default
                for p in ["app/.git", "node_modules/pkg/.git", "web/.git", "web/build/gen/.git", "tools/build/lib/.git",
                          ".Trash/old/.git"] {
                    try fm.createDirectory(at: dir.appendingPathComponent(p), withIntermediateDirectories: true)
                }
                try Data("{}".utf8).write(to: dir.appendingPathComponent("web/package.json"))
                // Chemins relatifs (le dossier temporaire peut revenir sous /var ou /private/var).
                let marker = "/" + dir.lastPathComponent + "/"
                let repos = GitMaintenance.discover(in: [dir.path]).compactMap { p in
                    p.range(of: marker).map { String(p[$0.upperBound...]) }
                }
                // node_modules, build à côté d'un package.json et corbeille ignorés ; « build » ordinaire parcouru.
                #expect(repos == ["app", "tools/build/lib", "web"])
            }
        }

        @Test func prune_now_without_gc_prunes_objects() throws {
            try withTempDir { dir in
                var o = GitOptions()
                o.gc = false
                // Témoin : sans « libérer immédiatement », l'objet reste (reflog).
                let (keep, keepSha) = try repoWithLooseBranch(dir.appendingPathComponent("keep"))
                _ = GitMaintenance.apply(repo: keep.path, branches: ["tmp"], worktrees: [], options: o)
                #expect(objectExists(keep, keepSha), "l'objet doit rester sans prune")
                o.pruneNow = true
                let (repo, sha) = try repoWithLooseBranch(dir.appendingPathComponent("prune"))
                let res = GitMaintenance.apply(repo: repo.path, branches: ["tmp"], worktrees: [], options: o)
                #expect(res.deletedBranches == ["tmp"])
                #expect(!objectExists(repo, sha), "objet élagué malgré gc désactivé")
            }
        }

        @Test func merged_worktree_branch_is_proposed_with_worktree() throws {
            try withTempDir { dir in
                let repo = dir.appendingPathComponent("repo")
                try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
                try run(repo, "init", "-q")
                try commit(repo, "a.txt", "base")
                let wtPath = dir.appendingPathComponent("repo-feat")
                try run(repo, "worktree", "add", "-q", "-b", "feat", wtPath.path, "main")
                try commit(wtPath, "f.txt", "feature")
                try run(repo, "merge", "-q", "--no-ff", "-m", "merge feat", "feat")
                // Branche sans amont (donc pas « gone ») mais fusionnée : proposée avec son worktree.
                let r = GitMaintenance.analyze(repo: repo.path, options: GitOptions())
                let wt = try #require(r.worktrees.first { $0.path.hasSuffix("/repo-feat") }, "worktree absent")
                #expect(wt.status == .merged)
                let feat = r.branches.first { $0.name == "feat" }
                #expect(feat?.status == .merged)
                #expect(feat?.checkedOutInWorktree == wt.path)
                #expect(feat.map { !GitMaintenance.selectedByDefault($0, options: GitOptions()) } == true, "jamais seule")
                let following = GitMaintenance.branchesFollowing(worktrees: [wt.path], in: r.branches).map(\.name)
                #expect(following == ["feat"])
                #expect(GitMaintenance.branchesFollowing(worktrees: [], in: r.branches).isEmpty)
                // Récapitulatif de la sélection (worktree + sa branche) : taille des .git, supprimé / gardé.
                let recap = GitMaintenance.recap([r], branches: Set(r.branches.map(\.id)), worktrees: [wt.id])
                #expect(recap.gitBytes > 0)
                #expect(recap.deletedBranches == r.branches.count)
                #expect(recap.keptBranches == 0)
                #expect(recap.removedWorktrees == 1)
                let none = GitMaintenance.recap([r], branches: [], worktrees: [])
                #expect(none.keptBranches == r.branches.count)
                #expect(none.keptWorktrees == 1)
                let res = GitMaintenance.apply(repo: repo.path, branches: following, worktrees: [wt], options: GitOptions())
                #expect(res.failures.isEmpty, "\(res.failures)")
                #expect(res.deletedBranches == ["feat"])
                #expect(try run(repo, "branch", "--list", "feat") == "")
            }
        }

        @Test func scanner_ignores_other_volumes() throws {
            try withTempDir { dir in
                var st = stat()
                let status = lstat(dir.path, &st)
                try #require(status == 0)
                #expect(!Scanner.isOtherVolume(st, rootDevice: st.st_dev))
                #expect(Scanner.isOtherVolume(st, rootDevice: st.st_dev &+ 1), "autre st_dev : autre volume")
                // Sur un seul volume, les deux premiers niveaux sont toujours analysés.
                try writeFile(dir.appendingPathComponent("a/b/f.bin"), size: 4096)
                let r = Scanner.scan(root: dir.path, ctx: ScanContext())
                #expect(r.root.children.contains { $0.name == "a" && $0.children.contains { $0.name == "b" } })
            }
        }

        @Test func cleanup_preselects_biggest_regenerable() {
            let nodes = [node("small", .deps, 50_000_000), node("big", .build, 5_000_000_000),
                         node("src", .source, 9_000_000_000), node("mid", .deps, 800_000_000),
                         node("repo.git", .git, 9_000_000_000)]
            #expect(CleanupSuggestion.preselect(nodes).map(\.name) == ["big", "mid"])
            #expect(CleanupSuggestion.preselect(nodes, limit: 1).map(\.name) == ["big"])
        }

        @Test func next_backup_schedule() throws {
            let cal = utcCalendar()
            func at(_ d: Int, _ h: Int, _ m: Int = 0) -> Date {
                cal.date(from: DateComponents(year: 2026, month: 3, day: d, hour: h, minute: m))!
            }
            var s = CairnConfig.Schedule()
            s.frequency = .daily
            s.time = "12:30"
            // Sauvegardé hier après l'échéance : prochaine aujourd'hui 12:30.
            #expect(Health.nextBackup(s, lastSuccess: at(9, 13), now: at(10, 10), calendar: cal) == at(10, 12, 30))
            // Jamais sauvegardé : échéance déjà passée (en retard).
            let overdue = try #require(Health.nextBackup(s, lastSuccess: nil, now: at(10, 10), calendar: cal))
            #expect(overdue <= at(10, 10))
            s.frequency = .weekly
            s.weekday = "monday" // 2026-03-09 est un lundi
            #expect(Health.nextBackup(s, lastSuccess: at(9, 13), now: at(11, 10), calendar: cal) == at(16, 12, 30))
            s.frequency = .manual
            #expect(Health.nextBackup(s, lastSuccess: nil, now: at(10, 10), calendar: cal) == nil)
        }

        @Test func destination_health_levels() {
            let now = Date()
            let s = CairnConfig.Schedule()
            var ds = RunState.Destination()
            ds.lastSuccess = now.addingTimeInterval(-3600)
            #expect(Health.destination(ds, waiting: false, schedule: s, now: now) == .ok)
            #expect(Health.destination(ds, waiting: true, schedule: s, now: now) == .ok, "injoignable depuis peu : rien")
            ds.waitingSince = now.addingTimeInterval(-2 * 86_400)
            #expect(Health.destination(ds, waiting: true, schedule: s, now: now) == .attention,
                    "en attente depuis plus d'un jour")
            ds.waitingSince = nil
            ds.lastSuccess = now.addingTimeInterval(-5 * 86_400)
            #expect(Health.destination(ds, waiting: true, schedule: s, now: now) == .attention,
                    "échéance manquée depuis plus d'un jour")
            ds.lastError = "boom"
            #expect(Health.destination(ds, waiting: false, schedule: s, now: now) == .error)
            var damaged = RunState.Destination()
            damaged.damagedVersions = ["v1"]
            #expect(Health.destination(damaged, waiting: false, schedule: s, now: now) == .attention)
        }

        @Test func analysis_staleness() {
            let now = Date()
            #expect(Health.analysisIsStale(nil, now: now))
            #expect(Health.analysisIsStale(now.addingTimeInterval(-8 * 86_400), now: now))
            #expect(!Health.analysisIsStale(now.addingTimeInterval(-6 * 86_400), now: now))
        }

        @Test func main_branch_in_linked_worktree_is_never_proposed() throws {
            #expect(GitMaintenance.isMainBranch("main", main: "refs/remotes/origin/main"))
            #expect(GitMaintenance.isMainBranch("release/x", main: "refs/remotes/upstream/release/x"))
            #expect(GitMaintenance.isMainBranch("master", main: "refs/heads/master"))
            #expect(!GitMaintenance.isMainBranch("main-old", main: "refs/remotes/origin/main"))
            try withTempDir { dir in
                let origin = dir.appendingPathComponent("origin.git"), repo = dir.appendingPathComponent("repo")
                try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
                try run(dir, "init", "-q", "--bare", origin.path)
                try run(repo, "init", "-q")
                try commit(repo, "a.txt", "base")
                try run(repo, "remote", "add", "origin", origin.path)
                try run(repo, "push", "-q", "-u", "origin", "main")
                try run(repo, "remote", "set-head", "origin", "main")
                // Le dépôt principal passe sur une autre branche ; main est extraite dans un worktree lié.
                try run(repo, "checkout", "-q", "-b", "dev")
                let wt = dir.appendingPathComponent("repo-main")
                try run(repo, "worktree", "add", "-q", wt.path, "main")
                let r = GitMaintenance.analyze(repo: repo.path, options: GitOptions())
                #expect(r.mainRef == "refs/remotes/origin/main")
                #expect(!r.branches.contains { $0.name == "main" }, "main jamais proposée : \(r.branches.map(\.name))")
                let w = r.worktrees.first { $0.branch == "main" }
                #expect(w != nil && w?.branchStatus == nil, "pas de statut de fusion pour la principale")
                #expect(GitMaintenance.branchesFollowing(worktrees: Set(r.worktrees.map(\.path)), in: r.branches).isEmpty)
            }
        }
    }
}
