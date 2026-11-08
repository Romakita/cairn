import Foundation

/// Configuration de Cairn (`~/.cairn/config.toml`, schéma v1).
public struct CairnConfig: Equatable, Sendable {
    public static let currentVersion = 1

    public struct Analysis: Equatable, Sendable {
        public var bigFileThresholdMB = 50
        public var bigFolderThresholdGB = 1.0
        public init() {}
    }

    public struct Folder: Equatable, Sendable {
        public var path: String
        public var backup = true
        public var exclude: [String] = []
        public init(path: String, backup: Bool = true, exclude: [String] = []) {
            self.path = path; self.backup = backup; self.exclude = exclude
        }
        /// Chemin avec `~` développé.
        public var expandedPath: String { (path as NSString).expandingTildeInPath }
        public var isAvailable: Bool { FileManager.default.fileExists(atPath: expandedPath) }
    }

    public struct Home: Equatable, Sendable {
        public var include: [String] = []
        public var exclude: [String] = []
        public init(include: [String] = [], exclude: [String] = []) { self.include = include; self.exclude = exclude }
    }

    public struct AITool: Equatable, Sendable {
        public static let categories = ["conversations", "config", "memories", "credentials"]
        public var id: String
        public var categories: [String]
        public init(id: String, categories: [String]) { self.id = id; self.categories = categories }
    }

    public enum Retention: Equatable, Sendable {
        case tiered(days: Int, weeks: Int)
        case count(Int)
        public static let recommended = Retention.tiered(days: 30, weeks: 48)
    }

    public enum Provider: String, Equatable, Sendable, CaseIterable { case local, smb }

    public struct Destination: Equatable, Sendable {
        public var id: String
        public var provider: Provider
        public var path: String?
        public var url: String?
        public var username: String?
        public var keychain: String?
        public var encrypted = true
        public var retention = Retention.recommended
        public init(id: String, provider: Provider, path: String? = nil, url: String? = nil, username: String? = nil,
                    keychain: String? = nil, encrypted: Bool = true, retention: Retention = .recommended) {
            self.id = id; self.provider = provider; self.path = path; self.url = url; self.username = username
            self.keychain = keychain; self.encrypted = encrypted; self.retention = retention
        }
    }

    public enum Frequency: String, Equatable, Sendable, CaseIterable { case daily, weekly, manual }
    public static let weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

    public struct Schedule: Equatable, Sendable {
        public var frequency = Frequency.daily
        public var time = "12:30"
        public var weekday = "monday"
        public var background = false
        public var onBatteryMinPercent = 20
        public init() {}
    }

    public struct Alerts: Equatable, Sendable {
        public var lowPercent = 10.0
        public var lowGB = 20.0
        public var criticalPercent = 5.0
        public var criticalGB = 5.0
        public init() {}
    }

    public struct Git: Equatable, Sendable {
        public var fetchBefore = false
        public var gc = true
        public var worktreeStaleDays = 30
        public init() {}
    }

    public var version = currentVersion
    public var language = "auto"
    public var analysis = Analysis()
    public var folders: [Folder] = []
    public var home = Home()
    public var ai: [AITool] = []
    public var destinations: [Destination] = []
    public var schedule = Schedule()
    public var alerts = Alerts()
    public var logRetentionDays = 90
    public var git = Git()
    public var excludedTools: [String] = []

    public init() {}
}

/// Problème trouvé dans `config.toml`.
public struct ConfigIssue: Equatable, Sendable, CustomStringConvertible {
    public enum Severity: String, Sendable { case error, warning }
    public let severity: Severity
    public let key: String
    public let line: Int?
    public let message: String

    public var description: String {
        let where_ = line.map { L10n.tr("config.issue.line", $0) } ?? ""
        return "\(severity == .error ? L10n.tr("config.issue.error") : L10n.tr("config.issue.warning")) \(where_)\(key): \(message)"
    }
}

// MARK: - Lecture

