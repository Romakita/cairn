import Foundation

/// Résultat de l'analyse d'un dossier suivi (`result` vide si le dossier est indisponible).
public struct FolderScan: Sendable {
    public let folder: String
    public let result: ScanResult?
    public var isAvailable: Bool { result != nil }
}

extension ScanResult: @unchecked Sendable {}

extension Scanner {
    /// Analyse chaque dossier suivi ; les liens physiques partagés entre dossiers ne sont comptés qu'une fois.
    public static func scanFolders(_ folders: [String], ctx: ScanContext) -> [FolderScan] {
        folders.map { folder in
            let path = (folder as NSString).expandingTildeInPath
            guard FileManager.default.fileExists(atPath: path), !ctx.cancelled else {
                return FolderScan(folder: path, result: nil)
            }
            let r = scan(root: path, ctx: ctx)
            return FolderScan(folder: path, result: ctx.cancelled ? nil : r)
        }
    }
}

extension Scanner {
    /// Taille totale et part régénérable d'un dossier, sans construire d'arbre (mémoire constante).
    public static func measure(_ root: String) -> (size: Int64, regenerable: Int64) {
        let cRoot = strdup(root)
        defer { free(cRoot) }
        var argv: [UnsafeMutablePointer<CChar>?] = [cRoot, nil]
        guard let fts = fts_open(&argv, FTS_PHYSICAL | FTS_NOCHDIR | FTS_XDEV, nil) else { return (0, 0) }
        defer { fts_close(fts) }
        var size: Int64 = 0, regen: Int64 = 0
        var regenLevel = -1
        var paths: [String] = []
        while let ent = fts_read(fts) {
            let e = ent.pointee
            let level = Int(e.fts_level)
            switch Int32(e.fts_info) {
            case FTS_D:
                let path = String(cString: e.fts_path)
                if regenLevel < 0 {
                    let parent = paths.last ?? (path as NSString).deletingLastPathComponent
                    if classify(name: (path as NSString).lastPathComponent, parentPath: parent).isRegenerable { regenLevel = level }
                }
                paths.append(path)
                let b = Int64(e.fts_statp.pointee.st_blocks) * 512
                size += b
                if regenLevel >= 0 { regen += b }
            case FTS_DP, FTS_DNR:
                if !paths.isEmpty { paths.removeLast() }
                if level == regenLevel { regenLevel = -1 }
            case FTS_F, FTS_SL, FTS_SLNONE, FTS_DEFAULT:
                let b = Int64(e.fts_statp.pointee.st_blocks) * 512
                size += b
                if regenLevel >= 0 { regen += b }
            default: break
            }
        }
        return (size, regen)
    }
}

// MARK: - Présélection du nettoyage

public enum CleanupSuggestion {
    /// Dossiers régénérables proposés quand on arrive d'une alerte : les plus gros (au plus `limit`, chacun d'au
    /// moins `minBytes`). Une simple présélection : rien n'est supprimé sans confirmation.
    public static func preselect(_ nodes: [Node], limit: Int = 10, minBytes: Int64 = 100_000_000) -> [Node] {
        Array(nodes.filter { $0.isDirectory && $0.category.isRegenerable && $0.size >= minBytes }
            .sorted { $0.size > $1.size }
            .prefix(limit))
    }
}

// MARK: - Gros objets

public struct BigObject: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable { case file, folder }
    public let kind: Kind
    public let path: String
    public let size: Int64
    public let category: Category
    public var id: String { path }
    public var name: String { (path as NSString).lastPathComponent }
}

public enum BigObjects {
    /// Gros fichiers, puis gros dossiers : dossiers de plus de `folderThreshold` sans compter les gros fichiers,
    /// au niveau le plus précis (aucun de leurs sous-dossiers n'atteint le seuil à lui seul).
    public static func find(in root: Node, bigFiles: [BigFile], folderThreshold: Int64) -> [BigObject] {
        // Octets de gros fichiers sous chaque dossier.
        var bigUnder: [String: Int64] = [:]
        for f in bigFiles {
            var dir = (f.path as NSString).deletingLastPathComponent
            while dir.count >= root.path.count {
                bigUnder[dir, default: 0] += f.size
                if dir == root.path { break }
                dir = (dir as NSString).deletingLastPathComponent
            }
        }
        var folders: [BigObject] = []
        /// Renvoie vrai si ce dossier ou l'un de ses descendants a été retenu.
        @discardableResult
        func visit(_ n: Node) -> Bool {
            guard n.isDirectory else { return false }
            var descendantListed = false
            for c in n.children where c.isDirectory { if visit(c) { descendantListed = true } }
            let without = n.size - (bigUnder[n.path] ?? 0)
            guard without >= folderThreshold else { return descendantListed }
            if descendantListed { return true }
            if n !== root { folders.append(BigObject(kind: .folder, path: n.path, size: without, category: n.category)) }
            return true
        }
        visit(root)
        let files = bigFiles.map { BigObject(kind: .file, path: $0.path, size: $0.size, category: $0.category) }
        return (files + folders).sorted { $0.size > $1.size }
    }
}

