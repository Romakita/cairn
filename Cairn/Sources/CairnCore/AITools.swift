import Foundation
import SQLite3

/// Profil déclaratif d'un outil IA (`Resources/ai-tools/<id>.json`). Ajouter un outil = ajouter un profil.
public struct AIProfile: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// Nom affiché (nom de produit, non traduit). Absent : clé `ai.<id>` des traductions.
    public let name: String?
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
        case id, name, version, root, detect, categories, sqlite, exclude, reinstall, processes
        case credentialsInKeychain = "credentials_in_keychain", conversationsGlob = "conversations_glob"
    }

    public func rootPath(home: String = NSHomeDirectory()) -> String {
        root == "~" ? home : (root.hasPrefix("~/") ? home + "/" + root.dropFirst(2) : root)
    }

    public func isDetected(home: String = NSHomeDirectory()) -> Bool {
        detect.contains { FileManager.default.fileExists(atPath: home + "/" + $0) }
    }

    public var displayName: String { name ?? L10n.tr("ai.\(id)") }

    /// Chemins relatifs au home occupés par l'outil (racine et marqueurs de détection).
    public var homePaths: [String] {
        var out: [String] = []
        if root.hasPrefix("~/") { out.append(String(root.dropFirst(2))) }
        for d in detect where !out.contains(d) { out.append(d) }
        return out
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

    /// Nom affiché d'un outil d'après son identifiant.
    public static func name(for id: String, profiles: [AIProfile] = bundled) -> String {
        profiles.first { $0.id == id }?.displayName ?? L10n.tr("ai.\(id)")
    }

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

    /// Processus des outils IA ouverts (noms tirés des profils) : la copie reste cohérente grâce aux snapshots.
    public static func runningApps(profiles: [AIProfile] = AIProfiles.bundled) -> [String] {
        let names = Array(Set(profiles.flatMap { $0.processes ?? [] })).sorted()
        guard !names.isEmpty else { return [] }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-lx", names.joined(separator: "|")]
        let pipe = Pipe()
        p.standardOutput = pipe
        try? p.run()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        return out.split(separator: "\n").compactMap { $0.split(separator: " ").last.map(String.init) }
    }

    /// Les identifiants ne partent que si toutes les destinations sont chiffrées (les parties sont communes
    /// à toutes les destinations d'une sauvegarde).
    public static func credentialsAllowed(config: CairnConfig) -> Bool {
        !config.destinations.isEmpty && config.destinations.allSatisfy(\.encrypted)
    }

    /// Catégories réellement sauvegardées pour un outil configuré.
    public static func effectiveCategories(_ tool: CairnConfig.AITool, config: CairnConfig) -> [String] {
        credentialsAllowed(config: config) ? tool.categories : tool.categories.filter { $0 != "credentials" }
    }

    /// Outils configurés et détectés qui sont ouverts (identifiants), d'après les processus de leur profil.
    public static func openTools(config: CairnConfig, home: String = NSHomeDirectory(),
                                 profiles: [AIProfile] = AIProfiles.bundled,
                                 running: [String]? = nil) -> [String] {
        let configured = profiles.filter { p in config.ai.contains { $0.id == p.id } && p.isDetected(home: home) }
        let names = Set(running ?? runningApps(profiles: configured))
        return configured.filter { !Set($0.processes ?? []).isDisjoint(with: names) }.map(\.id)
    }

    /// Ligne du journal de sauvegarde pour les outils ouverts (nil si aucun).
    public static func openToolsLogLine(config: CairnConfig, home: String = NSHomeDirectory(),
                                        profiles: [AIProfile] = AIProfiles.bundled, running: [String]? = nil) -> String? {
        let open = openTools(config: config, home: home, profiles: profiles, running: running)
        guard !open.isEmpty else { return nil }
        return "ai: open during backup (SQLite copied by snapshot): " + open.joined(separator: ", ")
    }

    /// Plugins et marketplaces déclarés par l'outil (nil si l'outil n'en déclare pas ou fichier illisible).
    public static func declaredPlugins(_ p: AIProfile, home: String = NSHomeDirectory()) -> [String: Any]? {
        let root = p.rootPath(home: home)
        func json(_ rel: String) -> [String: Any]? {
            (try? Data(contentsOf: URL(fileURLWithPath: root + "/" + rel)))
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
        switch p.id {
        case "claude-code":
            // installed_plugins.json : { "plugins": { "nom@marketplace": [ { "version", "scope"… } ] } }
            let installed = json(".claude/plugins/installed_plugins.json")
            let markets = json(".claude/plugins/known_marketplaces.json")
            guard installed != nil || markets != nil else { return nil }
            let plugins = ((installed?["plugins"] as? [String: Any]) ?? [:]).keys.sorted().map { name -> [String: Any] in
                var e: [String: Any] = ["name": name]
                if let first = ((installed?["plugins"] as? [String: Any])?[name] as? [[String: Any]])?.first {
                    for k in ["version", "scope"] { if let v = first[k] as? String { e[k] = v } }
                }
                return e
            }
            let marketplaces = (markets ?? [:]).keys.sorted().map { name -> [String: Any] in
                var e: [String: Any] = ["name": name]
                if let src = (markets?[name] as? [String: Any])?["source"] as? [String: Any],
                   let s = (src["repo"] ?? src["url"] ?? src["path"]) as? String { e["source"] = s }
                return e
            }
            return ["plugins": plugins, "marketplaces": marketplaces]
        case "codex":
            // config.toml : [plugins."nom@marketplace"] enabled = … et [marketplaces.<nom>] source = …
            guard let text = try? String(contentsOfFile: root + "/config.toml", encoding: .utf8),
                  let t = try? TOMLDocument(parsing: text).tree() else { return nil }
            let pt = t.table("plugins"), mt = t.table("marketplaces")
            guard pt != nil || mt != nil else { return nil }
            let plugins = (pt?.keys ?? []).sorted().map { name -> [String: Any] in
                var e: [String: Any] = ["name": name]
                if let on = pt?.table(name)?.value("enabled")?.bool { e["enabled"] = on }
                return e
            }
            let marketplaces = (mt?.keys ?? []).sorted().map { name -> [String: Any] in
                var e: [String: Any] = ["name": name]
                if let s = mt?.table(name)?.value("source")?.string { e["source"] = s }
                return e
            }
            return ["plugins": plugins, "marketplaces": marketplaces]
        default:
            return nil
        }
    }

    /// Parties de sauvegarde des outils IA configurés : une partie par catégorie (fichiers),
    /// plus `ai/<outil>/meta` (profil, liste à réinstaller, snapshots SQLite).
    public static func parts(config: CairnConfig, staging: URL, home: String = NSHomeDirectory(),
                             profiles: [AIProfile] = AIProfiles.bundled) throws -> [BackupPart] {
        var parts: [BackupPart] = []
        let running = runningApps(profiles: profiles)
        for tool in config.ai {
            guard let p = profiles.first(where: { $0.id == tool.id }), p.isDetected(home: home) else { continue }
            let root = p.rootPath(home: home)
            let categories = effectiveCategories(tool, config: config)
            let resolved = resolve(p, categories: categories, home: home)
            let meta = staging.appendingPathComponent("ai-\(p.id)")
            try FileManager.default.createDirectory(at: meta, withIntermediateDirectories: true)
            for cat in categories {
                if let files = resolved.files[cat], !files.isEmpty {
                    // Un dossier réinstallé n'est pas exclu s'il contient un fichier demandé (listes de plugins de
                    // Claude Code dans .claude/plugins/) : selon la version de rsync, l'exclusion du dossier parent
                    // l'emporterait sur --files-from.
                    let reinstall = p.reinstall.filter { r in !files.contains { $0.hasPrefix(r) } }
                    parts.append(BackupPart(kind: .ai, target: "ai/\(p.id)/\(cat)", source: root,
                                            excludes: p.exclude + reinstall + ["*-wal", "*-shm"] + p.sqlite,
                                            filesFrom: files))
                }
                for db in resolved.databases[cat] ?? [] {
                    try snapshot(root + "/" + db, to: meta.appendingPathComponent("sqlite/\(cat)/\(db)").path)
                }
            }
            // Éléments réinstallés plutôt que copiés : seulement leur liste (noms de dossiers en repli,
            // plugins et marketplaces déclarés par l'outil quand il en a).
            var reinstall: [String: [String]] = [:]
            for r in p.reinstall {
                let dir = root + "/" + (r.hasSuffix("/") ? String(r.dropLast()) : r)
                reinstall[r] = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
            }
            var info: [String: Any] = ["profile": p.id, "profile_version": p.version, "home": home, "root": root,
                                       "categories": categories, "reinstall": reinstall, "running": running]
            if let declared = declaredPlugins(p, home: home) { info["plugins"] = declared }
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
        /// Dernière sauvegarde réussie de l'outil (rempli par l'appelant, voir `lastBackup`).
        public var lastBackup: Date?

        /// Taille de ce qui sera sauvegardé : somme des catégories cochées.
        public func bytes(of categories: [String]) -> Int64 {
            Set(categories).reduce(Int64(0)) { $0 + (bytesByCategory[$1] ?? 0) }
        }
    }

    /// Dernière sauvegarde réussie d'un outil. Sur les destinations locales non chiffrées déjà accessibles
    /// (lecture seule, rien n'est monté), date de la dernière version dont le manifest contient `ai/<outil>/…` ;
    /// sinon, si l'outil est configuré, dernière réussite enregistrée (`RunState`) parmi les destinations.
    public static func lastBackup(toolID: String, config: CairnConfig, state: RunState,
                                  machine: String = BackupEngine.machineName()) -> Date? {
        let fm = FileManager.default
        var found: Date?
        for d in config.destinations where d.provider == .local && !d.encrypted {
            let path = ((d.path ?? "") as NSString).expandingTildeInPath
            guard !path.isEmpty, fm.fileExists(atPath: path) else { continue }
            let dir = BackupEngine.versionsDir(root: URL(fileURLWithPath: path), machine: machine)
            for v in BackupEngine.versions(in: dir).reversed() {
                guard let data = try? Data(contentsOf: dir.appendingPathComponent(v).appendingPathComponent("manifest.json")),
                      let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let parts = m["parts"] as? [[String: Any]],
                      parts.contains(where: { ($0["target"] as? String)?.hasPrefix("ai/\(toolID)/") ?? false }),
                      let date = BackupEngine.date(ofVersion: v) else { continue }
                found = max(found ?? date, date)
                break
            }
        }
        if let found { return found }
        guard config.ai.contains(where: { $0.id == toolID && !$0.categories.isEmpty }) else { return nil }
        return config.destinations.compactMap { state.destinations[$0.id]?.lastSuccess }.max()
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