public enum ConfigDecoder {
    /// Décode un document ; les erreurs de syntaxe TOML sont levées, les erreurs de schéma renvoyées en `issues`.
    public static func decode(_ doc: TOMLDocument) throws -> (CairnConfig, [ConfigIssue]) {
        let t = try doc.tree()
        var r = Reader()
        var c = CairnConfig()

        r.known(t, "", ["version", "language", "analysis", "folders", "home", "ai", "destinations", "schedule",
                        "alerts", "logs", "git", "tools"])
        c.version = r.int(t, "version") ?? 0
        if c.version > CairnConfig.currentVersion {
            r.error("version", t.valueLine("version"), L10n.tr("config.issue.version_unsupported", c.version))
        }
        if let lang = r.string(t, "language") {
            if lang == "auto" || AppLanguage.parse(lang) != nil { c.language = lang }
            else { r.error("language", t.valueLine("language"), L10n.tr("config.issue.enum", "auto, en-US, fr-FR")) }
        }

        if let a = r.table(t, "analysis") {
            r.known(a, "analysis", ["big_file_threshold_mb", "big_folder_threshold_gb"])
            if let v = r.int(a, "big_file_threshold_mb", key: "analysis.big_file_threshold_mb") {
                if v > 0 { c.analysis.bigFileThresholdMB = v } else { r.error("analysis.big_file_threshold_mb", a.valueLine("big_file_threshold_mb"), L10n.tr("config.issue.positive")) }
            }
            if let v = r.double(a, "big_folder_threshold_gb", key: "analysis.big_folder_threshold_gb") {
                if v > 0 { c.analysis.bigFolderThresholdGB = v } else { r.error("analysis.big_folder_threshold_gb", a.valueLine("big_folder_threshold_gb"), L10n.tr("config.issue.positive")) }
            }
        }

        for (i, f) in t.tables("folders").enumerated() {
            let k = "folders[\(i)]"
            r.known(f, k, ["path", "backup", "exclude"])
            guard let path = r.string(f, "path", key: "\(k).path"), !path.isEmpty else {
                r.error("\(k).path", f.line, L10n.tr("config.issue.required")); continue
            }
            var folder = CairnConfig.Folder(path: path)
            folder.backup = r.bool(f, "backup", key: "\(k).backup") ?? true
            folder.exclude = r.strings(f, "exclude", key: "\(k).exclude") ?? []
            if !folder.isAvailable { r.warning("\(k).path", f.valueLine("path"), L10n.tr("config.issue.folder_unavailable", path)) }
            c.folders.append(folder)
        }

        if let h = r.table(t, "home") {
            r.known(h, "home", ["include", "exclude"])
            c.home.include = r.strings(h, "include", key: "home.include") ?? []
            c.home.exclude = r.strings(h, "exclude", key: "home.exclude") ?? []
        }

        if let ai = r.table(t, "ai") {
            for id in ai.keys {
                guard let tool = ai.table(id) else { r.error("ai.\(id)", nil, L10n.tr("config.issue.type", "table")); continue }
                r.known(tool, "ai.\(id)", ["categories"])
                let cats = r.strings(tool, "categories", key: "ai.\(id).categories") ?? []
                for cat in cats where !CairnConfig.AITool.categories.contains(cat) {
                    r.error("ai.\(id).categories", tool.valueLine("categories"),
                            L10n.tr("config.issue.enum", CairnConfig.AITool.categories.joined(separator: ", ")))
                }
                c.ai.append(.init(id: id, categories: cats))
            }
        }

        var ids = Set<String>()
        for (i, d) in t.tables("destinations").enumerated() {
            let k = "destinations[\(i)]"
            r.known(d, k, ["id", "provider", "path", "url", "username", "keychain", "encrypted", "retention"])
            guard let id = r.string(d, "id", key: "\(k).id"), !id.isEmpty else { r.error("\(k).id", d.line, L10n.tr("config.issue.required")); continue }
            if !ids.insert(id).inserted { r.error("\(k).id", d.valueLine("id"), L10n.tr("config.issue.duplicate", id)) }
            guard let ps = r.string(d, "provider", key: "\(k).provider"), let provider = CairnConfig.Provider(rawValue: ps) else {
                r.error("\(k).provider", d.valueLine("provider") ?? d.line, L10n.tr("config.issue.enum", "local, smb")); continue
            }
            var dest = CairnConfig.Destination(id: id, provider: provider)
            dest.path = r.string(d, "path", key: "\(k).path")
            dest.url = r.string(d, "url", key: "\(k).url")
            dest.username = r.string(d, "username", key: "\(k).username")
            dest.keychain = r.string(d, "keychain", key: "\(k).keychain")
            dest.encrypted = r.bool(d, "encrypted", key: "\(k).encrypted") ?? true
            switch provider {
            case .local where (dest.path ?? "").isEmpty:
                r.error("\(k).path", d.line, L10n.tr("config.issue.required"))
            case .smb where !(dest.url ?? "").lowercased().hasPrefix("smb://"):
                r.error("\(k).url", d.valueLine("url") ?? d.line, L10n.tr("config.issue.smb_url"))
            default: break
            }
            if let ret = d.value("retention") {
                dest.retention = r.retention(ret, key: "\(k).retention", line: d.valueLine("retention")) ?? .recommended
            }
            c.destinations.append(dest)
        }

        if let s = r.table(t, "schedule") {
            r.known(s, "schedule", ["frequency", "time", "weekday", "background", "on_battery_min_percent"])
            if let f = r.string(s, "frequency", key: "schedule.frequency") {
                if let v = CairnConfig.Frequency(rawValue: f) { c.schedule.frequency = v }
                else { r.error("schedule.frequency", s.valueLine("frequency"), L10n.tr("config.issue.enum", "daily, weekly, manual")) }
            }
            if let time = r.string(s, "time", key: "schedule.time") {
                if time.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) != nil { c.schedule.time = time }
                else { r.error("schedule.time", s.valueLine("time"), L10n.tr("config.issue.time")) }
            }
            if let wd = r.string(s, "weekday", key: "schedule.weekday") {
                if CairnConfig.weekdays.contains(wd) { c.schedule.weekday = wd }
                else { r.error("schedule.weekday", s.valueLine("weekday"), L10n.tr("config.issue.enum", CairnConfig.weekdays.joined(separator: ", "))) }
            }
            c.schedule.background = r.bool(s, "background", key: "schedule.background") ?? false
            if let p = r.int(s, "on_battery_min_percent", key: "schedule.on_battery_min_percent") {
                if (0...100).contains(p) { c.schedule.onBatteryMinPercent = p }
                else { r.error("schedule.on_battery_min_percent", s.valueLine("on_battery_min_percent"), L10n.tr("config.issue.range", 0, 100)) }
            }
        }

