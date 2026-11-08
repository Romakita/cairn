import Foundation
import SQLite3

/// Profil déclaratif d'un outil IA (`Resources/ai-tools/<id>.json`). Ajouter un outil = ajouter un profil.
public struct AIProfile: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let version: Int
    /// Racine des données (`~` développé), chemins des catégories relatifs à elle.
    public let root: String
    /// Chemins relatifs au home qui signalent la présence de l'outil.
    public let detect: [String]
    /// Jeton rangé dans le Trousseau : reconnexion nécessaire après restauration.
    public let credentialsInKeychain: Bool
    public let conversationsGlob: String?
    public let categories: [String: [String]]
    public let sqlite: [String]
    public let exclude: [String]
    public let reinstall: [String]
    /// Noms de processus de l'outil : il doit être quitté avant une restauration.
    public let processes: [String]?

    enum CodingKeys: String, CodingKey {
        case id, version, root, detect, categories, sqlite, exclude, reinstall, processes
        case credentialsInKeychain = "credentials_in_keychain", conversationsGlob = "conversations_glob"
    }

    public func rootPath(home: String = NSHomeDirectory()) -> String {
        root == "~" ? home : (root.hasPrefix("~/") ? home + "/" + root.dropFirst(2) : root)
    }

    public func isDetected(home: String = NSHomeDirectory()) -> Bool {
        detect.contains { FileManager.default.fileExists(atPath: home + "/" + $0) }
    }
}

public enum AIProfiles {
    /// Profils fournis avec Cairn.
    public static let bundled: [AIProfile] = {
        let urls = (Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: "ai-tools") ?? [])
            + (Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? [])
        var seen = Set<String>()
        return urls.compactMap { url -> AIProfile? in
            guard let data = try? Data(contentsOf: url), let p = try? JSONDecoder().decode(AIProfile.self, from: data),
                  seen.insert(p.id).inserted else { return nil }
            return p
        }.sorted { $0.id < $1.id }
    }()

    /// Profils d'un dossier (ajout d'un outil sans recompiler, tests).
    public static func load(from dir: URL) -> [AIProfile] {
        ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(AIProfile.self, from: Data(contentsOf: $0)) }
            .sorted { $0.id < $1.id }
    }
}

/// Correspondance simple de motifs (`*` dans un segment).
func globMatch(_ pattern: String, _ name: String) -> Bool {
    fnmatch(pattern, name, 0) == 0
}

public enum AIBackup {
    public struct Resolved: Sendable {
        /// Chemins relatifs à la racine, par catégorie (fichiers ordinaires et dossiers), hors bases SQLite.
        public var files: [String: [String]] = [:]
        /// Bases SQLite par catégorie (copiées par snapshot).
        public var databases: [String: [String]] = [:]
    }

    /// Développe les entrées d'une catégorie (dossiers « x/ », fichiers, motifs « a/*.json ») en chemins existants.
    public static func expand(_ entries: [String], root: String) -> [String] {
        let fm = FileManager.default
        var out: [String] = []
        for e in entries {
            let clean = e.hasSuffix("/") ? String(e.dropLast()) : e
            if clean.contains("*") {
                let dir = (clean as NSString).deletingLastPathComponent
                let pattern = (clean as NSString).lastPathComponent
                let base = dir.isEmpty ? root : root + "/" + dir
                for name in ((try? fm.contentsOfDirectory(atPath: base)) ?? []).sorted() where globMatch(pattern, name) {
                    out.append(dir.isEmpty ? name : dir + "/" + name)
                }
            } else if fm.fileExists(atPath: root + "/" + clean) {
                out.append(clean)
            }
        }
        return out
    }

    public static func isDatabase(_ rel: String, _ p: AIProfile) -> Bool {
        p.sqlite.contains { pat in globMatch(pat, rel) || globMatch(pat, (rel as NSString).lastPathComponent) }
    }

    public static func resolve(_ p: AIProfile, categories: [String], home: String = NSHomeDirectory()) -> Resolved {
        let root = p.rootPath(home: home)
        var r = Resolved()
        for cat in categories {
            let paths = expand(p.categories[cat] ?? [], root: root)
            r.files[cat] = paths.filter { !isDatabase($0, p) }
            r.databases[cat] = paths.filter { isDatabase($0, p) }
        }
        return r
    }

