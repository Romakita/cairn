import Foundation
import Darwin

private struct InodeKey: Hashable {
    let dev: Int32
    let ino: UInt64
}

/// État partagé entre les threads d'analyse (progression, liens physiques déjà vus, annulation).
public final class ScanContext: @unchecked Sendable {
    private let lock = NSLock()
    private var _files = 0
    private var _bytes: Int64 = 0
    private var _current = ""
    private var _errors = 0
    private var seen = Set<InodeKey>()
    private var _cancelled = false

    /// Seuil des « gros fichiers » (octets).
    public let bigFileThreshold: Int64

    public init(bigFileThreshold: Int64 = Scanner.bigFileThreshold) { self.bigFileThreshold = bigFileThreshold }
    public var cancelled: Bool { lock.withLock { _cancelled } }
    public func cancel() { lock.withLock { _cancelled = true } }

    public func report(files: Int, bytes: Int64, errors: Int, current: String?) {
        lock.withLock {
            _files += files
            _bytes += bytes
            _errors += errors
            if let current { _current = current }
        }
    }

    public func snapshot() -> (files: Int, bytes: Int64, current: String, errors: Int) {
        lock.withLock { (_files, _bytes, _current, _errors) }
    }

    /// Les fichiers avec plusieurs liens physiques (pnpm…) ne sont comptés qu'une fois.
    public func firstSeen(dev: Int32, ino: UInt64) -> Bool {
        lock.withLock { seen.insert(InodeKey(dev: dev, ino: ino)).inserted }
    }
}

public enum Scanner {
    /// Fichiers listés dans « Gros fichiers ».
    public static let bigFileThreshold: Int64 = 50_000_000
    /// Fichiers affichés individuellement dans l'explorateur.
    public static let listedFileThreshold: Int64 = 10 * 1024 * 1024

    static let alwaysRegenerable: [String: Category] = [
        ".git": .git,
        "node_modules": .deps, ".pnpm-store": .deps, "bower_components": .deps, "jspm_packages": .deps,
        "Pods": .ios, "DerivedData": .ios, "Carthage": .ios,
        "dist": .build, "coverage": .build, ".next": .build, ".nuxt": .build, ".angular": .build,
        ".turbo": .build, ".nx": .build, ".vite": .build, ".parcel-cache": .build, ".svelte-kit": .build,
        ".output": .build, "storybook-static": .build, ".docusaurus": .build, ".expo": .build,
        ".venv": .python, "venv": .python, "__pycache__": .python, ".pytest_cache": .python,
        ".mypy_cache": .python, ".ruff_cache": .python, ".tox": .python,
        ".cache": .cache, ".eslintcache": .cache, ".sass-cache": .cache,
        ".Trashes": .trash, ".Trash": .trash,
    ]