        if let a = r.table(t, "alerts") {
            r.known(a, "alerts", ["low_percent", "low_gb", "critical_percent", "critical_gb"])
            c.alerts.lowPercent = r.double(a, "low_percent", key: "alerts.low_percent") ?? c.alerts.lowPercent
            c.alerts.lowGB = r.double(a, "low_gb", key: "alerts.low_gb") ?? c.alerts.lowGB
            c.alerts.criticalPercent = r.double(a, "critical_percent", key: "alerts.critical_percent") ?? c.alerts.criticalPercent
            c.alerts.criticalGB = r.double(a, "critical_gb", key: "alerts.critical_gb") ?? c.alerts.criticalGB
            if c.alerts.criticalPercent > c.alerts.lowPercent || c.alerts.criticalGB > c.alerts.lowGB {
                r.error("alerts", a.line, L10n.tr("config.issue.alerts_order"))
            }
        }

        if let l = r.table(t, "logs") {
            r.known(l, "logs", ["retention_days"])
            if let d = r.int(l, "retention_days", key: "logs.retention_days") {
                if d >= 1 { c.logRetentionDays = d } else { r.error("logs.retention_days", l.valueLine("retention_days"), L10n.tr("config.issue.positive")) }
            }
        }

        if let g = r.table(t, "git") {
            r.known(g, "git", ["fetch_before", "gc", "worktree_stale_days"])
            c.git.fetchBefore = r.bool(g, "fetch_before", key: "git.fetch_before") ?? false
            c.git.gc = r.bool(g, "gc", key: "git.gc") ?? true
            if let d = r.int(g, "worktree_stale_days", key: "git.worktree_stale_days") {
                if d >= 1 { c.git.worktreeStaleDays = d } else { r.error("git.worktree_stale_days", g.valueLine("worktree_stale_days"), L10n.tr("config.issue.positive")) }
            }
        }

        if let tools = r.table(t, "tools") {
            r.known(tools, "tools", ["excluded"])
            c.excludedTools = r.strings(tools, "excluded", key: "tools.excluded") ?? []
        }

