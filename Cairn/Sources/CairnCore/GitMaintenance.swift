import Foundation

// Portage de scripts/git-cleanup.sh : branches « gone » (fusionnées, squashées, non fusionnées), gc, prune,
// journal des SHA supprimés — plus l'inventaire et le nettoyage des worktrees. Simulation par défaut.

/// Exécution de git sans interaction (pas d'invite de mot de passe, ssh en mode batch).
public struct Git: Sendable {
    public let repo: String

    public init(_ repo: String) { self.repo = repo }

    @discardableResult
    public func run(_ args: [String], stdin: String? = nil) -> (status: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", repo] + args
        var env = ProcessInfo.processInfo.environment
        env["LC_ALL"] = "C"
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GIT_SSH_COMMAND"] = env["GIT_SSH_COMMAND"] ?? "ssh -o BatchMode=yes -o ConnectTimeout=10"
        p.environment = env
        let outPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        let inPipe = Pipe()
        if stdin != nil { p.standardInput = inPipe }
        do { try p.run() } catch { return (127, "") }
        if let stdin {
            // Écriture sur un autre fil : sinon, avec une grosse entrée, git remplit sa sortie pendant qu'on écrit
            // encore son entrée et les deux processus s'attendent mutuellement.
            let writer = inPipe.fileHandleForWriting
            DispatchQueue.global(qos: .userInitiated).async {
                writer.write(Data(stdin.utf8))
                try? writer.close()
            }
        }
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    /// `git <first> | git <second>` sans passer par la mémoire de Cairn (diffs et historiques peuvent peser des Go).
    public func pipe(_ first: [String], into second: [String]) -> String {
        func make(_ args: [String]) -> Process {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = ["-C", repo] + args
            var env = ProcessInfo.processInfo.environment
            env["LC_ALL"] = "C"
            env["GIT_TERMINAL_PROMPT"] = "0"
            p.environment = env
            p.standardError = FileHandle.nullDevice
            return p
        }
        let a = make(first), b = make(second)
        let link = Pipe(), out = Pipe()
        a.standardOutput = link
        b.standardInput = link
        b.standardOutput = out
        do { try a.run(); try b.run() } catch { return "" }
        // Le côté écriture du tuyau ne doit rester ouvert que chez git, sinon patch-id n'atteint jamais la fin.
        try? link.fileHandleForWriting.close()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        a.waitUntilExit()
        b.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    public func ok(_ args: [String]) -> Bool { run(args).status == 0 }
    public func line(_ args: [String]) -> String? {
        let r = run(args)
        let s = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
        return r.status == 0 && !s.isEmpty ? s : nil
    }
}

public struct GoneBranch: Identifiable, Hashable, Sendable, Codable {
    public enum Status: String, Sendable, CaseIterable, Codable { case merged, squash, unmerged }
    public let repo: String
    public let name: String
    public let status: Status
    public let sha: String
    public let date: String
    public let subject: String
    /// Extraite dans un worktree conservé : non proposée.
    public let checkedOutInWorktree: String?
    public var id: String { repo + "#" + name }
}

public struct WorktreeInfo: Identifiable, Hashable, Sendable, Codable {
    public enum Status: String, Sendable, Codable { case orphan, merged, stale, risk, active }
    public let repo: String
    public let path: String
    public let branch: String?
    public let head: String
    public let exists: Bool
    public let size: Int64
    public let regenerable: Int64
    public let lastModified: Date?
    public let modifiedFiles: Int
    public let untrackedFiles: Int
    public let unpushedCommits: Int
    public let status: Status
    /// Raison du statut « obsolète » quand le worktree est aussi « à risque ».
    public let staleReason: Status?
    public var id: String { path }
    public var isAtRisk: Bool { modifiedFiles > 0 || untrackedFiles > 0 || unpushedCommits > 0 }
    public var isObsolete: Bool { status == .orphan || status == .merged || status == .stale || staleReason != nil }
}

public struct RepoReport: Identifiable, Sendable, Codable {
    public let path: String
    public let gitBytes: Int64
    public let looseBytes: Int64
    public let mainRef: String?
    public let branches: [GoneBranch]
    public let worktrees: [WorktreeInfo]
    /// Espace libéré estimé par la suppression des branches proposées.
    public let reclaimableBytes: Int64
    public var id: String { path }
}

public struct GitOptions: Sendable, Codable {
    public var fetch = false
    public var includeUnmerged = false
    public var pruneNow = false
    public var gc = true
    public var staleDays = 30
    public var only: String?
    public var worktreesOnly = false
    public var includeAtRisk = false
    public init() {}
}

public enum GitMaintenance {
    static let pruned: Set<String> = ["node_modules", ".pnpm-store", ".Trashes", ".Spotlight-V100", ".fseventsd",
                                      ".DocumentRevisions-V100", ".TemporaryItems", "Pods", "DerivedData", ".venv"]

    // MARK: Découverte

    /// Dépôts (dossiers contenant un dossier `.git`), sans descendre dans les dossiers régénérables.
    public static func discover(in folders: [String]) -> [String] {
        var repos: [String] = []
        let fm = FileManager.default
        for folder in folders {
            let root = URL(fileURLWithPath: (folder as NSString).expandingTildeInPath)
            guard let e = fm.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                                        options: [], errorHandler: { _, _ in true }) else { continue }
            // autoreleasepool : sans lui, les millions d'URL du parcours restent en mémoire jusqu'à la fin du fil.
            while let url = autoreleasepool(invoking: { e.nextObject() as? URL }) {
                autoreleasepool {
                    let name = url.lastPathComponent
                    let v = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    guard v?.isDirectory == true, v?.isSymbolicLink != true else { return }
                    if pruned.contains(name) { e.skipDescendants(); return }
                    if name == ".git" {
                        repos.append(url.deletingLastPathComponent().path)
                        e.skipDescendants()
                    }
                }
            }
        }
        return Array(Set(repos)).sorted()
    }

    /// Branche principale : origin/HEAD, sinon main/master/develop (distante puis locale).
    public static func mainRef(_ git: Git) -> String? {
        if let r = git.line(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]) { return r }
        for b in ["main", "master", "develop"] where git.ok(["show-ref", "-q", "--verify", "refs/remotes/origin/\(b)"]) {
            return "refs/remotes/origin/\(b)"
        }
        for b in ["main", "master", "develop"] where git.ok(["show-ref", "-q", "--verify", "refs/heads/\(b)"]) {
            return "refs/heads/\(b)"
        }
        return nil
    }