    /// Dossiers génériques qui ne sont considérés comme générés qu'à côté d'un fichier de projet.
    static let conditional: [String: (Category, [String])] = [
        "build": (.build, ["package.json", "build.gradle", "build.gradle.kts", "settings.gradle", "CMakeLists.txt", "pubspec.yaml"]),
        "out": (.build, ["package.json", "tsconfig.json"]),
        "target": (.build, ["Cargo.toml", "pom.xml"]),
        ".gradle": (.build, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"]),
        "vendor": (.deps, ["composer.json", "Gemfile", "go.mod"]),
        ".build": (.build, ["Package.swift"]),
    ]

    public static func classify(name: String, parentPath: String) -> Category {
        if let c = alwaysRegenerable[name] { return c }
        if let (c, markers) = conditional[name] {
            let fm = FileManager.default
            for m in markers where fm.fileExists(atPath: parentPath + "/" + m) { return c }
        }
        return .source
    }

    // MARK: - Analyse complète

    public static func scan(root: String, ctx: ScanContext) -> ScanResult {
        let start = Date()
        let rootNode = Node(name: (root as NSString).lastPathComponent, path: root, isDirectory: true, category: .source)

        struct Job { let path: String; let parent: Node }
        var jobs: [Job] = []
        var levelOne: [Node] = []
        var bigFiles: [BigFile] = []

        // Volume de la racine : comme fts(3) avec FTS_XDEV, on ne franchit pas les points de montage.
        var rootStat = stat()
        let rootDevice: dev_t? = stat(root, &rootStat) == 0 ? rootStat.st_dev : nil

        // Les deux premiers niveaux sont listés ici, puis chaque dossier de niveau 2 est analysé en parallèle.
        func expand(_ node: Node, depth: Int) {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: node.path) else { return }
            for name in names {
                let path = node.path + "/" + name
                var st = stat()
                guard lstat(path, &st) == 0 else { continue }
                if (st.st_mode & S_IFMT) == S_IFDIR {
                    if let rootDevice, isOtherVolume(st, rootDevice: rootDevice) { continue }
                    let cat = classify(name: name, parentPath: node.path)
                    if name == ".git" { node.isGitRepo = true }
                    if depth == 1 && cat == .source {
                        let child = Node(name: name, path: path, isDirectory: true, category: .source)
                        child.parent = node
                        child.ownBytes = Int64(st.st_blocks) * 512
                        node.children.append(child)
                        levelOne.append(child)
                        expand(child, depth: 2)
                    } else {
                        jobs.append(Job(path: path, parent: node))
                    }
                } else {
                    let size = fileSize(st, ctx: ctx)
                    addFile(name: name, path: path, size: size, to: node, category: .source, listed: true, threshold: ctx.bigFileThreshold, big: &bigFiles)
                    ctx.report(files: 1, bytes: size, errors: 0, current: nil)
                }
            }
        }
        expand(rootNode, depth: 1)

        var results = [(Node?, [BigFile])](repeating: (nil, []), count: jobs.count)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: jobs.count) { i in
            let r = scanTree(jobs[i].path, ctx: ctx)
            lock.withLock { results[i] = r }
        }

        for (i, job) in jobs.enumerated() {
            guard let node = results[i].0 else { continue }
            node.parent = job.parent
            job.parent.children.append(node)
            bigFiles += results[i].1
        }
        for n in levelOne { n.finalize() }
        rootNode.finalize()