    /// Copie cohérente d'une base SQLite (API de sauvegarde en ligne), même si l'outil est en train d'écrire.
    public static func snapshot(_ source: String, to dest: String) throws {
        try FileManager.default.createDirectory(atPath: (dest as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(atPath: dest)
        var src: OpaquePointer?, dst: OpaquePointer?
        guard sqlite3_open_v2(source, &src, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            sqlite3_close(src); throw AIError.sqlite(source)
        }
        defer { sqlite3_close(src) }
        guard sqlite3_open(dest, &dst) == SQLITE_OK else { sqlite3_close(dst); throw AIError.sqlite(dest) }
        defer { sqlite3_close(dst) }
        guard let b = sqlite3_backup_init(dst, "main", src, "main") else { throw AIError.sqlite(source) }
        var rc: Int32
        repeat {
            rc = sqlite3_backup_step(b, 256)
            if rc == SQLITE_BUSY || rc == SQLITE_LOCKED { usleep(50_000) }
        } while rc == SQLITE_OK || rc == SQLITE_BUSY || rc == SQLITE_LOCKED
        sqlite3_backup_finish(b)
        guard rc == SQLITE_DONE else { throw AIError.sqlite(source) }
        // Base autonome : journal en mode delete (pas de -wal à côté).
        sqlite3_exec(dst, "PRAGMA journal_mode=DELETE;", nil, nil, nil)
    }

    public enum AIError: Error, CustomStringConvertible {
        case sqlite(String)
        public var description: String { L10n.tr("ai.error.sqlite", (self.path as NSString).lastPathComponent) }
        var path: String { if case let .sqlite(p) = self { p } else { "" } }
    }

    /// Outils ouverts (journal) : la copie reste cohérente grâce aux snapshots.
    public static func runningApps() -> [String] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-lx", "Claude|Codex|ChatGPT|claude|codex"]
        let pipe = Pipe()
        p.standardOutput = pipe
        try? p.run()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        return out.split(separator: "\n").compactMap { $0.split(separator: " ").last.map(String.init) }
    }

    /// Parties de sauvegarde des outils IA configurés : une partie par catégorie (fichiers),
    /// plus `ai/<outil>/meta` (profil, liste à réinstaller, snapshots SQLite).
    public static func parts(config: CairnConfig, staging: URL, home: String = NSHomeDirectory(),
                             profiles: [AIProfile] = AIProfiles.bundled) throws -> [BackupPart] {
        var parts: [BackupPart] = []
        for tool in config.ai {
            guard let p = profiles.first(where: { $0.id == tool.id }), p.isDetected(home: home) else { continue }
            let root = p.rootPath(home: home)
            let resolved = resolve(p, categories: tool.categories, home: home)
            let meta = staging.appendingPathComponent("ai-\(p.id)")
            try FileManager.default.createDirectory(at: meta, withIntermediateDirectories: true)
            for cat in tool.categories {
                if let files = resolved.files[cat], !files.isEmpty {
                    parts.append(BackupPart(kind: .ai, target: "ai/\(p.id)/\(cat)", source: root,
                                            excludes: p.exclude + p.reinstall + ["*-wal", "*-shm"] + p.sqlite,
                                            filesFrom: files))
                }
                for db in resolved.databases[cat] ?? [] {
                    try snapshot(root + "/" + db, to: meta.appendingPathComponent("sqlite/\(cat)/\(db)").path)
                }
            }
            // Éléments réinstallés plutôt que copiés : seulement leur liste.
            var reinstall: [String: [String]] = [:]
            for r in p.reinstall {
                let dir = root + "/" + (r.hasSuffix("/") ? String(r.dropLast()) : r)
                reinstall[r] = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
            }
            let info: [String: Any] = ["profile": p.id, "profile_version": p.version, "home": home, "root": root,
                                       "categories": tool.categories, "reinstall": reinstall, "running": runningApps()]
            try JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys])
                .write(to: meta.appendingPathComponent("profile.json"))
            parts.append(BackupPart(kind: .ai, target: "ai/\(p.id)/meta", source: meta.path))
        }
        return parts
    }

    // MARK: Vue

    public struct ToolStats: Sendable {
        public let profile: AIProfile
        public let detected: Bool
        public var bytesByCategory: [String: Int64] = [:]
        public var notCopiedBytes: Int64 = 0
        public var totalBytes: Int64 = 0
        public var conversations = 0
        public var latestConversation: Date?
    }

    /// Tailles par catégorie, conversations et éléments non copiés (pour la vue IA et `cairn ai`).
    public static func stats(_ p: AIProfile, home: String = NSHomeDirectory()) -> ToolStats {
        var s = ToolStats(profile: p, detected: p.isDetected(home: home))
        guard s.detected else { return s }
        let root = p.rootPath(home: home)
        for (cat, entries) in p.categories {
            s.bytesByCategory[cat] = expand(entries, root: root).reduce(Int64(0)) { $0 + Scanner.measure(root + "/" + $1).size }
        }
        s.notCopiedBytes = expand(p.reinstall, root: root).reduce(Int64(0)) { $0 + Scanner.measure(root + "/" + $1).size }
        if p.root != "~" { s.totalBytes = Scanner.measure(root).size }
        else { s.totalBytes = p.detect.reduce(Int64(0)) { $0 + Scanner.measure(home + "/" + $1).size } }
        if let g = p.conversationsGlob {
            let parts = g.split(separator: "/").map(String.init)
            var paths = [""]
            for part in parts {
                paths = paths.flatMap { base -> [String] in
                    let dir = base.isEmpty ? root : root + "/" + base
                    return ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])
                        .filter { globMatch(part, $0) }.map { base.isEmpty ? $0 : base + "/" + $0 }
                }
            }
            s.conversations = paths.count
            s.latestConversation = paths.compactMap {
                (try? FileManager.default.attributesOfItem(atPath: root + "/" + $0)[.modificationDate]) as? Date
            }.max()
        }
        return s
    }
}
