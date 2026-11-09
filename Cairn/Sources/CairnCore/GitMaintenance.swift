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
            WaitedWork.async(qos: .userInitiated) {
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
    /// Fusion de sa branche dans la principale (nil sans branche, ou si c'est la principale).
    public let branchStatus: GoneBranch.Status?
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

extension GitOptions {
    /// Options d'une analyse lancée depuis l'app : réglages de `[git]` appliqués à celles de l'écran Git. Pour la
    /// vérification complète de l'accueil (`fullCheck`), tous les dépôts sans filtre et jamais de `git fetch`, qui
    /// modifie le dépôt (`--prune` supprime des références distantes) : la vérification reste en lecture seule.
    public func forAnalysis(config: CairnConfig?, fullCheck: Bool) -> GitOptions {
        var o = self
        o.staleDays = config?.git.worktreeStaleDays ?? 30
        o.fetch = fullCheck ? false : (config?.git.fetchBefore ?? false)
        if fullCheck { o.only = nil }
        return o
    }
}

public enum GitMaintenance {
    /// Dossiers système de volume, en plus des dossiers classés par le Scanner (régénérables, corbeille).
    static let systemFolders: Set<String> = [".Spotlight-V100", ".fseventsd", ".DocumentRevisions-V100", ".TemporaryItems"]

    /// Dossier où l'on ne cherche pas de dépôt : même classification que l'analyse (node_modules, build à côté
    /// d'un package.json, corbeille…), plus les dossiers système.
    static func skipsDiscovery(name: String, parentPath: String) -> Bool {
        systemFolders.contains(name) || Scanner.classify(name: name, parentPath: parentPath) != .source
    }

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
                    if name == ".git" {
                        repos.append(url.deletingLastPathComponent().path)
                        e.skipDescendants()
                    } else if skipsDiscovery(name: name, parentPath: url.deletingLastPathComponent().path) {
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

    /// Nom court de la branche principale : `refs/remotes/origin/main` et `refs/heads/main` donnent tous deux `main`.
    /// La branche locale de ce nom est protégée, même extraite dans un worktree lié.
    public static func isMainBranch(_ name: String, main: String?) -> Bool {
        guard let main else { return false }
        let short: String
        if main.hasPrefix("refs/heads/") { short = String(main.dropFirst("refs/heads/".count)) }
        else if main.hasPrefix("refs/remotes/") { short = main.split(separator: "/").dropFirst(3).joined(separator: "/") }
        else { short = main }
        return name == short
    }

    /// Fusionnée (ancêtre), squashée (même patch-id qu'un commit de la branche principale) ou non fusionnée.
    public static func mergeStatus(_ git: Git, ref: String, main: String?) -> GoneBranch.Status {
        guard let main else { return .unmerged }
        if git.ok(["merge-base", "--is-ancestor", ref, main]) { return .merged }
        guard let base = git.line(["merge-base", ref, main]) else { return .unmerged }
        // Branche sans aucun changement : seul `diff --quiet` (code 0) le prouve. Un échec de git (code ≠ 0 et ≠ 1)
        // ne doit jamais faire passer la branche pour fusionnée.
        switch git.run(["diff", "--quiet", base, ref]).status {
        case 0: return .merged
        case 1: break
        default: return .unmerged
        }
        // Empreinte du diff complet de la branche ; un commit de la principale avec la même → squash merge.
        // Les diffs passent de git à git par un tuyau : rien n'est chargé en mémoire.
        guard let pid = git.pipe(["diff", base, ref], into: ["patch-id", "--stable"])
            .split(separator: " ").first.map(String.init) else {
            return .unmerged // empreinte illisible : prudence
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
            let branchStatus: GoneBranch.Status? = {
                guard let b = w.branch, !isMainBranch(b, main: main) else { return nil }
                return mergeStatus(git, ref: "refs/heads/\(b)", main: main)
            }()
            let integrated = branchStatus.map { $0 != .unmerged } ?? false
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
                                staleReason: status == .risk ? staleReason : nil, branchStatus: branchStatus)
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
            if name == current || isMainBranch(name, main: main) { continue } // jamais la branche courante ni la principale
            branches.append(GoneBranch(repo: repo, name: name, status: mergeStatus(git, ref: "refs/heads/\(name)", main: main),
                                       sha: f[2], date: f[3], subject: f[4...].joined(separator: " "),
                                       checkedOutInWorktree: checkedOut[name]))
        }
        let wts = worktrees(git, main: main, goneBranches: Set(branches.map(\.name)), staleDays: options.staleDays, now: now)
        // Branche fusionnée ou squashée d'un worktree, même si son amont existe encore : proposée avec le worktree.
        let known = Set(branches.map(\.name))
        for w in wts {
            guard let name = w.branch, let st = w.branchStatus, st != .unmerged, !known.contains(name), name != current,
                  !isMainBranch(name, main: main),
                  let l = git.line(["for-each-ref", "refs/heads/\(name)", "--format=\(fmt)"]) else { continue }
            let f = l.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(String.init)
            guard f.count >= 5 else { continue }
            branches.append(GoneBranch(repo: repo, name: name, status: st, sha: f[2], date: f[3],
                                       subject: f[4...].joined(separator: " "), checkedOutInWorktree: w.path))
        }
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

    /// Branches à supprimer avec les worktrees choisis : fusionnées ou squashées, extraites dans l'un d'eux.
    public static func branchesFollowing(worktrees paths: Set<String>, in branches: [GoneBranch]) -> [GoneBranch] {
        branches.filter { b in b.status != .unmerged && b.checkedOutInWorktree.map(paths.contains) == true }
    }

    /// Présélection (branches, worktrees) : branches fusionnées/squashées, worktrees obsolètes sans travail en cours,
    /// et la branche fusionnée de chaque worktree présélectionné. Par dépôt : on peut la calculer au fil de l'analyse.
    public static func preselection(_ reports: [RepoReport], options: GitOptions) -> (branches: Set<String>, worktrees: Set<String>) {
        let worktrees = Set(reports.flatMap(\.worktrees).filter { selectedByDefault($0, options: options) }.map(\.id))
        let all = reports.flatMap(\.branches)
        let branches = Set(all.filter { selectedByDefault($0, options: options) }.map(\.id))
            .union(branchesFollowing(worktrees: worktrees, in: all).map(\.id))
        return (branches, worktrees)
    }

    /// Récapitulatif d'une sélection : taille des `.git`, branches supprimées / gardées, worktrees retirés / gardés.
    public struct Recap: Equatable, Sendable {
        public var gitBytes: Int64 = 0
        public var deletedBranches = 0
        public var keptBranches = 0
        public var removedWorktrees = 0
        public var keptWorktrees = 0
    }

    public static func recap(_ reports: [RepoReport], branches: Set<String>, worktrees: Set<String>) -> Recap {
        var r = Recap()
        for rep in reports {
            r.gitBytes += rep.gitBytes
            let del = rep.branches.filter { branches.contains($0.id) }.count
            r.deletedBranches += del
            r.keptBranches += rep.branches.count - del
            let rm = rep.worktrees.filter { worktrees.contains($0.id) }.count
            r.removedWorktrees += rm
            r.keptWorktrees += rep.worktrees.count - rm
        }
        return r
    }

    /// Octets des objets accessibles uniquement par les branches supprimées.
    public static func estimate(_ git: Git, deleting names: [String]) -> Int64 {
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

    /// Analyse tous les dépôts. Avec `executable` (par défaut `workerExecutable`), chaque dépôt est analysé dans un processus séparé
    /// (au plus `parallel` à la fois) : la mémoire est rendue à la fin de chaque worker, et le pool surveille
    /// la durée et la mémoire de chacun (arrêt au-delà des limites). `cancel` arrête l'analyse (lecture seule) :
    /// plus aucun worker n'est lancé et ceux en cours sont arrêtés.
    public static func analyzeAll(folders: [String], options: GitOptions, parallel: Int = 4,
                                  timeout: TimeInterval = 300, memoryLimit: Int64 = 1_500_000_000,
                                  cancel: CancelToken? = nil, executable: String? = workerExecutable,
                                  progress: @escaping (PoolProgress) -> Void = { _ in },
                                  onReport: @escaping (RepoReport) -> Void = { _ in }) -> [RepoReport] {
        var repos = discover(in: folders)
        if let only = options.only { repos = repos.filter { $0.contains(only) } }
        guard let exe = executable else {
            var reports: [RepoReport] = []
            for (i, repo) in repos.enumerated() where cancel?.isCancelled != true {
                progress(.init(done: i, total: repos.count, running: [repo: 0], failed: [:]))
                let report = analyze(repo: repo, options: options)
                reports.append(report)
                onReport(report)
            }
            progress(.init(done: reports.count, total: repos.count, running: [:], failed: [:]))
            return reports
        }
        let pool = GitWorkerPool(executable: exe, options: options, parallel: parallel, timeout: timeout, memoryLimit: memoryLimit)
        return pool.run(repos, cancel: cancel, progress: progress, onReport: onReport)
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
    /// `expectedSHAs` (branche → SHA vu à l'analyse, court ou complet) : une branche qui a bougé depuis n'est pas
    /// supprimée (nouveaux commits) et compte comme un échec.
    public static func apply(repo: String, branches: [String], worktrees: [WorktreeInfo], options: GitOptions,
                             expectedSHAs: [String: String] = [:]) -> ApplyResult {
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
            if let expected = expectedSHAs[b], !expected.isEmpty, !sha.hasPrefix(expected) {
                result.failures.append(b); continue
            }
            logDeletion(git, [b, sha])
            if git.ok(["branch", "-D", b]) { result.deletedBranches.append(b) } else { result.failures.append(b) }
        }
        if options.pruneNow {
            git.run(["reflog", "expire", "--expire-unreachable=now", "--all"])
            // Sans gc, les objets devenus inaccessibles resteraient sur le disque : on les élague quand même.
            if options.gc { git.run(["gc", "--quiet", "--prune=now"]) } else { git.run(["prune", "--expire=now"]) }
        } else if options.gc {
            git.run(["gc", "--quiet"])
        }
        return result
    }

    // MARK: Rapport

    /// Rapport TSV : une ligne par branche proposée (« gone », ou fusionnée d'un worktree ; colonnes de git-cleanup.sh).
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