        return (c, r.issues)
    }

    /// Lecture typée qui accumule les problèmes.
    struct Reader {
        var issues: [ConfigIssue] = []

        mutating func error(_ key: String, _ line: Int?, _ message: String) {
            issues.append(.init(severity: .error, key: key, line: line, message: message))
        }

        mutating func warning(_ key: String, _ line: Int?, _ message: String) {
            issues.append(.init(severity: .warning, key: key, line: line, message: message))
        }

        /// Clés inconnues : conservées dans le fichier, signalées en avertissement.
        mutating func known(_ t: TOMLTable, _ prefix: String, _ keys: Set<String>) {
            for k in t.keys where !keys.contains(k) {
                warning(prefix.isEmpty ? k : "\(prefix).\(k)", t.valueLine(k) ?? t.table(k)?.line, L10n.tr("config.issue.unknown_key"))
            }
        }

        private mutating func typed<T>(_ t: TOMLTable, _ k: String, _ key: String?, _ type: String, _ get: (TOMLValue) -> T?) -> T? {
            guard let v = t.value(k) else {
                if t[k] != nil { error(key ?? k, t.table(k)?.line, L10n.tr("config.issue.type", type)) }
                return nil
            }
            guard let x = get(v) else { error(key ?? k, t.valueLine(k), L10n.tr("config.issue.type_found", type, v.typeName)); return nil }
            return x
        }

        mutating func string(_ t: TOMLTable, _ k: String, key: String? = nil) -> String? { typed(t, k, key, "string") { $0.string } }
        mutating func bool(_ t: TOMLTable, _ k: String, key: String? = nil) -> Bool? { typed(t, k, key, "boolean") { $0.bool } }
        mutating func int(_ t: TOMLTable, _ k: String, key: String? = nil) -> Int? { typed(t, k, key, "integer") { $0.integer.map { Int($0) } } }
        mutating func double(_ t: TOMLTable, _ k: String, key: String? = nil) -> Double? { typed(t, k, key, "number") { $0.double } }
        mutating func strings(_ t: TOMLTable, _ k: String, key: String? = nil) -> [String]? {
            typed(t, k, key, "array of strings") { v in
                guard let a = v.array else { return nil }
                let s = a.compactMap(\.string)
                return s.count == a.count ? s : nil
            }
        }

        mutating func table(_ t: TOMLTable, _ k: String) -> TOMLTable? {
            if t[k] != nil && t.table(k) == nil { error(k, t.valueLine(k), L10n.tr("config.issue.type", "table")) }
            return t.table(k)
        }

        mutating func retention(_ v: TOMLValue, key: String, line: Int?) -> CairnConfig.Retention? {
            guard let pairs = v.inlineTable else { error(key, line, L10n.tr("config.issue.type_found", "table", v.typeName)); return nil }
            let d = Dictionary(pairs, uniquingKeysWith: { a, _ in a })
            switch d["mode"]?.string {
            case "tiered":
                let days = Int(d["days"]?.integer ?? 30), weeks = Int(d["weeks"]?.integer ?? 48)
                guard (0...3650).contains(days), (0...520).contains(weeks), days + weeks > 0 else {
                    error(key, line, L10n.tr("config.issue.retention")); return nil
                }
                return .tiered(days: days, weeks: weeks)
            case "count":
                let n = Int(d["count"]?.integer ?? 0)
                guard (1...520).contains(n) else { error(key, line, L10n.tr("config.issue.range", 1, 520)); return nil }
                return .count(n)
            default:
                error(key, line, L10n.tr("config.issue.enum", "tiered, count")); return nil
            }
        }
    }
}

// MARK: - Écriture

