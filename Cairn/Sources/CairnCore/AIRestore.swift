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
        /// Données qui gardent les anciens chemins (non réécrites), à signaler à l'utilisateur.
        public var notRewritten: [String] = []
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

    /// Restaure une base : copiée si elle manque, remplacée seulement si `replace`. Renvoie vrai si écrite.
    static func restoreDatabase(_ snapshot: URL, at dest: URL, replace: Bool) throws -> Bool {
        guard replace || !FileManager.default.fileExists(atPath: dest.path) else { return false }
        try replaceDatabase(snapshot, at: dest)
        return true
    }

    /// Remplace une base locale par son snapshot (l'ancienne en `.pre-restore`, avec ses -wal et -shm).
    static func replaceDatabase(_ snapshot: URL, at dest: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        let existed = fm.fileExists(atPath: dest.path)
        if existed {
            let pre = URL(fileURLWithPath: dest.path + ".pre-restore")
            try? fm.removeItem(at: pre)
            try fm.moveItem(at: dest, to: pre)
        }
        // Le journal WAL de l'ancienne base part avec elle (transactions pas encore écrites dans la base).
        for suffix in ["-wal", "-shm"] where fm.fileExists(atPath: dest.path + suffix) {
            let pre = dest.path + ".pre-restore" + suffix
            try? fm.removeItem(atPath: pre)
            if existed { try? fm.moveItem(atPath: dest.path + suffix, toPath: pre) } else { try? fm.removeItem(atPath: dest.path + suffix) }
        }
        try fm.copyItem(at: snapshot, to: dest)
    }

    /// Nom de dossier de projet de Claude Code pour un chemin : tout caractère non alphanumérique devient `-`.
    public static func claudeProjectName(_ path: String) -> String {
        path.replacingOccurrences(of: "[^A-Za-z0-9]", with: "-", options: .regularExpression)
    }

    /// Renomme les dossiers de `~/.claude/projects` selon la table « ancien préfixe → nouveau préfixe ».
    public static func rewriteClaudeProjects(projects: URL, prefixes: [(String, String)], report: inout Report) {
        let fm = FileManager.default
        // Le préfixe le plus long d'abord : un dossier suivi sous l'ancien home garde sa propre cible.
        let ordered = prefixes.filter { $0.0 != $0.1 }.sorted { $0.0.count > $1.0.count }
        for name in ((try? fm.contentsOfDirectory(atPath: projects.path)) ?? []).sorted() {
            for (old, new) in ordered {
                let o = claudeProjectName(old), n = claudeProjectName(new)
                guard name == o || name.hasPrefix(o + "-") else { continue }
                let renamed = n + name.dropFirst(o.count)
                let from = projects.appendingPathComponent(name), to = projects.appendingPathComponent(renamed)
                do {
                    if fm.fileExists(atPath: to.path) {
                        var r = Report()
                        try merge(from, into: to, report: &r)
                        // Supprimé seulement après une fusion complète : rien n'est perdu si elle échoue en route.
                        try fm.removeItem(at: from)
                    } else {
                        try fm.moveItem(at: from, to: to)
                    }
                    report.renamedProjects.append(renamed)
                } catch {
                    report.notRewritten.append(L10n.tr("ai.restore.rename_failed", name, String(describing: error)))
                }
                break
            }
        }
    }

    /// Données qui contiennent des chemins absolus que Cairn ne réécrit pas, quand un préfixe a changé.
    public static func notRewritten(tool: String, home: String, prefixes: [(String, String)]) -> [String] {
        let changed = prefixes.filter { $0.0 != $0.1 }
        guard !changed.isEmpty else { return [] }
        switch tool {
        case "claude-code":
            var out = [L10n.tr("ai.restore.not_rewritten.claude_sessions")]
            if let text = try? String(contentsOfFile: home + "/.claude.json", encoding: .utf8),
               changed.contains(where: { text.contains("\"" + $0.0) }) {
                out.append(L10n.tr("ai.restore.not_rewritten.claude_json"))
            }
            return out
        case "codex": return [L10n.tr("ai.restore.not_rewritten.codex")]
        case "claude-desktop": return [L10n.tr("ai.restore.not_rewritten.claude_desktop")]
        default: return []
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
        do {
            // Base absente localement : toujours restaurée. Base présente : remplacée seulement sur confirmation.
            let sqlite = toolDir.appendingPathComponent("meta/sqlite")
            for cat in (try? FileManager.default.contentsOfDirectory(atPath: sqlite.path)) ?? [] {
                let catDir = sqlite.appendingPathComponent(cat)
                guard let e = FileManager.default.enumerator(atPath: catDir.path) else { continue }
                while let rel = e.nextObject() as? String {
                    var isDir: ObjCBool = false
                    let s = catDir.appendingPathComponent(rel)
                    guard FileManager.default.fileExists(atPath: s.path, isDirectory: &isDir), !isDir.boolValue else { continue }
                    if try restoreDatabase(s, at: root.appendingPathComponent(rel), replace: replaceDatabases) { report.databases += 1 }
                }
            }
        }
        if p.id == "claude-code" {
            rewriteClaudeProjects(projects: root.appendingPathComponent(".claude/projects"), prefixes: prefixes, report: &report)
        }
        report.notRewritten += notRewritten(tool: p.id, home: home, prefixes: prefixes)
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
        do {
            // Base absente localement : toujours restaurée. Base présente : remplacée seulement sur confirmation.
            let sqlite = backup.appendingPathComponent("ai/sqlite")
            if let e = fm.enumerator(atPath: sqlite.path) {
                while let rel = e.nextObject() as? String {
                    let tool = rel.hasPrefix(".codex/") ? "codex" : (rel.hasPrefix(".claude/") ? "claude-code" : "")
                    var isDir: ObjCBool = false
                    let s = sqlite.appendingPathComponent(rel)
                    guard tools.contains(tool), fm.fileExists(atPath: s.path, isDirectory: &isDir), !isDir.boolValue else { continue }
                    if try restoreDatabase(s, at: homeURL.appendingPathComponent(rel), replace: replaceDatabases) { report.databases += 1 }
                }
            }
        }
        if tools.contains("claude-desktop") {
            let src = backup.appendingPathComponent("ai/claude-desktop/Claude")
            if fm.fileExists(atPath: src.path) {
                try merge(src, into: homeURL.appendingPathComponent("Library/Application Support/Claude"), report: &report)
            }
        }
        for t in tools.sorted() { report.notRewritten += notRewritten(tool: t, home: home, prefixes: prefixes) }
        return report
    }
}
