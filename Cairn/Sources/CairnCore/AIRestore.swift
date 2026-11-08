import Foundation

/// Restauration des données IA : fusion fichier par fichier (la version la plus récente gagne, l'autre est gardée
/// en `.pre-restore`), bases SQLite remplacées sur confirmation, chemins de projets Claude Code réécrits.
public enum AIRestore {
    public struct Report: Equatable, Sendable {
        public var added = 0
        public var replacedOlder = 0
        public var keptNewer = 0
        public var databases = 0
        public var renamedProjects: [String] = []
        public init() {}
    }

    /// Fusionne `src` dans `dest`.
    static func merge(_ src: URL, into dest: URL, report: inout Report) throws {
        let fm = FileManager.default
        guard let e = fm.enumerator(atPath: src.path) else { return }
        while let rel = e.nextObject() as? String {
            let s = src.appendingPathComponent(rel)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: s.path, isDirectory: &isDir), !isDir.boolValue else { continue }
            let d = dest.appendingPathComponent(rel)
            try fm.createDirectory(at: d.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard fm.fileExists(atPath: d.path) else {
                try fm.copyItem(at: s, to: d); report.added += 1; continue
            }
            let sa = try fm.attributesOfItem(atPath: s.path), da = try fm.attributesOfItem(atPath: d.path)
            let sm = sa[.modificationDate] as? Date ?? .distantPast, dm = da[.modificationDate] as? Date ?? .distantPast
            if (sa[.size] as? Int64) == (da[.size] as? Int64) && abs(sm.timeIntervalSince(dm)) < 1 { continue }
            let pre = URL(fileURLWithPath: d.path + ".pre-restore")
            try? fm.removeItem(at: pre)
            if sm > dm {
                try fm.moveItem(at: d, to: pre)        // la version locale, plus ancienne, est gardée à côté
                try fm.copyItem(at: s, to: d)
                report.replacedOlder += 1
            } else {
                try fm.copyItem(at: s, to: pre)        // la locale est plus récente : la sauvegardée est écrite à côté
                report.keptNewer += 1
            }
        }
    }