// MARK: - Projets

public struct Worktree: Hashable, Sendable {
    public let path: String
    public let size: Int64
    public let repoPath: String
}

public struct Project: Identifiable, Sendable {
    public let path: String
    public let isGitRepo: Bool
    public let size: Int64
    public let source: Int64
    public let git: Int64
    public let regenerable: Int64
    public let worktrees: [Worktree]

    public var id: String { path }
    public var name: String { (path as NSString).lastPathComponent }
    public var worktreeBytes: Int64 { worktrees.reduce(0) { $0 + $1.size } }
    /// Taille totale, worktrees situés hors du dépôt compris.
    public var totalSize: Int64 {
        size + worktrees.filter { !$0.path.hasPrefix(path + "/") }.reduce(0) { $0 + $1.size }
    }
}

public enum Projects {
    static let markers = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "composer.json", "Package.swift",
                          "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "pubspec.yaml", "requirements.txt"]

    /// Dépôt d'un worktree d'après son fichier `.git` (« gitdir: <dépôt>/.git/worktrees/<nom> »).
    public static func worktreeRepo(_ dir: String) -> String? {
        let gitFile = dir + "/.git"
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: gitFile, isDirectory: &isDir), !isDir.boolValue,
              let text = try? String(contentsOfFile: gitFile, encoding: .utf8),
              let line = text.split(separator: "\n").first(where: { $0.hasPrefix("gitdir:") }) else { return nil }
        var gitdir = line.dropFirst("gitdir:".count).trimmingCharacters(in: .whitespaces)
        if !gitdir.hasPrefix("/") { gitdir = ((dir as NSString).appendingPathComponent(gitdir) as NSString).standardizingPath }
        guard let r = gitdir.range(of: "/.git/worktrees/") else { return nil }
        return String(gitdir[..<r.lowerBound])
    }

    /// Projets (dépôts git ou dossiers avec un fichier de projet) triés par taille, avec leurs worktrees rattachés.
    public static func find(in root: Node, maxDepth: Int = 5) -> [Project] {
        // 1. Worktrees, y compris ceux créés à l'intérieur d'un dépôt (.claude/worktrees/…).
        var worktrees: [String: [Worktree]] = [:]
        var worktreePaths = Set<String>()
        func findWorktrees(_ n: Node, depth: Int) {
            guard n.isDirectory, n.category == .source, depth <= maxDepth + 3 else { return }
            if n !== root, let repo = worktreeRepo(n.path) {
                worktrees[repo, default: []].append(Worktree(path: n.path, size: n.size, repoPath: repo))
                worktreePaths.insert(n.path)
                return
            }
            for c in n.children { findWorktrees(c, depth: depth + 1) }
        }
        findWorktrees(root, depth: 0)

        // 2. Projets : on ne descend pas dans un projet trouvé.
        var projects: [Project] = []
        func visit(_ n: Node, depth: Int) {
            guard n.isDirectory, n.category == .source, depth <= maxDepth, !worktreePaths.contains(n.path) else { return }
            let isProject = n.isGitRepo || markers.contains { FileManager.default.fileExists(atPath: n.path + "/" + $0) }
            if isProject && n !== root {
                projects.append(Project(path: n.path, isGitRepo: n.isGitRepo, size: n.size, source: n.bytes(.source),
                                        git: n.bytes(.git), regenerable: n.regenerableBytes,
                                        worktrees: worktrees[n.path] ?? []))
                return
            }
            for c in n.children { visit(c, depth: depth + 1) }
        }
        visit(root, depth: 0)
        return projects.sorted { $0.totalSize > $1.totalSize }
    }
}