    /// Fusionnée (ancêtre), squashée (même patch-id qu'un commit de la branche principale) ou non fusionnée.
    public static func mergeStatus(_ git: Git, ref: String, main: String?) -> GoneBranch.Status {
        guard let main else { return .unmerged }
        if git.ok(["merge-base", "--is-ancestor", ref, main]) { return .merged }
        guard let base = git.line(["merge-base", ref, main]) else { return .unmerged }
        // Empreinte du diff complet de la branche ; un commit de la principale avec la même → squash merge.
        // Les diffs passent de git à git par un tuyau : rien n'est chargé en mémoire.
        guard let pid = git.pipe(["diff", base, ref], into: ["patch-id", "--stable"])
            .split(separator: " ").first.map(String.init) else {
            return .merged // la branche n'apporte aucun changement
        }
        let ids = git.pipe(["log", "-p", "--no-merges", "--format=commit %H", "\(base)..\(main)"], into: ["patch-id", "--stable"])
        return ids.split(separator: "\n").contains { $0.hasPrefix(pid + " ") } ? .squash : .unmerged
    }

    // MARK: Worktrees

    struct RawWorktree { var path = ""; var head = ""; var branch: String?; var prunable = false; var bare = false }

    static func parseWorktrees(_ text: String) -> [RawWorktree] {
        var list: [RawWorktree] = []
        var cur: RawWorktree?
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("worktree ") {
                if let c = cur { list.append(c) }
                cur = RawWorktree(path: String(line.dropFirst("worktree ".count)))
            } else if line.hasPrefix("HEAD ") { cur?.head = String(line.dropFirst(5)) }
            else if line.hasPrefix("branch refs/heads/") { cur?.branch = String(line.dropFirst("branch refs/heads/".count)) }
            else if line.hasPrefix("prunable") { cur?.prunable = true }
            else if line == "bare" { cur?.bare = true }
        }
        if let c = cur { list.append(c) }
        return list
    }

    /// Fichier le plus récemment modifié, hors dossiers régénérables et `.git`.
    static func lastModified(_ path: String, limit: Int = 200_000) -> Date? {
        let root = URL(fileURLWithPath: path)
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey],
                                                     options: [], errorHandler: { _, _ in true }) else { return nil }
        var newest: Date?
        var count = 0
        while let url = autoreleasepool(invoking: { e.nextObject() as? URL }) {
            count += 1
            if count > limit { break }
            autoreleasepool {
                let v = try? url.resourceValues(forKeys: [.contentModificationDateKey, .isDirectoryKey])
                if v?.isDirectory == true {
                    let name = url.lastPathComponent
                    if name == ".git" || Scanner.classify(name: name, parentPath: url.deletingLastPathComponent().path) != .source {
                        e.skipDescendants()
                    }
                    return
                }
                if let d = v?.contentModificationDate, newest == nil || d > newest! { newest = d }
            }
        }
        return newest
    }

    static func worktrees(_ git: Git, main: String?, goneBranches: Set<String>, staleDays: Int, now: Date) -> [WorktreeInfo] {
        let raw = parseWorktrees(git.run(["worktree", "list", "--porcelain"]).out)
        // Le premier est le dépôt principal lui-même.
        return raw.dropFirst().filter { !$0.bare }.map { w in
            let exists = FileManager.default.fileExists(atPath: w.path)
            var size: Int64 = 0, regen: Int64 = 0, modified = 0, untracked = 0, unpushed = 0
            var last: Date?
            // Une branche fusionnée ou squashée dans la principale n'a pas de travail « non poussé » à perdre.
            let integrated: Bool = {
                guard let b = w.branch, "refs/heads/\(b)" != main else { return false }
                return mergeStatus(git, ref: "refs/heads/\(b)", main: main) != .unmerged
            }()
            if exists {
                (size, regen) = Scanner.measure(w.path) // sans arbre en mémoire
                let wt = Git(w.path)
                for l in wt.run(["status", "--porcelain"]).out.split(separator: "\n") {
                    if l.hasPrefix("??") { untracked += 1 } else { modified += 1 }
                }
                unpushed = integrated ? 0 : Int(wt.line(["rev-list", "--count", "HEAD", "--not", "--remotes"]) ?? "0") ?? 0
                last = lastModified(w.path)
            }
            var staleReason: WorktreeInfo.Status?
            if !exists || w.prunable { staleReason = .orphan }
            else if integrated { staleReason = .merged }
            else if let last, now.timeIntervalSince(last) > Double(staleDays) * 86_400 { staleReason = .stale }
            let atRisk = modified > 0 || untracked > 0 || unpushed > 0
            let status: WorktreeInfo.Status = (atRisk && exists) ? .risk : (staleReason ?? .active)
            return WorktreeInfo(repo: git.repo, path: w.path, branch: w.branch, head: w.head, exists: exists && !w.prunable,
                                size: size, regenerable: regen, lastModified: last, modifiedFiles: modified,
                                untrackedFiles: untracked, unpushedCommits: unpushed, status: status,
                                staleReason: status == .risk ? staleReason : nil)
        }
    }

    // MARK: Analyse (lecture seule)

    public static func analyze(repo: String, options: GitOptions, now: Date = Date()) -> RepoReport {
        let git = Git(repo)
        if options.fetch, !(git.line(["remote"]) ?? "").isEmpty {
            git.run(["fetch", "--all", "--prune", "--quiet"])
        }
        var loose: Int64 = 0, pack: Int64 = 0
        for l in git.run(["count-objects", "-v"]).out.split(separator: "\n") {
            let p = l.split(separator: ":").map { $0.trimmingCharacters(in: .whitespaces) }
            guard p.count == 2, let v = Int64(p[1]) else { continue }
            if p[0] == "size" { loose = v * 1024 } else if p[0] == "size-pack" { pack = v * 1024 }
        }
        let main = mainRef(git)
        let current = git.line(["symbolic-ref", "-q", "--short", "HEAD"])
        let worktreeList = parseWorktrees(git.run(["worktree", "list", "--porcelain"]).out)
        let checkedOut = Dictionary(worktreeList.dropFirst().compactMap { w in w.branch.map { ($0, w.path) } },
                                    uniquingKeysWith: { a, _ in a })

        var branches: [GoneBranch] = []
        let fmt = "%(refname:short)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:short)%1f%(subject)"
        for l in git.run(["for-each-ref", "refs/heads", "--format=\(fmt)"]).out.split(separator: "\n") {
            let f = l.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(String.init)
            guard f.count >= 5, f[1].contains("gone") else { continue }
            let name = f[0]
            if name == current || "refs/heads/\(name)" == main { continue } // jamais la branche courante ni la principale
            branches.append(GoneBranch(repo: repo, name: name, status: mergeStatus(git, ref: "refs/heads/\(name)", main: main),
                                       sha: f[2], date: f[3], subject: f[4...].joined(separator: " "),
                                       checkedOutInWorktree: checkedOut[name]))
        }
        let wts = worktrees(git, main: main, goneBranches: Set(branches.map(\.name)), staleDays: options.staleDays, now: now)
        let toDelete = branches.filter { selectedByDefault($0, options: options) }
        return RepoReport(path: repo, gitBytes: loose + pack, looseBytes: loose, mainRef: main, branches: branches,
                          worktrees: wts, reclaimableBytes: estimate(git, deleting: toDelete.map(\.name)))
    }

    /// Proposée par défaut : fusionnée/squashée, non extraite dans un worktree (non fusionnée seulement si demandé).
    public static func selectedByDefault(_ b: GoneBranch, options: GitOptions) -> Bool {
        b.checkedOutInWorktree == nil && (b.status != .unmerged || options.includeUnmerged)
    }

    /// Présélection d'un worktree : obsolète et sans travail en cours (ou « à risque » si explicitement demandé).
    public static func selectedByDefault(_ w: WorktreeInfo, options: GitOptions) -> Bool {
        w.isObsolete && (!w.isAtRisk || options.includeAtRisk)
    }

    /// Octets des objets accessibles uniquement par les branches supprimées.
    static func estimate(_ git: Git, deleting names: [String]) -> Int64 {
        guard !names.isEmpty else { return 0 }
        let del = Set(names.map { "refs/heads/\($0)" })
        let others = git.run(["for-each-ref", "--format=%(refname)"]).out.split(separator: "\n").map(String.init).filter { !del.contains($0) }
        let input = (del.sorted() + others.map { "^" + $0 }).joined(separator: "\n") + "\n"
        return Int64(git.run(["rev-list", "--stdin", "--objects", "--disk-usage"], stdin: input).out
            .trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }

    /// Exécutable des workers (le binaire Cairn lui-même) ; nil = analyse dans le processus (tests).
    nonisolated(unsafe) public static var workerExecutable: String?

    /// Avancement des workers, pour l'interface et la ligne de commande.
    public struct PoolProgress: Sendable {
        public var done: Int
        public var total: Int
        public var running: [String: Int64]   // dépôt → mémoire du worker (octets)
        public var failed: [String: String]
    }

    /// Analyse tous les dépôts. Avec `workerExecutable`, chaque dépôt est analysé dans un processus séparé
    /// (au plus `parallel` à la fois) : la mémoire est rendue à la fin de chaque worker, et le pool surveille
    /// la durée et la mémoire de chacun (arrêt au-delà des limites).
    public static func analyzeAll(folders: [String], options: GitOptions, parallel: Int = 4,
                                  timeout: TimeInterval = 300, memoryLimit: Int64 = 1_500_000_000,
                                  progress: @escaping (PoolProgress) -> Void = { _ in }) -> [RepoReport] {
        var repos = discover(in: folders)
        if let only = options.only { repos = repos.filter { $0.contains(only) } }
        guard let exe = workerExecutable else {
            return repos.map { analyze(repo: $0, options: options) }
        }
        let pool = GitWorkerPool(executable: exe, options: options, parallel: parallel, timeout: timeout, memoryLimit: memoryLimit)
        return pool.run(repos, progress: progress)
    }

    // MARK: Application

    public struct ApplyResult: Sendable {
        public var deletedBranches: [String] = []
        public var removedWorktrees: [String] = []
        public var failures: [String] = []
    }

    static func logDeletion(_ git: Git, _ fields: [String]) {
        guard let gitDir = git.line(["rev-parse", "--absolute-git-dir"]) else { return }
        let url = URL(fileURLWithPath: gitDir).appendingPathComponent("cleanup-deleted-branches.log")
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let line = ([f.string(from: Date())] + fields).joined(separator: "\t") + "\n"
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close()
        } else {
            try? line.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    /// Supprime les worktrees puis les branches choisis ; le journal est écrit avant chaque suppression.
    public static func apply(repo: String, branches: [String], worktrees: [WorktreeInfo], options: GitOptions) -> ApplyResult {
        let git = Git(repo)
        var result = ApplyResult()
        for w in worktrees {
            let sha = w.head
            logDeletion(git, ["worktree", w.path, w.branch ?? "-", sha])
            if w.exists {
                let args = ["worktree", "remove"] + (w.isAtRisk ? ["--force", "--force"] : []) + [w.path]
                if git.ok(args) { result.removedWorktrees.append(w.path) } else { result.failures.append(w.path) }
            } else {
                result.removedWorktrees.append(w.path)
            }
        }
        git.run(["worktree", "prune"])
        for b in branches {
            guard let sha = git.line(["rev-parse", "refs/heads/\(b)"]) else { continue }
            logDeletion(git, [b, sha])
            if git.ok(["branch", "-D", b]) { result.deletedBranches.append(b) } else { result.failures.append(b) }
        }
        if options.pruneNow {
            git.run(["reflog", "expire", "--expire-unreachable=now", "--all"])
            if options.gc { git.run(["gc", "--quiet", "--prune=now"]) }
        } else if options.gc {
            git.run(["gc", "--quiet"])
        }
        return result
    }

    // MARK: Rapport

    /// Rapport TSV : une ligne par branche « gone » (colonnes de git-cleanup.sh).
    public static func tsv(_ reports: [RepoReport], root: String) -> String {
        var out = "repo\tbranche\tstatut\tsha\tdernier_commit\tsujet\n"
        for r in reports {
            let rel = r.path.hasPrefix(root + "/") ? String(r.path.dropFirst(root.count + 1)) : r.path
            for b in r.branches {
                out += [rel, b.name, b.status.rawValue, b.sha, b.date, b.subject].joined(separator: "\t") + "\n"
            }
        }
        return out
    }
}