    /// Remplace une base locale par son snapshot (l'ancienne en `.pre-restore`, -wal et -shm retirés).
    static func replaceDatabase(_ snapshot: URL, at dest: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: dest.path) {
            let pre = URL(fileURLWithPath: dest.path + ".pre-restore")
            try? fm.removeItem(at: pre)
            try fm.moveItem(at: dest, to: pre)
        }
        for suffix in ["-wal", "-shm"] { try? fm.removeItem(atPath: dest.path + suffix) }
        try fm.copyItem(at: snapshot, to: dest)
    }

    /// Nom de dossier de projet de Claude Code pour un chemin (`/` et `.` deviennent `-`).
    public static func claudeProjectName(_ path: String) -> String {
        path.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ".", with: "-")
    }

    /// Renomme les dossiers de `~/.claude/projects` selon la table « ancien préfixe → nouveau préfixe ».
    public static func rewriteClaudeProjects(projects: URL, prefixes: [(String, String)], report: inout Report) {
        let fm = FileManager.default
        for name in ((try? fm.contentsOfDirectory(atPath: projects.path)) ?? []).sorted() {
            for (old, new) in prefixes where old != new {
                let o = claudeProjectName(old), n = claudeProjectName(new)
                guard name == o || name.hasPrefix(o + "-") else { continue }
                let renamed = n + name.dropFirst(o.count)
                let from = projects.appendingPathComponent(name), to = projects.appendingPathComponent(renamed)
                if fm.fileExists(atPath: to.path) {
                    var r = Report()
                    try? merge(from, into: to, report: &r)
                    try? fm.removeItem(at: from)
                } else {
                    try? fm.moveItem(at: from, to: to)
                }
                report.renamedProjects.append(renamed)
                break
            }
        }
    }

    /// Restaure un outil depuis une version Cairn (`<version>/ai/<outil>`).
    public static func restore(toolDir: URL, profile p: AIProfile, home: String = NSHomeDirectory(),
                               replaceDatabases: Bool, prefixes: [(String, String)] = []) throws -> Report {
        var report = Report()
        let root = URL(fileURLWithPath: p.rootPath(home: home))
        for cat in p.categories.keys.sorted() {
            let dir = toolDir.appendingPathComponent(cat)
            if FileManager.default.fileExists(atPath: dir.path) { try merge(dir, into: root, report: &report) }
        }
        if replaceDatabases {
            let sqlite = toolDir.appendingPathComponent("meta/sqlite")
            for cat in (try? FileManager.default.contentsOfDirectory(atPath: sqlite.path)) ?? [] {
                let catDir = sqlite.appendingPathComponent(cat)
                guard let e = FileManager.default.enumerator(atPath: catDir.path) else { continue }
                while let rel = e.nextObject() as? String {
                    var isDir: ObjCBool = false
                    let s = catDir.appendingPathComponent(rel)
                    guard FileManager.default.fileExists(atPath: s.path, isDirectory: &isDir), !isDir.boolValue else { continue }
                    try replaceDatabase(s, at: root.appendingPathComponent(rel))
                    report.databases += 1
                }
            }
        }
        if p.id == "claude-code" {
            rewriteClaudeProjects(projects: root.appendingPathComponent(".claude/projects"), prefixes: prefixes, report: &report)
        }
        return report
    }

    /// Restaure les données IA d'une sauvegarde faite par scripts/backup.sh
    /// (`home/.claude`, `home/.claude.json`, `home/.codex`, `ai/sqlite/…`, `ai/claude-desktop/<app>`).
    public static func restoreLegacy(backup: URL, tools: Set<String>, home: String = NSHomeDirectory(),
                                     replaceDatabases: Bool, prefixes: [(String, String)] = []) throws -> Report {
        var report = Report()
        let fm = FileManager.default
        let homeURL = URL(fileURLWithPath: home)
        if tools.contains("claude-code") {
            let src = backup.appendingPathComponent("home/.claude")
            if fm.fileExists(atPath: src.path) { try merge(src, into: homeURL.appendingPathComponent(".claude"), report: &report) }
            let json = backup.appendingPathComponent("home/.claude.json")
            if fm.fileExists(atPath: json.path) {
                let tmp = fm.temporaryDirectory.appendingPathComponent("cairn-legacy-\(UUID().uuidString)")
                try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
                try fm.copyItem(at: json, to: tmp.appendingPathComponent(".claude.json"))
                try merge(tmp, into: homeURL, report: &report)
                try? fm.removeItem(at: tmp)
            }
            rewriteClaudeProjects(projects: homeURL.appendingPathComponent(".claude/projects"), prefixes: prefixes, report: &report)
        }
        if tools.contains("codex") {
            let src = backup.appendingPathComponent("home/.codex")
            if fm.fileExists(atPath: src.path) { try merge(src, into: homeURL.appendingPathComponent(".codex"), report: &report) }
        }
        if replaceDatabases {
            let sqlite = backup.appendingPathComponent("ai/sqlite")
            if let e = fm.enumerator(atPath: sqlite.path) {
                while let rel = e.nextObject() as? String {
                    let tool = rel.hasPrefix(".codex/") ? "codex" : (rel.hasPrefix(".claude/") ? "claude-code" : "")
                    var isDir: ObjCBool = false
                    let s = sqlite.appendingPathComponent(rel)
                    guard tools.contains(tool), fm.fileExists(atPath: s.path, isDirectory: &isDir), !isDir.boolValue else { continue }
                    try replaceDatabase(s, at: homeURL.appendingPathComponent(rel))
                    report.databases += 1
                }
            }
        }
        if tools.contains("claude-desktop") {
            let src = backup.appendingPathComponent("ai/claude-desktop/Claude")
            if fm.fileExists(atPath: src.path) {
                try merge(src, into: homeURL.appendingPathComponent("Library/Application Support/Claude"), report: &report)
            }
        }
        return report
    }
}
