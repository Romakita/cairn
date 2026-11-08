import SwiftUI

/// Type de contenu d'un dossier. Tout ce qui n'est pas `source` est compté en bloc (on ne descend pas dedans dans l'arbre).
enum Category: Int, CaseIterable, Identifiable, Hashable {
    case source, git, deps, build, ios, python, cache, trash

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .source: "Sources & fichiers"
        case .git: "Historique git"
        case .deps: "Dépendances (node_modules…)"
        case .build: "Builds & caches de build"
        case .ios: "iOS / Xcode (Pods, DerivedData)"
        case .python: "Python (.venv, __pycache__…)"
        case .cache: "Caches (.cache…)"
        case .trash: "Corbeille du volume"
        }
    }

    var shortLabel: String {
        switch self {
        case .source: "Sources"
        case .git: ".git"
        case .deps: "Dépendances"
        case .build: "Build"
        case .ios: "iOS"
        case .python: "Python"
        case .cache: "Cache"
        case .trash: "Corbeille"
        }
    }

    var color: Color {
        switch self {
        case .source: Color(red: 0.36, green: 0.55, blue: 0.93)
        case .git: Color(red: 0.94, green: 0.45, blue: 0.24)
        case .deps: Color(red: 0.86, green: 0.25, blue: 0.42)
        case .build: Color(red: 0.95, green: 0.72, blue: 0.20)
        case .ios: Color(red: 0.55, green: 0.40, blue: 0.86)
        case .python: Color(red: 0.20, green: 0.70, blue: 0.55)
        case .cache: Color(red: 0.55, green: 0.62, blue: 0.68)
        case .trash: Color(red: 0.45, green: 0.45, blue: 0.45)
        }
    }

    var icon: String {
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
    var isRegenerable: Bool {
        switch self {
        case .deps, .build, .ios, .python, .cache: true
        default: false
        }
    }
}

final class Node: Identifiable, Hashable, @unchecked Sendable {
    let name: String
    let path: String
    let isDirectory: Bool
    let category: Category
    /// Octets des fichiers directement dedans qui ne sont pas listés comme enfants.
    var ownBytes: Int64 = 0
    var ownFileCount: Int = 0
    var size: Int64 = 0
    var fileCount: Int = 0
    var breakdown = [Int64](repeating: 0, count: Category.allCases.count)
    var children: [Node] = []
    weak var parent: Node?
    var isGitRepo = false

    var id: String { path }

    init(name: String, path: String, isDirectory: Bool, category: Category) {
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
        self.category = category
    }

    static func == (a: Node, b: Node) -> Bool { a === b }
    func hash(into h: inout Hasher) { h.combine(ObjectIdentifier(self)) }

    var regenerableBytes: Int64 {
        Category.allCases.filter(\.isRegenerable).reduce(0) { $0 + breakdown[$1.rawValue] }
    }

    func bytes(_ c: Category) -> Int64 { breakdown[c.rawValue] }

    /// Recalcule taille et répartition à partir des enfants et des fichiers propres.
    func finalize() {
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
    func detach() {
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

    func relativePath(to root: Node) -> String {
        if path == root.path { return "/" }
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
    }

    func walk(_ body: (Node) -> Void) {
        body(self)
        for c in children { c.walk(body) }
    }
}

struct BigFile: Identifiable, Hashable {
    let path: String
    let size: Int64
    let category: Category
    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }
}

struct ScanResult {
    let root: Node
    var bigFiles: [BigFile]
    let errors: Int
    let duration: TimeInterval
}

struct VolumeInfo {
    let name: String
    let total: Int64
    let available: Int64
    let availableImportant: Int64
}

enum Fmt {
    static func bytes(_ b: Int64) -> String {
        b <= 0 ? "0 o" : ByteCountFormatter.string(fromByteCount: b, countStyle: .file)
    }

    static func percent(_ part: Int64, of total: Int64) -> String {
        guard total > 0 else { return "–" }
        let p = Double(part) / Double(total) * 100
        return p < 0.1 && part > 0 ? "<0,1 %" : String(format: "%.1f %%", p).replacingOccurrences(of: ".", with: ",")
    }

    static func count(_ n: Int) -> String {
        n.formatted(.number.locale(Locale(identifier: "fr_FR")))
    }
}