public enum ConfigWriter {
    /// Applique la configuration au document en conservant commentaires, ordre et clés inconnues.
    public static func apply(_ c: CairnConfig, to doc: inout TOMLDocument) {
        doc.set(.integer(Int64(c.version)), key: ["version"])
        doc.set(.string(c.language), key: ["language"])
        doc.set(.integer(Int64(c.analysis.bigFileThresholdMB)), section: ["analysis"], key: ["big_file_threshold_mb"])
        doc.set(.double(c.analysis.bigFolderThresholdGB), section: ["analysis"], key: ["big_folder_threshold_gb"])

        syncArray(&doc, ["folders"], count: c.folders.count)
        for (i, f) in c.folders.enumerated() {
            doc.set(.string(f.path), section: ["folders"], arrayIndex: i, key: ["path"])
            doc.set(.bool(f.backup), section: ["folders"], arrayIndex: i, key: ["backup"])
            doc.set(.array(f.exclude.map { .string($0) }), section: ["folders"], arrayIndex: i, key: ["exclude"])
        }

        doc.set(.array(c.home.include.map { .string($0) }), section: ["home"], key: ["include"])
        doc.set(.array(c.home.exclude.map { .string($0) }), section: ["home"], key: ["exclude"])

        for tool in c.ai {
            doc.set(.array(tool.categories.map { .string($0) }), section: ["ai", tool.id], key: ["categories"])
        }

        syncArray(&doc, ["destinations"], count: c.destinations.count)
        for (i, d) in c.destinations.enumerated() {
            let s = ["destinations"]
            doc.set(.string(d.id), section: s, arrayIndex: i, key: ["id"])
            doc.set(.string(d.provider.rawValue), section: s, arrayIndex: i, key: ["provider"])
            for (k, v) in [("path", d.path), ("url", d.url), ("username", d.username), ("keychain", d.keychain)] {
                if let v { doc.set(.string(v), section: s, arrayIndex: i, key: [k]) } else { doc.remove(section: s, arrayIndex: i, key: [k]) }
            }
            doc.set(.bool(d.encrypted), section: s, arrayIndex: i, key: ["encrypted"])
            doc.set(render(d.retention), section: s, arrayIndex: i, key: ["retention"])
        }

        doc.set(.string(c.schedule.frequency.rawValue), section: ["schedule"], key: ["frequency"])
        doc.set(.string(c.schedule.time), section: ["schedule"], key: ["time"])
        doc.set(.string(c.schedule.weekday), section: ["schedule"], key: ["weekday"])
        doc.set(.bool(c.schedule.background), section: ["schedule"], key: ["background"])
        doc.set(.integer(Int64(c.schedule.onBatteryMinPercent)), section: ["schedule"], key: ["on_battery_min_percent"])

        doc.set(.double(c.alerts.lowPercent), section: ["alerts"], key: ["low_percent"])
        doc.set(.double(c.alerts.lowGB), section: ["alerts"], key: ["low_gb"])
        doc.set(.double(c.alerts.criticalPercent), section: ["alerts"], key: ["critical_percent"])
        doc.set(.double(c.alerts.criticalGB), section: ["alerts"], key: ["critical_gb"])

        doc.set(.integer(Int64(c.logRetentionDays)), section: ["logs"], key: ["retention_days"])

        doc.set(.bool(c.git.fetchBefore), section: ["git"], key: ["fetch_before"])
        doc.set(.bool(c.git.gc), section: ["git"], key: ["gc"])
        doc.set(.integer(Int64(c.git.worktreeStaleDays)), section: ["git"], key: ["worktree_stale_days"])

        doc.set(.array(c.excludedTools.map { .string($0) }), section: ["tools"], key: ["excluded"])
    }

    /// Nouveau fichier commenté.
    public static func newDocument(_ c: CairnConfig) -> TOMLDocument {
        var doc = try! TOMLDocument(parsing: """
        # Configuration de Cairn — modifiable à la main ou depuis les réglages de l'app.
        # Les mots de passe ne sont jamais écrits ici : ils sont dans le Trousseau macOS.

        """)
        apply(c, to: &doc)
        return doc
    }

    static func render(_ r: CairnConfig.Retention) -> TOMLValue {
        switch r {
        case let .tiered(days, weeks): .inlineTable([("mode", .string("tiered")), ("days", .integer(Int64(days))), ("weeks", .integer(Int64(weeks)))])
        case let .count(n): .inlineTable([("mode", .string("count")), ("count", .integer(Int64(n)))])
        }
    }

    static func syncArray(_ doc: inout TOMLDocument, _ path: [String], count: Int) {
        while doc.arrayTableCount(path) > count { doc.removeArrayTable(path, index: doc.arrayTableCount(path) - 1) }
        while doc.arrayTableCount(path) < count { doc.appendArrayTable(path, values: []) }
    }
}

// MARK: - Migration

public enum ConfigMigration {
    /// Version déclarée par le document (0 si absente).
    public static func version(of doc: TOMLDocument) -> Int {
        Int((try? doc.tree().value("version")?.integer) ?? 0)
    }

    /// Migre un document v0 (ancienne app : `root_path`, pas de `version`) vers la version courante.
    public static func migrate(_ doc: inout TOMLDocument) {
        var v = version(of: doc)
        if v < 1 {
            if let root = try? doc.tree().value("root_path")?.string {
                doc.remove(key: ["root_path"])
                if doc.arrayTableCount(["folders"]) == 0 {
                    doc.appendArrayTable(["folders"], values: [("path", .string(root)), ("backup", .bool(true))])
                }
            }
            v = 1
        }
        doc.set(.integer(Int64(v)), key: ["version"])
    }
}
