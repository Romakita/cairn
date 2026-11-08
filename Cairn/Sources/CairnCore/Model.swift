import Foundation

/// Type de contenu d'un dossier. Tout ce qui n'est pas `source` est compté en bloc (on ne descend pas dedans dans l'arbre).
public enum Category: Int, CaseIterable, Identifiable, Hashable, Sendable {
    case source, git, deps, build, ios, python, cache, trash

    public var id: Int { rawValue }

    /// Identifiant stable, utilisé dans les sorties JSON et les clés de traduction.
    public var key: String {
        switch self {
        case .source: "source"
        case .git: "git"
        case .deps: "deps"
        case .build: "build"
        case .ios: "ios"
        case .python: "python"
        case .cache: "cache"
        case .trash: "trash"
        }
    }

    public var label: String { L10n.tr("category.\(key).label") }
    public var shortLabel: String { L10n.tr("category.\(key).short") }

    /// Nom de symbole SF Symbols.
    public var icon: String {
        switch self {
        case .source: "folder"
        case .git: "arrow.triangle.branch"
        case .deps: "shippingbox"
        case .build: "hammer"
        case .ios: "iphone"
        case .python: "chevron.left.forwardslash.chevron.right"
        case .cache: "tray.full"
        case .trash: "trash"
        }
    }

    /// Peut être supprimé puis recréé (npm install, build, pod install…).
    public var isRegenerable: Bool {
        switch self {
        case .deps, .build, .ios, .python, .cache: true
        default: false
        }
    }
}

public final class Node: Identifiable, Hashable, @unchecked Sendable {
    public let name: String
    public let path: String
    public let isDirectory: Bool
    public let category: Category
    /// Octets des fichiers directement dedans qui ne sont pas listés comme enfants.
    public var ownBytes: Int64 = 0
    public var ownFileCount: Int = 0
    public var size: Int64 = 0
    public var fileCount: Int = 0
    public var breakdown = [Int64](repeating: 0, count: Category.allCases.count)
    public var children: [Node] = []
    public weak var parent: Node?
    public var isGitRepo = false

    public var id: String { path }

    public init(name: String, path: String, isDirectory: Bool, category: Category) {
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
        self.category = category
    }

    public static func == (a: Node, b: Node) -> Bool { a === b }
    public func hash(into h: inout Hasher) { h.combine(ObjectIdentifier(self)) }

    public var regenerableBytes: Int64 {
        Category.allCases.filter(\.isRegenerable).reduce(0) { $0 + breakdown[$1.rawValue] }
    }

    public func bytes(_ c: Category) -> Int64 { breakdown[c.rawValue] }

    /// Recalcule taille et répartition à partir des enfants et des fichiers propres.
    public func finalize() {
        var b = [Int64](repeating: 0, count: breakdown.count)
        b[category.rawValue] = ownBytes
        var s = ownBytes
        var fc = ownFileCount
        for c in children {
            s += c.size
            fc += c.fileCount
            for i in b.indices { b[i] += c.breakdown[i] }
        }
        size = s
        fileCount = fc
        breakdown = b
        children.sort { $0.size > $1.size }
    }

    /// Retire ce nœud de l'arbre et met à jour les totaux des parents.
    public func detach() {
        guard let p = parent else { return }
        p.children.removeAll { $0 === self }
        var a: Node? = p
        while let n = a {
            n.size -= size
            n.fileCount -= fileCount
            for i in n.breakdown.indices { n.breakdown[i] -= breakdown[i] }
            n.children.sort { $0.size > $1.size }
            a = n.parent
        }
        parent = nil
    }

    public func relativePath(to root: Node) -> String {
        if path == root.path { return "/" }
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
    }

    public func walk(_ body: (Node) -> Void) {
        body(self)
        for c in children { c.walk(body) }
    }
}

public struct BigFile: Identifiable, Hashable, Sendable {
    public let path: String
    public let size: Int64
    public let category: Category
    public var id: String { path }
    public var name: String { (path as NSString).lastPathComponent }

    public init(path: String, size: Int64, category: Category) {
        self.path = path
        self.size = size
        self.category = category
    }
}

public struct ScanResult {
    public let root: Node
    public var bigFiles: [BigFile]
    public let errors: Int
    public let duration: TimeInterval
}

public struct VolumeInfo: Sendable {
    public let name: String
    public let total: Int64
    public let available: Int64
    public let availableImportant: Int64
}