        bigFiles.sort { $0.size > $1.size }
        return ScanResult(root: rootNode, bigFiles: bigFiles, errors: ctx.snapshot().errors,
                          duration: Date().timeIntervalSince(start))
    }

    /// Dossier situé sur un autre volume que la racine (point de montage) : ignoré par l'analyse.
    public static func isOtherVolume(_ st: stat, rootDevice: dev_t) -> Bool { st.st_dev != rootDevice }

    private static func fileSize(_ st: stat, ctx: ScanContext) -> Int64 {
        if (st.st_mode & S_IFMT) == S_IFREG && st.st_nlink > 1 {
            guard ctx.firstSeen(dev: st.st_dev, ino: st.st_ino) else { return 0 }
        }
        return Int64(st.st_blocks) * 512
    }

    private static func addFile(name: String, path: String, size: Int64, to node: Node, category: Category,
                                listed: Bool, threshold: Int64, big: inout [BigFile]) {
        if listed && size >= listedFileThreshold {
            let f = Node(name: name, path: path, isDirectory: false, category: category)
            f.size = size
            f.fileCount = 1
            f.breakdown[category.rawValue] = size
            f.parent = node
            node.children.append(f)
        } else {
            node.ownBytes += size
            node.ownFileCount += 1
        }
        if size >= threshold { big.append(BigFile(path: path, size: size, category: category)) }
    }

    /// Parcours d'un sous-arbre avec fts(3). Les dossiers classés (node_modules, .git…) sont comptés en bloc.
    private static func scanTree(_ root: String, ctx: ScanContext) -> (Node?, [BigFile]) {
        var big: [BigFile] = []
        let cRoot = strdup(root)
        defer { free(cRoot) }
        var argv: [UnsafeMutablePointer<CChar>?] = [cRoot, nil]
        guard let fts = fts_open(&argv, FTS_PHYSICAL | FTS_NOCHDIR | FTS_XDEV, nil) else { return (nil, []) }
        defer { fts_close(fts) }

        var stack: [Node] = []
        var levels: [Int] = []
        var collapsedLevel = -1
        var collapsedCategory = Category.source
        var result: Node?
        var pendingFiles = 0, pendingBytes: Int64 = 0, pendingErrors = 0

        func flush(_ current: String?) {
            ctx.report(files: pendingFiles, bytes: pendingBytes, errors: pendingErrors, current: current)
            pendingFiles = 0; pendingBytes = 0; pendingErrors = 0
        }

        func pop() {
            let n = stack.removeLast()
            levels.removeLast()
            n.finalize()
            if stack.isEmpty { result = n }
        }

        while let ent = fts_read(fts) {
            let e = ent.pointee
            let level = Int(e.fts_level)
            let info = Int32(e.fts_info)

            switch info {
            case FTS_D:
                let blocks = Int64(e.fts_statp.pointee.st_blocks) * 512
                if collapsedLevel >= 0 {
                    stack[stack.count - 1].ownBytes += blocks
                    pendingBytes += blocks
                    continue
                }
                let path = String(cString: e.fts_path)
                let name = (path as NSString).lastPathComponent
                let parentPath = stack.last?.path ?? (path as NSString).deletingLastPathComponent
                let cat = classify(name: name, parentPath: parentPath)
                let node = Node(name: name, path: path, isDirectory: true, category: cat)
                node.ownBytes = blocks
                pendingBytes += blocks
                if let p = stack.last {
                    node.parent = p
                    p.children.append(node)
                    if name == ".git" { p.isGitRepo = true }
                }
                stack.append(node)
                levels.append(level)
                if cat != .source { collapsedLevel = level; collapsedCategory = cat }
                if pendingFiles > 2000 || level <= 2 {
                    if ctx.cancelled { return (nil, []) }
                    flush(path)
                }

            case FTS_DP, FTS_DNR:
                if info == FTS_DNR { pendingErrors += 1 }
                if collapsedLevel >= 0 && level > collapsedLevel { continue }
                if level == collapsedLevel { collapsedLevel = -1 }
                if let l = levels.last, l == level { pop() }

            case FTS_F, FTS_SL, FTS_SLNONE, FTS_DEFAULT:
                guard let top = stack.last else { continue }
                let st = e.fts_statp.pointee
                let size = fileSize(st, ctx: ctx)
                pendingFiles += 1
                pendingBytes += size
                if collapsedLevel < 0 && size < min(listedFileThreshold, ctx.bigFileThreshold) {
                    top.ownBytes += size
                    top.ownFileCount += 1
                } else {
                    let path = String(cString: e.fts_path)
                    addFile(name: (path as NSString).lastPathComponent, path: path, size: size, to: top,
                            category: collapsedLevel >= 0 ? collapsedCategory : .source,
                            listed: collapsedLevel < 0, threshold: ctx.bigFileThreshold, big: &big)
                }
                if pendingFiles >= 5000 {
                    if ctx.cancelled { return (nil, []) }
                    flush(nil)
                }

            case FTS_ERR, FTS_NS:
                pendingErrors += 1

            default:
                break
            }
        }
        while !stack.isEmpty { pop() }
        flush(nil)
        return (result, big)
    }

    public static func volumeInfo(for path: String) -> VolumeInfo? {
        let url = URL(fileURLWithPath: path)
        guard let v = try? url.resourceValues(forKeys: [
            .volumeNameKey, .volumeTotalCapacityKey, .volumeAvailableCapacityKey,
            .volumeAvailableCapacityForImportantUsageKey,
        ]) else { return nil }
        return VolumeInfo(
            name: v.volumeName ?? path,
            total: Int64(v.volumeTotalCapacity ?? 0),
            available: Int64(v.volumeAvailableCapacity ?? 0),
            availableImportant: v.volumeAvailableCapacityForImportantUsage ?? Int64(v.volumeAvailableCapacity ?? 0)
        )
    }
}
